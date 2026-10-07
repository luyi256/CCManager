import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MAX_TEXT_BYTES,
  ProjectFileWatcher,
  listDirectory,
  normalizeRelativePath,
  readProjectFile,
  syncProjectFiles,
} from '../src/projectFiles.js';
import type { AgentConfig } from '../src/types.js';

function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'ccm-files-'));
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, 'secret'));
  mkdirSync(outside);
  writeFileSync(path.join(root, 'README.md'), '# Hello\n');
  writeFileSync(path.join(root, 'file10.txt'), 'ten');
  writeFileSync(path.join(root, 'file2.txt'), 'two');
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');
  writeFileSync(path.join(root, 'secret', 'key'), 'k');
  writeFileSync(path.join(outside, 'passwd'), 'root');
  symlinkSync(outside, path.join(root, 'escape'));
  symlinkSync(path.join(root, 'src'), path.join(root, 'src-link'));
  const config: AgentConfig = {
    agentId: 'a',
    agentName: 'a',
    dataPath: base,
    allowedPaths: [`${base}/*`],
    blockedPaths: [path.join(root, 'secret')],
  };
  return { base, root, config, request: { projectPath: root }, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('relative paths are normalized and may not climb out of the project', () => {
  assert.equal(normalizeRelativePath(''), '');
  assert.equal(normalizeRelativePath('./src//nested/'), 'src/nested');
  assert.equal(normalizeRelativePath('src/../README.md'), 'README.md');
  assert.throws(() => normalizeRelativePath('../outside'), /escapes/);
  assert.throws(() => normalizeRelativePath('/etc/passwd'), /relative/);
});

test('a listing puts folders first, sorts names naturally and hides VCS folders', async () => {
  const { config, request, cleanup } = fixture();
  try {
    const listing = await listDirectory(config, { ...request, path: '' });
    assert.deepEqual(listing.entries.map((entry) => `${entry.type}:${entry.name}`), [
      'dir:escape',
      'dir:secret',
      'dir:src',
      'dir:src-link',
      'file:file2.txt',
      'file:file10.txt',
      'file:README.md',
    ]);
    assert.equal(listing.entries.find((entry) => entry.name === 'src-link')?.symlink, true);
    const again = await listDirectory(config, { ...request, path: '' });
    assert.equal(again.etag, listing.etag);
  } finally {
    cleanup();
  }
});

test('symlinks that leave the project, blocked paths and traversal are refused', async () => {
  const { config, request, cleanup } = fixture();
  try {
    await assert.rejects(listDirectory(config, { ...request, path: 'escape' }), { code: 'denied' });
    await assert.rejects(readProjectFile(config, { ...request, path: 'escape/passwd' }), { code: 'denied' });
    await assert.rejects(listDirectory(config, { ...request, path: 'secret' }), { code: 'denied' });
    await assert.rejects(readProjectFile(config, { ...request, path: '../outside/passwd' }), { code: 'denied' });
    await assert.rejects(readProjectFile(config, { ...request, path: 'missing.txt' }), { code: 'not_found' });
    const inside = await listDirectory(config, { ...request, path: 'src-link' });
    assert.deepEqual(inside.entries.map((entry) => entry.name), ['nested', 'index.ts']);
  } finally {
    cleanup();
  }
});

test('a project outside the agent allow-list is refused', async () => {
  const { config, root, cleanup } = fixture();
  try {
    await assert.rejects(
      listDirectory({ ...config, allowedPaths: ['/nowhere/*'] }, { projectPath: root }),
      { code: 'denied' },
    );
  } finally {
    cleanup();
  }
});

test('files are previewed as text, image or binary and revalidated by etag', async () => {
  const { root, config, request, cleanup } = fixture();
  try {
    const text = await readProjectFile(config, { ...request, path: 'README.md' });
    assert.ok(!('notModified' in text) && text.kind === 'text');
    assert.equal(text.content, '# Hello\n');

    const unchanged = await readProjectFile(config, { ...request, path: 'README.md', etag: text.etag });
    assert.ok('notModified' in unchanged && unchanged.notModified);

    writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const image = await readProjectFile(config, { ...request, path: 'logo.png' });
    assert.ok(!('notModified' in image) && image.kind === 'image');
    assert.equal(image.mime, 'image/png');
    assert.equal(image.content, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));

    writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 0, 2, 3]));
    const binary = await readProjectFile(config, { ...request, path: 'blob.bin' });
    assert.ok(!('notModified' in binary) && binary.kind === 'binary');

    writeFileSync(path.join(root, 'big.log'), 'x'.repeat(MAX_TEXT_BYTES + 10));
    const big = await readProjectFile(config, { ...request, path: 'big.log' });
    assert.ok(!('notModified' in big) && big.kind === 'text');
    assert.equal(big.truncated, true);
    assert.equal(big.content.length, MAX_TEXT_BYTES);

    await assert.rejects(readProjectFile(config, { ...request, path: 'src' }), { code: 'not_a_file' });
  } finally {
    cleanup();
  }
});

test('sync returns only changed directories and reports the open file', async () => {
  const { root, config, request, cleanup } = fixture();
  try {
    const rootListing = await listDirectory(config, { ...request, path: '' });
    const srcListing = await listDirectory(config, { ...request, path: 'src' });
    const file = await readProjectFile(config, { ...request, path: 'src/index.ts' });

    const quiet = await syncProjectFiles(config, {
      ...request,
      dirs: [{ path: '', etag: rootListing.etag }, { path: 'src', etag: srcListing.etag }],
      file: { path: 'src/index.ts', etag: file.etag },
    });
    assert.deepEqual(quiet.changed, []);
    assert.deepEqual(quiet.missing, []);
    assert.deepEqual(quiet.file, { path: 'src/index.ts', changed: false });

    writeFileSync(path.join(root, 'src', 'added.ts'), '');
    writeFileSync(path.join(root, 'src', 'index.ts'), 'export const changed = true;\n');
    rmSync(path.join(root, 'src', 'nested'), { recursive: true });
    const after = await syncProjectFiles(config, {
      ...request,
      dirs: [{ path: '', etag: rootListing.etag }, { path: 'src', etag: srcListing.etag }, { path: 'src/nested' }],
      file: { path: 'src/index.ts', etag: file.etag },
    });
    assert.deepEqual(after.changed.map((listing) => listing.path), ['src']);
    assert.deepEqual(after.changed[0].entries.map((entry) => entry.name), ['added.ts', 'index.ts']);
    assert.deepEqual(after.missing, ['src/nested']);
    assert.equal(after.file?.changed, true);
  } finally {
    cleanup();
  }
});

test('the watcher reports changes in watched directories only', async () => {
  const { root, config, request, cleanup } = fixture();
  const events: string[][] = [];
  const watcher = new ProjectFileWatcher(config, (_projectId, dirs) => events.push(dirs));
  try {
    await watcher.set('p1', request, ['src']);
    writeFileSync(path.join(root, 'untracked.txt'), '');
    writeFileSync(path.join(root, 'src', 'new.ts'), '');
    const deadline = Date.now() + 3000;
    while (events.length === 0 && Date.now() < deadline) await delay(50);
    assert.deepEqual(events.flat(), ['src']);

    await watcher.set('p1', request, []);
    events.length = 0;
    writeFileSync(path.join(root, 'src', 'later.ts'), '');
    await delay(500);
    assert.deepEqual(events, []);
  } finally {
    watcher.clearAll();
    cleanup();
  }
});
