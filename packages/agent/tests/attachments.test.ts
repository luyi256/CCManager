import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { describeAttachedFiles, saveAttachedFiles, splitAttachments } from '../src/attachments.js';

function fileDataUrl(name: string, text: string, type = 'text/plain'): string {
  return `data:${type};name=${encodeURIComponent(name)};base64,${Buffer.from(text).toString('base64')}`;
}

test('separates unnamed images from named files', () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const { images, files } = splitAttachments([image, fileDataUrl('审稿意见.md', '# notes')]);
  assert.deepEqual(images, [image]);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, '审稿意见.md');
  assert.equal(files[0].data.toString(), '# notes');
});

test('file names cannot escape the attachments folder', () => {
  const { files } = splitAttachments([fileDataUrl('../../etc/passwd', 'x'), fileDataUrl('..', 'y')]);
  assert.deepEqual(files.map((file) => file.name), ['passwd', 'attachment']);
});

test('saving reuses identical files and renames different ones with the same name', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccm-attachments-'));
  const [first] = saveAttachedFiles(dir, splitAttachments([fileDataUrl('a.txt', 'one')]).files);
  const [same] = saveAttachedFiles(dir, splitAttachments([fileDataUrl('a.txt', 'one')]).files);
  const [other] = saveAttachedFiles(dir, splitAttachments([fileDataUrl('a.txt', 'two')]).files);
  assert.equal(same, first);
  assert.equal(path.basename(other), 'a-1.txt');
  assert.equal(readFileSync(other, 'utf8'), 'two');
  assert.match(describeAttachedFiles([first, other]), /attached 2 files[\s\S]*a-1\.txt/);
});
