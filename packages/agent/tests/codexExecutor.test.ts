import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCodexArgs } from '../src/codexExecutor.js';
import type { TaskRequest } from '../src/types.js';

function task(overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    taskId: 1,
    projectId: 'p1',
    projectPath: '/tmp/project',
    prompt: 'hello',
    isPlanMode: false,
    runner: 'tcodex',
    model: 'gpt-5.6-luna',
    ...overrides,
  };
}

test('places reasoning effort before the Codex exec subcommand', () => {
  assert.deepEqual(buildCodexArgs(task({ reasoningEffort: 'high' }), '/tmp/project'), [
    '--config',
    'model_reasoning_effort="high"',
    'exec',
    'hello',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C',
    '/tmp/project',
    '--model',
    'gpt-5.6-luna',
  ]);
});

test('keeps effort before exec when resuming a session', () => {
  const args = buildCodexArgs(task({
    reasoningEffort: 'max',
    continueSession: true,
    sessionId: 'session-123',
  }), '/tmp/project', ['--image', '/tmp/image.png']);
  assert.deepEqual(args.slice(0, 5), [
    '--config',
    'model_reasoning_effort="max"',
    'exec',
    'resume',
    'session-123',
  ]);
  assert.ok(args.includes('/tmp/image.png'));
});
