import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRunnerCatalog,
  capabilityCacheTtl,
  parseClaudeHelpModels,
  parseClaudeGrokSettings,
  parseCodexCatalog,
  parseTClaudeAvailableModels,
  resolveClaudeGrokModel,
} from '../src/runnerModels.js';

test('never caches transient probe failures or empty catalogs', () => {
  // Caching a timeout as an empty catalog made the manager reject the user's
  // model for the whole TTL, taking their uploaded images down with it.
  assert.equal(capabilityCacheTtl({ kind: 'transient', message: 'ETIMEDOUT' }), null);
  assert.equal(capabilityCacheTtl({ kind: 'models', models: [] }), null);
  assert.equal(capabilityCacheTtl({ kind: 'models', models: ['gpt-5.6-sol'] }), 30 * 60 * 1000);
  assert.equal(capabilityCacheTtl({ kind: 'missing' }), 5 * 60 * 1000);
});

test('keeps a runner selectable when its catalog could not be read', () => {
  assert.deepEqual(buildRunnerCatalog('tcodex', { kind: 'transient', message: 'ETIMEDOUT' }), {
    installed: true,
    models: [],
  });
});

test('names the actual missing command instead of a hard-coded wrapper', () => {
  assert.match(buildRunnerCatalog('qwen', { kind: 'missing' }).message || '', /qwen/);
  assert.doesNotMatch(buildRunnerCatalog('qwen', { kind: 'missing' }).message || '', /claude-grok/);
});

test('filters Codex catalog entries to selectable API-supported models', () => {
  const raw = JSON.stringify({
    models: [
      { slug: 'gpt-visible', visibility: 'list', supported_in_api: true },
      { slug: 'gpt-hidden', visibility: 'hide', supported_in_api: true },
      { slug: 'gpt-no-api', visibility: 'list', supported_in_api: false },
    ],
  });

  assert.deepEqual(parseCodexCatalog(raw), ['gpt-visible']);
});

test('reads selectable Claude aliases from the local Grok router settings', () => {
  const settings = {
    modelOverrides: {
      'claude-opus-5': 'distill-grok/api_xai_grok-4.6',
      'claude-opus-5[1m]': 'distill-grok/api_xai_grok-4.6',
      'claude-sonnet-5': 'distill-grok/api_xai_grok-4.6',
      'claude-haiku-5': 'distill-grok/xai/grok-code-fast-1',
    },
  };
  assert.deepEqual(parseClaudeGrokSettings(settings), [
    'grok-4.6',
    'grok-code-fast-1',
  ]);
  assert.equal(
    resolveClaudeGrokModel('grok-4.6', settings),
    'claude-opus-5[1m]'
  );
  assert.equal(
    resolveClaudeGrokModel('distill-grok/api_xai_grok-4.6', settings),
    'claude-opus-5[1m]'
  );
  assert.equal(
    resolveClaudeGrokModel('claude-opus-5', settings),
    'claude-opus-5'
  );
});

test('extracts only aliases documented in the Claude --model help block', () => {
  const help = [
    'Options:',
    '  --model <model>  Model for the current session. Provide',
    "                   an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')",
    "                   or a model's full name (e.g. 'claude-fable-5').",
    '  --name <name>    Session name',
  ].join('\n');

  assert.deepEqual(
    parseClaudeHelpModels(help, ['claude-opus-5']),
    ['claude-opus-5', 'fable', 'opus', 'sonnet', 'claude-fable-5']
  );
});

test('extracts tClaude model validation output without hard-coded slugs', () => {
  const output = [
    '[tclaude] model "__probe__" is not available.',
    'Available models: claude-sonnet-4-6, claude-opus-4-8[1m], claude-hy3-preview',
  ].join('\n');

  assert.deepEqual(parseTClaudeAvailableModels(output), [
    'claude-sonnet-4-6',
    'claude-opus-4-8[1m]',
    'claude-hy3-preview',
  ]);
});
