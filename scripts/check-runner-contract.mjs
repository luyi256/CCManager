#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const expected = ['claude', 'claude-grok', 'codex', 'cursor', 'qwen', 'tclaude', 'tcodex'];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function quotedValues(source) {
  return Array.from(source.matchAll(/['"]([a-z][a-z0-9-]*)['"]/g), (match) => match[1]);
}

function runnerUnion(relativePath) {
  const source = read(relativePath);
  const match = source.match(/export type Runner\s*=\s*([^;]+);/);
  if (!match) throw new Error(`${relativePath}: Runner union not found`);
  return quotedValues(match[1]);
}

function setValues(relativePath, name) {
  const source = read(relativePath);
  const match = source.match(new RegExp(`${name}[^=]*=\\s*new Set<Runner>\\(\\[([^\\]]+)\\]\\)`));
  if (!match) throw new Error(`${relativePath}: ${name} not found`);
  return quotedValues(match[1]);
}

function recordKeys(relativePath, name) {
  const source = read(relativePath);
  const match = source.match(new RegExp(`${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  if (!match) throw new Error(`${relativePath}: ${name} not found`);
  return Array.from(match[1].matchAll(/^\s*(?:'([^']+)'|"([^"]+)"|([a-z][a-z0-9-]*))\s*:/gm),
    (entry) => entry[1] || entry[2] || entry[3]);
}

function uiRunnerIds() {
  const source = read('packages/web/src/components/Conversation/ModelSwitcher.tsx');
  const match = source.match(/const RUNNERS[\s\S]*?=\s*\[([\s\S]*?)\n\];/);
  if (!match) throw new Error('ModelSwitcher.tsx: RUNNERS not found');
  return Array.from(match[1].matchAll(/id:\s*'([^']+)'/g), (entry) => entry[1]);
}

function assertSame(label, actual) {
  const unique = Array.from(new Set(actual));
  const missing = expected.filter((runner) => !unique.includes(runner));
  const extra = unique.filter((runner) => !expected.includes(runner));
  if (missing.length || extra.length || unique.length !== expected.length) {
    throw new Error(
      `${label} is out of sync. missing=[${missing.join(', ')}], extra=[${extra.join(', ')}], ` +
      `actual=[${unique.join(', ')}]`,
    );
  }
}

const contracts = [
  ['agent Runner type', runnerUnion('packages/agent/src/runnerModels.ts')],
  ['server Runner type', runnerUnion('packages/server/src/types/index.ts')],
  ['web Runner type', runnerUnion('packages/web/src/types/index.ts')],
  ['agent model probes', recordKeys('packages/agent/src/runnerModels.ts', 'RUNNER_COMMANDS')],
  ['server model route', setValues('packages/server/src/routes/agents.ts', 'VALID_MODEL_RUNNERS')],
  ['server task route', setValues('packages/server/src/routes/tasks.ts', 'VALID_RUNNERS')],
  ['server session route', setValues('packages/server/src/routes/sessions.ts', 'VALID_RUNNERS')],
  ['web model switcher', uiRunnerIds()],
  ['web session labels', recordKeys('packages/web/src/components/Session/SessionBrowser.tsx', 'RUNNER_LABELS')],
];

for (const [label, values] of contracts) assertSame(label, values);
console.log(`Runner contract OK: ${expected.join(', ')}`);
