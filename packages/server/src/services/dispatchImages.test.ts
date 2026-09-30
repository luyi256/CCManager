import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getStagedDispatchImages, stageDispatchImages } from './dispatchImages.js';

test('staged dispatch images are only readable by the agent they were staged for', () => {
  const id = stageDispatchImages('agent-a', 1, ['data:image/png;base64,AAAA']);
  assert.deepEqual(getStagedDispatchImages(id, 'agent-a'), ['data:image/png;base64,AAAA']);
  assert.deepEqual(getStagedDispatchImages(id, 'agent-a'), ['data:image/png;base64,AAAA'], 'a retry can download again');
  assert.equal(getStagedDispatchImages(id, 'agent-b'), null);
  assert.equal(getStagedDispatchImages('missing', 'agent-a'), null);
});

test('a newer dispatch of the same task replaces its staged images', () => {
  const older = stageDispatchImages('agent-a', 2, ['old']);
  const newer = stageDispatchImages('agent-a', 2, ['new']);
  assert.equal(getStagedDispatchImages(older, 'agent-a'), null);
  assert.deepEqual(getStagedDispatchImages(newer, 'agent-a'), ['new']);
});
