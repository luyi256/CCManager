import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FileWatchRegistry } from './fileWatch.js';

test('the agent watches the union of directories expanded by every viewer of a project', () => {
  const registry = new FileWatchRegistry();
  assert.deepEqual(registry.set('s1', 'p1', ['', 'src']), ['p1']);
  registry.set('s2', 'p1', ['src', 'docs']);
  registry.set('s3', 'p2', ['']);
  assert.deepEqual(registry.dirsFor('p1').sort(), ['', 'docs', 'src']);
  assert.deepEqual(registry.subscribers('p1').sort(), ['s1', 's2']);
  assert.deepEqual(registry.projects().sort(), ['p1', 'p2']);
});

test('switching or closing a viewer updates the affected projects', () => {
  const registry = new FileWatchRegistry();
  registry.set('s1', 'p1', ['src']);
  assert.deepEqual(registry.set('s1', 'p2', ['lib']), ['p1', 'p2']);
  assert.deepEqual(registry.dirsFor('p1'), []);
  assert.equal(registry.remove('s1'), 'p2');
  assert.deepEqual(registry.dirsFor('p2'), []);
  assert.equal(registry.remove('s1'), undefined);
});