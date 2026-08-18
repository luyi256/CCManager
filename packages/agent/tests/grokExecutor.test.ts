import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildClaudeEnvironment,
  resolveClaudeModel,
} from '../src/executor.js';

test('isolates xAI credentials from normal Claude credentials', () => {
  const env = buildClaudeEnvironment({
    ANTHROPIC_API_KEY: 'anthropic-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    CLAUDECODE: '1',
    PATH: '/usr/bin',
  }, 'grok', {
    apiKey: 'xai-key',
    baseUrl: 'https://gateway.example',
  });

  assert.equal(env.ANTHROPIC_BASE_URL, 'https://gateway.example');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'xai-key');
  assert.equal(env.ANTHROPIC_API_KEY, '');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.PATH, '/usr/bin');
});

test('requires an xAI API key for Claude Grok', () => {
  assert.throws(
    () => buildClaudeEnvironment({}, 'grok'),
    /requires XAI_API_KEY/
  );
});

test('uses configured Grok model and falls back to grok-4.6', () => {
  assert.equal(resolveClaudeModel('grok-custom', 'grok'), 'grok-custom');
  assert.equal(
    resolveClaudeModel(undefined, 'grok', { defaultModel: 'grok-code-fast-1' }),
    'grok-code-fast-1'
  );

  const previous = process.env.XAI_DEFAULT_MODEL;
  delete process.env.XAI_DEFAULT_MODEL;
  try {
    assert.equal(resolveClaudeModel(undefined, 'grok'), 'grok-4.6');
  } finally {
    if (previous === undefined) delete process.env.XAI_DEFAULT_MODEL;
    else process.env.XAI_DEFAULT_MODEL = previous;
  }
});
