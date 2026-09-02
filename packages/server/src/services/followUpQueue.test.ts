import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// database.ts opens its file at import time, so point it at a scratch dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-followup-'));
process.env.DATA_PATH = dataDir;

const { db } = await import('./database.js');
const { enqueue, peekAll, removeByIds, queueSize, hasQueued } = await import('./followUpQueue.js');
const {
  replaceTaskImages,
  getTaskImages,
  listTaskAttachments,
  getAttachmentForTask,
  activateAttachments,
  pruneStaleAttachments,
} = await import('./taskAttachments.js');
const { drainFollowUps } = await import('./followUpDispatch.js');

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD';

// validateTaskImages re-encodes to canonical base64, so compare against the
// stored form rather than the literal above.
function canonical(dataUrl: string): string {
  const [header, payload] = dataUrl.split(',');
  return `${header},${Buffer.from(payload, 'base64').toString('base64')}`;
}

function seedTask(taskId: number): void {
  db.prepare(`INSERT OR IGNORE INTO agents (id, name) VALUES ('a1', 'a1')`).run();
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, project_path, agent_id) VALUES ('p1', 'p1', '/tmp/p1', 'a1')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, prompt) VALUES (?, 'p1', 'seed')`).run(taskId);
}

test('peekAll reads queued follow-ups without consuming them', () => {
  // The old destructive dequeue deleted rows before checking whether a dispatch
  // was even possible, which silently discarded the user's images.
  const taskId = 9001;
  seedTask(taskId);
  enqueue(taskId, 'first', ['data:image/png;base64,AAAA'], 'tcodex', 'gpt-5.6-sol');
  enqueue(taskId, 'second');

  const first = peekAll(taskId);
  const second = peekAll(taskId);

  assert.equal(first.length, 2);
  assert.deepEqual(second.map((m) => m.prompt), ['first', 'second']);
  assert.equal(queueSize(taskId), 2, 'peeking must not drain the queue');
  assert.deepEqual(first[0].images, ['data:image/png;base64,AAAA']);
  assert.equal(first[0].runner, 'tcodex');
  assert.equal(first[1].images, undefined);
});

test('removeByIds deletes exactly the rows that were dispatched', () => {
  const taskId = 9002;
  seedTask(taskId);
  enqueue(taskId, 'keep-me');
  enqueue(taskId, 'dispatch-me');

  const queued = peekAll(taskId);
  const dispatched = queued.filter((m) => m.prompt === 'dispatch-me');
  removeByIds(dispatched.map((m) => m.id));

  assert.deepEqual(peekAll(taskId).map((m) => m.prompt), ['keep-me']);
  assert.equal(hasQueued(taskId), true);

  removeByIds(peekAll(taskId).map((m) => m.id));
  assert.equal(hasQueued(taskId), false);
});

test('removeByIds tolerates an empty list', () => {
  assert.doesNotThrow(() => removeByIds([]));
});

test('a new attachment generation keeps earlier messages viewable', () => {
  // Attachments used to be hard-deleted on every follow-up, so previous
  // messages lost their images and the timeline had nothing left to show.
  const taskId = 9003;
  seedTask(taskId);
  const first = replaceTaskImages(taskId, [png], 11);
  const second = replaceTaskImages(taskId, [jpeg], 22);

  assert.deepEqual(getTaskImages(taskId), [canonical(jpeg)], 'only the newest set dispatches');
  const all = listTaskAttachments(taskId);
  assert.equal(all.length, 2, 'the older generation is retained');
  assert.deepEqual(all.map((a) => a.position), [0, 1], 'positions append, never collide');
  assert.deepEqual(all.map((a) => a.logId), [11, 22]);
  assert.equal(first.ids.length, 1);
  assert.equal(second.ids.length, 1);
});

test('queued attachments stay inactive until their drain activates them', () => {
  const taskId = 9004;
  seedTask(taskId);
  replaceTaskImages(taskId, [png], 31);
  const queued = replaceTaskImages(taskId, [jpeg], 32, { activate: false });

  assert.deepEqual(getTaskImages(taskId), [canonical(png)], 'the in-flight run keeps its own set');

  activateAttachments(taskId, queued.ids);
  assert.deepEqual(getTaskImages(taskId), [canonical(jpeg)]);
});

test('attachment bytes are scoped to their task', () => {
  const taskId = 9005;
  seedTask(taskId);
  const { ids } = replaceTaskImages(taskId, [png]);

  const found = getAttachmentForTask(taskId, ids[0]);
  assert.equal(found?.mimeType, 'image/png');
  assert.ok((found?.buffer.length ?? 0) > 0);
  assert.equal(getAttachmentForTask(9999, ids[0]), null, 'another task cannot read it');
});

test('a blocked drain keeps the queue and does not grow attachments on retry', async () => {
  // Task 9006 has no session id, so every drain must refuse without consuming.
  // Re-running it used to re-insert the same base64 on each attempt.
  const taskId = 9006;
  seedTask(taskId);
  enqueue(taskId, 'look again', [png]);

  const first = await drainFollowUps(taskId);
  assert.equal(first.status, 'blocked');
  assert.equal(first.status === 'blocked' && first.reason, 'no_session');
  const afterFirst = listTaskAttachments(taskId).length;

  const second = await drainFollowUps(taskId);
  assert.equal(second.status, 'blocked');

  assert.equal(queueSize(taskId), 1, 'the queued message survives a blocked drain');
  assert.equal(
    listTaskAttachments(taskId).length,
    afterFirst,
    'a retried blocked drain must not append another copy'
  );
});

test('an already-running task is not dispatched a second time', async () => {
  const taskId = 9007;
  seedTask(taskId);
  db.prepare(`UPDATE tasks SET status='running', session_id='s-1' WHERE id=?`).run(taskId);
  enqueue(taskId, 'concurrent');

  const result = await drainFollowUps(taskId);
  assert.equal(result.status, 'blocked');
  assert.equal(result.status === 'blocked' && result.reason, 'task_active');
  assert.equal(queueSize(taskId), 1);
});

test('retention only removes superseded, unreachable attachments', () => {
  const taskId = 9008;
  seedTask(taskId);
  // Superseded and unbound -> eligible once it ages out.
  const stale = replaceTaskImages(taskId, [png]);
  // Superseded but still referenced by a user_message -> must survive, or the
  // timeline would render a broken thumbnail for that message.
  const bound = replaceTaskImages(taskId, [png], 55);
  // Newest generation, still dispatchable -> must survive.
  const active = replaceTaskImages(taskId, [jpeg]);

  db.prepare(`UPDATE task_attachments SET created_at = datetime('now','-40 days') WHERE task_id = ?`)
    .run(taskId);

  assert.equal(pruneStaleAttachments(30), 1, 'only the orphaned generation is removed');
  const remaining = listTaskAttachments(taskId).map((a) => a.id);
  assert.ok(!remaining.includes(stale.ids[0]), 'orphaned row deleted');
  assert.ok(remaining.includes(bound.ids[0]), 'log-bound row retained');
  assert.ok(remaining.includes(active.ids[0]), 'active row retained');
});

test('retention keeps attachments inside the window', () => {
  const taskId = 9009;
  seedTask(taskId);
  replaceTaskImages(taskId, [png]);
  replaceTaskImages(taskId, [jpeg]);

  assert.equal(pruneStaleAttachments(30), 0, 'recent rows are untouched');
  assert.equal(listTaskAttachments(taskId).length, 2);
});
