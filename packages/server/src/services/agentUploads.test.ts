import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeAgentUpload, expectAgentUpload } from './agentUploads.js';

test('an agent upload resolves only the matching agent request, once', async () => {
  const upload = expectAgentUpload('agent-a');
  assert.equal(completeAgentUpload(upload.id, 'agent-b', { ok: true }), false);
  assert.equal(completeAgentUpload(upload.id, 'agent-a', { ok: true, entries: [1] }), true);
  assert.deepEqual(await upload.promise, { ok: true, entries: [1] });
  assert.equal(completeAgentUpload(upload.id, 'agent-a', { ok: true }), false);
});

test('a cancelled request no longer accepts an upload', () => {
  const upload = expectAgentUpload('agent-a');
  upload.cancel();
  assert.equal(completeAgentUpload(upload.id, 'agent-a', { ok: true }), false);
});
