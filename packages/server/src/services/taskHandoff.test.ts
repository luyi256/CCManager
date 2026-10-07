import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoredTaskLog } from './storage.js';
import { buildHandoffPrompt, conversationTurns, HANDOFF_CONTEXT_PREFIX, renderTranscript } from './taskHandoff.js';

function log(id: number, type: string, content: unknown): StoredTaskLog {
  return { id, timestamp: '2026-10-07 03:00:00', type, content };
}

test('a handoff prompt leads with the new message and carries the conversation without tool calls', () => {
  const prompt = buildHandoffPrompt(
    { id: 274, prompt: 'Fix the session list', runner: 'tcodex', model: 'gpt-6-astra' },
    [
      log(1, 'output', 'Looking at '),
      log(2, 'output', 'sessions.ts.'),
      log(3, 'tool_use', { id: 't1', name: 'Shell', input: { command: 'rg secret-tool-input' } }),
      log(4, 'user_message', { text: 'Also check Cursor', attachmentIds: [] }),
      log(5, 'output', 'Cursor is fine.'),
    ],
    'Please continue with opus',
  );

  assert.ok(prompt.startsWith('Please continue with opus\n'));
  assert.ok(prompt.includes(`${HANDOFF_CONTEXT_PREFIX}274, which ran on tCodex (gpt-6-astra).`));
  assert.ok(prompt.includes(
    '[User]\nFix the session list\n\n[Assistant]\nLooking at sessions.ts.\n\n[User]\nAlso check Cursor\n\n[Assistant]\nCursor is fine.',
  ));
  assert.ok(!prompt.includes('secret-tool-input'));
});

test('a long conversation keeps the first request and the latest turns', () => {
  const logs = Array.from({ length: 40 }, (_, index) => log(index, index % 2 ? 'output' : 'user_message', `turn ${index} ${'x'.repeat(200)}`));
  const transcript = renderTranscript(conversationTurns({ prompt: 'original request' }, logs), 2_000);

  assert.ok(transcript.length <= 2_000);
  assert.ok(transcript.startsWith('[User]\noriginal request\n\n[... '));
  assert.match(transcript, /earlier messages omitted/);
  assert.ok(transcript.includes('turn 39 '));
  assert.ok(!transcript.includes('turn 0 '));
});
