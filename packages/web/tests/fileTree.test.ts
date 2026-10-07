import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ancestorDirs, fileIconKind, isSameOrDescendant, joinPath, pruneExpanded } from '../src/utils/fileTree.ts';

test('paths are joined relative to the project root', () => {
  assert.equal(joinPath('', 'src'), 'src');
  assert.equal(joinPath('src', 'index.ts'), 'src/index.ts');
});

test('descendant checks do not match sibling prefixes', () => {
  assert.equal(isSameOrDescendant('src/a', 'src'), true);
  assert.equal(isSameOrDescendant('src', 'src'), true);
  assert.equal(isSameOrDescendant('src-old/a', 'src'), false);
  assert.equal(isSameOrDescendant('anything', ''), true);
});

test('a removed folder collapses itself and everything below it', () => {
  assert.deepEqual(
    pruneExpanded(['src', 'src/a', 'src/a/b', 'src-old', 'docs'], ['src/a']),
    ['src', 'src-old', 'docs'],
  );
  assert.deepEqual(pruneExpanded(['src'], ['']), ['src']);
});

test('ancestors of a file are the folders to expand to reveal it', () => {
  assert.deepEqual(ancestorDirs('src/a/b.ts'), ['src', 'src/a']);
  assert.deepEqual(ancestorDirs('README.md'), []);
});

test('file icons follow the extension', () => {
  assert.equal(fileIconKind('index.tsx'), 'code');
  assert.equal(fileIconKind('logo.SVG'), 'image');
  assert.equal(fileIconKind('README.md'), 'text');
  assert.equal(fileIconKind('Makefile'), 'other');
});
