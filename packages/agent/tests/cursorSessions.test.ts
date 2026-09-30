import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  getCursorSessionDetail,
  listCursorSessions,
  searchCursorSessions,
} from '../src/cursorSessions.js';

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

describe('Cursor history browsing', () => {
  it('reads Cursor IDE transcripts through an equivalent project symlink', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'ccm-cursor-history-'));
    const realProject = join(homeDir, 'projects', 'video_reward');
    const aliasProject = join(homeDir, 'video_reward-link');
    await mkdir(realProject, { recursive: true });
    await symlink(realProject, aliasProject);

    const storeName = realProject.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+|-+$/g, '');
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const transcript = join(
      homeDir,
      '.cursor',
      'projects',
      storeName,
      'agent-transcripts',
      sessionId,
      `${sessionId}.jsonl`,
    );
    await writeJsonl(transcript, [
      {
        role: 'user',
        message: {
          content: [{
            type: 'text',
            text: '<timestamp>Wednesday, Sep 30, 2026</timestamp>\n<user_query>Cursor prompt</user_query>',
          }],
        },
      },
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Cursor answer' },
            { type: 'tool_use', name: 'Shell', input: { command: 'pwd' } },
          ],
        },
      },
      { type: 'turn_ended', status: 'success' },
    ]);
    const chatMeta = join(homeDir, '.cursor', 'chats', 'workspace', sessionId, 'meta.json');
    await mkdir(join(chatMeta, '..'), { recursive: true });
    await writeFile(chatMeta, JSON.stringify({
      title: 'Cursor title',
      cwd: realProject,
      createdAtMs: 1_790_000_000_000,
      updatedAtMs: 1_790_000_001_000,
    }));

    const sessions = await listCursorSessions(aliasProject, false, { homeDir });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].runner, 'cursor');
    assert.equal(sessions[0].title, 'Cursor title');
    assert.equal(sessions[0].firstPrompt, 'Cursor prompt');

    const detail = await getCursorSessionDetail(aliasProject, sessionId, { homeDir });
    assert.ok(detail?.some((entry) => entry.type === 'output' && entry.content === 'Cursor answer'));
    assert.ok(detail?.some((entry) => entry.type === 'tool_use' && entry.toolName === 'Shell'));

    const search = await searchCursorSessions(aliasProject, 'Cursor prompt', { homeDir });
    assert.equal(search.length, 1);
    assert.equal(search[0].sessionId, sessionId);
  });
});
