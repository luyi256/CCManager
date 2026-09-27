import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCursorImage, selectCursorModel } from '../src/cursorExecutor.js';

test('converts CCManager data URLs to Cursor SDK image inputs', () => {
  assert.deepEqual(
    parseCursorImage('data:image/png;base64,iVBORw0KGgo='),
    { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
  );
  assert.equal(parseCursorImage('data:image/svg+xml;base64,PHN2Zz4='), null);
});

test('uses an explicitly requested Cursor model', () => {
  assert.deepEqual(selectCursorModel([], 'composer-2.5'), { id: 'composer-2.5' });
});

test('avoids Cursor Router as the implicit default when another model exists', () => {
  assert.deepEqual(selectCursorModel([
    { id: 'auto-smart', displayName: 'Cursor Router' },
    { id: 'composer-2.5', displayName: 'Composer 2.5' },
  ], undefined), { id: 'composer-2.5' });
});

test('uses the default variant parameters when Router is the only model', () => {
  assert.deepEqual(selectCursorModel([{
    id: 'auto-smart',
    displayName: 'Cursor Router',
    variants: [{
      displayName: 'Balanced',
      isDefault: true,
      params: [{ id: 'optimize_for', value: 'balanced' }],
    }],
  }], undefined), {
    id: 'auto-smart',
    params: [{ id: 'optimize_for', value: 'balanced' }],
  });
});
