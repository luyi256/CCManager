import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getRunnerModelCatalog, validateRunnerSelection } from './runnerModels.js';

test('parses an installed runner catalog from agent capabilities', () => {
  const capabilities = [
    'no-gpu',
    'models:codex:{"installed":true,"models":["gpt-5.6-sol","gpt-5.5"]}',
  ];

  assert.deepEqual(getRunnerModelCatalog(capabilities, 'codex'), {
    installed: true,
    models: ['gpt-5.6-sol', 'gpt-5.5'],
  });
  assert.deepEqual(validateRunnerSelection(capabilities, 'codex', 'gpt-5.6-sol'), {
    model: 'gpt-5.6-sol',
  });
});

test('rejects missing CLIs and unsupported models while keeping old agents compatible', () => {
  const capabilities = [
    'models:qwen:{"installed":false,"models":[]}',
    'models:tcodex:{"installed":true,"models":["gpt-5.6-terra"]}',
  ];

  assert.match(validateRunnerSelection(capabilities, 'qwen', undefined).error || '', /not installed/);
  assert.deepEqual(validateRunnerSelection(capabilities, 'claude', undefined), {});
  assert.match(validateRunnerSelection(capabilities, 'tcodex', 'gpt-5-codex').error || '', /not supported/);
});

test('accepts a supported runner default without inventing a model name', () => {
  const capabilities = ['models:tclaude:{"installed":true,"models":[]}'];
  assert.deepEqual(validateRunnerSelection(capabilities, 'tclaude', undefined), {});
});

test('preserves provider setup guidance for unavailable Claude Grok', () => {
  const capabilities = [
    'models:claude-grok:{"installed":false,"models":[],"message":"Set XAI_API_KEY"}',
  ];
  assert.deepEqual(getRunnerModelCatalog(capabilities, 'claude-grok'), {
    installed: false,
    models: [],
    message: 'Set XAI_API_KEY',
  });
  assert.match(
    validateRunnerSelection(capabilities, 'claude-grok', 'grok-4.6').error || '',
    /Set XAI_API_KEY/
  );
});
