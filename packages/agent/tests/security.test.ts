import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePath } from '../src/security.js';
import type { AgentConfig } from '../src/types.js';

function config(allowedPaths: string[], blockedPaths?: string[]): AgentConfig {
  return { agentId: 'a', agentName: 'a', dataPath: '/tmp', allowedPaths, blockedPaths };
}

test('/* allows any absolute path but still honours blocked paths', () => {
  const rootConfig = config(['/*'], ['/home/u/.ssh']);
  assert.doesNotThrow(() => validatePath('/apdcephfs/project-that-does-not-exist', rootConfig));
  assert.doesNotThrow(() => validatePath('/home/u/project-that-does-not-exist', rootConfig));
  assert.throws(() => validatePath('/home/u/.ssh/keys', rootConfig), /blocked/);
});

test('/base/* matches the base and its descendants only', () => {
  const homeConfig = config(['/home/u/*']);
  assert.doesNotThrow(() => validatePath('/home/u', homeConfig));
  assert.doesNotThrow(() => validatePath('/home/u/project', homeConfig));
  assert.throws(() => validatePath('/home/user2/project', homeConfig), /not in allowed list/);
  assert.throws(() => validatePath('/apdcephfs/project', homeConfig), /not in allowed list/);
});
