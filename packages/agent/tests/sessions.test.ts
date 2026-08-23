import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { getSessionDetail, listSessions, searchSessions } from '../src/sessions.js';

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

describe('multi-runner session browsing', () => {
  it('discovers and parses Claude, tClaude, Codex, tCodex, Qwen, and Docker Claude sessions', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'ccm-sessions-'));
    const projectPath = '/workspace/demo-project';
    const projectHash = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const timestamp = '2026-08-23T12:00:00.000Z';

    await writeJsonl(join(homeDir, '.claude', 'projects', projectHash, '11111111-1111-4111-8111-111111111111.jsonl'), [
      {
        type: 'user',
        sessionId: '11111111-1111-4111-8111-111111111111',
        timestamp,
        cwd: projectPath,
        gitBranch: 'main',
        message: { content: 'Claude prompt' },
      },
      {
        type: 'assistant',
        sessionId: '11111111-1111-4111-8111-111111111111',
        timestamp,
        cwd: projectPath,
        message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'Claude answer' }] },
      },
    ]);

    await writeJsonl(join(homeDir, '.claude', 'projects', projectHash, '22222222-2222-4222-8222-222222222222.jsonl'), [
      {
        type: 'user',
        sessionId: '22222222-2222-4222-8222-222222222222',
        timestamp,
        cwd: projectPath,
        message: { content: 'Grok prompt' },
      },
      {
        type: 'assistant',
        sessionId: '22222222-2222-4222-8222-222222222222',
        timestamp,
        cwd: projectPath,
        message: { model: 'distill-grok/api_xai_grok-4.6', content: [{ type: 'text', text: 'Grok answer' }] },
      },
    ]);

    await writeJsonl(join(homeDir, '.tclaude', 'projects', projectHash, '33333333-3333-4333-8333-333333333333.jsonl'), [
      {
        type: 'user',
        sessionId: '33333333-3333-4333-8333-333333333333',
        timestamp,
        cwd: projectPath,
        message: { content: 'tClaude prompt' },
      },
      {
        type: 'assistant',
        sessionId: '33333333-3333-4333-8333-333333333333',
        timestamp,
        cwd: projectPath,
        message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'tClaude answer' }] },
      },
    ]);

    const codexRecords = (sessionId: string, prompt: string, answer: string) => [
      {
        type: 'session_meta',
        timestamp,
        payload: { session_id: sessionId, cwd: projectPath, git: { branch: 'main' } },
      },
      { type: 'turn_context', timestamp, payload: { model: 'gpt-test' } },
      { type: 'event_msg', timestamp, payload: { type: 'user_message', message: prompt } },
      {
        type: 'response_item',
        timestamp,
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: answer }],
        },
      },
    ];
    await writeJsonl(join(homeDir, '.codex', 'sessions', '2026', '08', '23', 'rollout-codex.jsonl'),
      codexRecords('44444444-4444-4444-8444-444444444444', 'Codex prompt', 'Codex answer'));
    await writeJsonl(join(homeDir, '.tcodex', 'sessions', '2026', '08', '23', 'rollout-tcodex.jsonl'),
      codexRecords('55555555-5555-4555-8555-555555555555', 'tCodex prompt', 'tCodex answer'));

    await writeJsonl(join(homeDir, '.qwen', 'projects', projectHash, 'chats', '66666666-6666-4666-8666-666666666666.jsonl'), [
      {
        uuid: 'qwen-user',
        parentUuid: null,
        sessionId: '66666666-6666-4666-8666-666666666666',
        timestamp,
        type: 'user',
        cwd: projectPath,
        gitBranch: 'main',
        version: 'test',
        message: { role: 'user', parts: [{ text: 'Qwen prompt' }] },
      },
      {
        uuid: 'qwen-assistant',
        parentUuid: 'qwen-user',
        sessionId: '66666666-6666-4666-8666-666666666666',
        timestamp,
        type: 'assistant',
        cwd: projectPath,
        version: 'test',
        model: 'qwen-test',
        message: { role: 'model', parts: [{ text: 'Qwen answer' }] },
      },
    ]);

    const dockerSessionsDir = join(homeDir, 'docker-sessions');
    await writeJsonl(join(
      dockerSessionsDir,
      'project-1',
      '.claude',
      'projects',
      '-workspace',
      '77777777-7777-4777-8777-777777777777.jsonl',
    ), [
      {
        type: 'user',
        sessionId: '77777777-7777-4777-8777-777777777777',
        timestamp,
        cwd: '/workspace',
        message: { content: 'Docker prompt' },
      },
      {
        type: 'assistant',
        sessionId: '77777777-7777-4777-8777-777777777777',
        timestamp,
        cwd: '/workspace',
        message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'Docker answer' }] },
      },
    ]);

    const options = { homeDir, projectId: 'project-1', dockerSessionsDir };
    const sessions = await listSessions(projectPath, options);
    assert.deepEqual(
      new Set(sessions.map((session) => session.runner)),
      new Set(['claude', 'claude-grok', 'tclaude', 'codex', 'tcodex', 'qwen']),
    );
    assert.equal(sessions.find((session) => session.runner === 'claude-grok')?.model, 'grok-4.6');
    assert.ok(sessions.some((session) => session.firstPrompt === 'Docker prompt'));

    const detail = await getSessionDetail(
      projectPath,
      'tcodex',
      '55555555-5555-4555-8555-555555555555',
      undefined,
      options,
    );
    assert.ok(detail?.some((entry) => entry.type === 'user_message' && entry.content === 'tCodex prompt'));
    assert.ok(detail?.some((entry) => entry.type === 'output' && entry.content === 'tCodex answer'));

    const search = await searchSessions(projectPath, 'Qwen prompt', options);
    assert.equal(search.length, 1);
    assert.equal(search[0].runner, 'qwen');
  });
});
