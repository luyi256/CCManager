import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPathAllowed } from './pathValidation.js';

test('/* allows any absolute path', () => {
  assert.equal(isPathAllowed('/apdcephfs/private/CCManager', ['/*']), true);
  assert.equal(isPathAllowed('/', ['/*']), true);
});

test('/base/* matches the base and its descendants only', () => {
  assert.equal(isPathAllowed('/home/u', ['/home/u/*']), true);
  assert.equal(isPathAllowed('/home/u/project', ['/home/u/*']), true);
  assert.equal(isPathAllowed('/home/user2/project', ['/home/u/*']), false);
  assert.equal(isPathAllowed('/home/u/project', ['/home/u/project']), true);
  assert.equal(isPathAllowed('/home/u/project-2', ['/home/u/project']), false);
});
