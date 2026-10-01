import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeSessionDetailUpload, expectSessionDetailUpload } from './sessionDetailUploads.js';

test('a session detail upload resolves only the matching agent request, once', async () => {
  const upload = expectSessionDetailUpload('agent-a');
  assert.equal(completeSessionDetailUpload(upload.id, 'agent-b', { ok: true }), false);
  assert.equal(completeSessionDetailUpload(upload.id, 'agent-a', { ok: true, entries: [1] }), true);
  assert.deepEqual(await upload.promise, { ok: true, entries: [1] });
  assert.equal(completeSessionDetailUpload(upload.id, 'agent-a', { ok: true }), false);
});

test('a cancelled request no longer accepts an upload', () => {
  const upload = expectSessionDetailUpload('agent-a');
  upload.cancel();
  assert.equal(completeSessionDetailUpload(upload.id, 'agent-a', { ok: true }), false);
});
