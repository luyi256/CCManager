import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SessionListItem } from './sessionBrowser.js';

process.env.DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-session-browser-'));
const { mergeSessions } = await import('./sessionBrowser.js');

function session(runner: SessionListItem['runner'], sessionId: string, minute: number): SessionListItem {
  return {
    sessionId,
    runner,
    title: 'hi',
    firstPrompt: 'hi',
    lastModified: new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString(),
    fileSize: 1,
  };
}

test('only Claude-format continuation chains are merged by title', () => {
  const merged = mergeSessions([
    session('claude', 'claude-a', 1),
    session('claude', 'claude-b', 2),
    session('tcodex', 'tcodex-a', 3),
    session('tcodex', 'tcodex-b', 4),
    session('cursor', 'cursor-a', 5),
    session('cursor', 'cursor-b', 6),
  ]);

  assert.deepEqual(
    merged.map((item) => [item.runner, item.sessionId, item.relatedSessionIds]),
    [
      ['cursor', 'cursor-b', undefined],
      ['cursor', 'cursor-a', undefined],
      ['tcodex', 'tcodex-b', undefined],
      ['tcodex', 'tcodex-a', undefined],
      ['claude', 'claude-b', ['claude-a', 'claude-b']],
    ],
  );
});
