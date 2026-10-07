import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codexEnv, scrubParentSessionEnv } from '../src/runnerEnv.js';

test('upstream Codex does not inherit the tCodex home', () => {
  const inherited = { CODEX_HOME: join(homedir(), '.tcodex'), CODEX_DISTILL_KEY: 'key' };
  assert.equal(codexEnv('codex', inherited).CODEX_HOME, join(homedir(), '.codex'));
  assert.equal(codexEnv('codex', inherited).CODEX_DISTILL_KEY, 'key');
  assert.equal(codexEnv('tcodex', inherited).CODEX_HOME, join(homedir(), '.tcodex'));
  assert.equal(inherited.CODEX_HOME, join(homedir(), '.tcodex'), 'the base env is not mutated');
});

test('a deliberately configured Codex home is kept', () => {
  assert.equal(codexEnv('codex', { CODEX_HOME: '/opt/codex-home' }).CODEX_HOME, '/opt/codex-home');
  assert.equal(codexEnv('codex', {}).CODEX_HOME, undefined);
});

test('variables of a parent coding session are removed', () => {
  const env: NodeJS.ProcessEnv = {
    CODEX_THREAD_ID: 'thread',
    CODEX_SANDBOX_NETWORK_DISABLED: '1',
    CURSOR_CONVERSATION_ID: 'conversation',
    CLAUDECODE: '1',
    CODEX_HOME: '/opt/codex-home',
    PATH: '/usr/bin',
  };
  assert.deepEqual(scrubParentSessionEnv(env).sort(), [
    'CLAUDECODE',
    'CODEX_SANDBOX_NETWORK_DISABLED',
    'CODEX_THREAD_ID',
    'CURSOR_CONVERSATION_ID',
  ]);
  assert.deepEqual(env, { CODEX_HOME: '/opt/codex-home', PATH: '/usr/bin' });
});
