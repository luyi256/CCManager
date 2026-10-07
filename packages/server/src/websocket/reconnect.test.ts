import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

// database.ts opens its file at import time, so point it at a scratch dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-reconnect-'));
process.env.DATA_PATH = dataDir;

const { db } = await import('../services/database.js');
const { getTaskById, createAgentToken } = await import('../services/storage.js');
const { hashToken } = await import('../services/auth.js');
const { agentPool } = await import('../services/agentPool.js');
const { getStagedDispatchImages } = await import('../services/dispatchImages.js');
const { completeAgentUpload } = await import('../services/agentUploads.js');
const { setupWebSocket } = await import('./index.js');

// socket.io-client is only a dependency of the agent package.
interface TestClient {
  on(event: string, listener: (...args: any[]) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  timeout(ms: number): { emitWithAck(event: string, ...args: unknown[]): Promise<unknown> };
  disconnect(): void;
}
const requireFromAgent = createRequire(new URL('../../../agent/package.json', import.meta.url));
const { io: connectClient } = requireFromAgent('socket.io-client') as {
  io(url: string, options: Record<string, unknown>): TestClient;
};

function seedTask(id: number, status: string, startedAt: string, sessionId?: string): void {
  db.prepare(`
    INSERT INTO tasks (id, project_id, prompt, status, started_at, session_id)
    VALUES (?, 'p1', 'seed', ?, ?, ?)
  `).run(id, status, startedAt, sessionId ?? null);
}

test('agent reconnect syncs state silently and only recovers tasks the agent lost', async (t) => {
  db.prepare(`INSERT INTO agents (id, name) VALUES ('a1', 'a1')`).run();
  db.prepare(`INSERT INTO projects (id, name, project_path, agent_id) VALUES ('p1', 'p1', '/tmp/p1', 'a1')`).run();
  createAgentToken('a1', hashToken('agent-token'));

  seedTask(1, 'running', 'run-1'); // finished while the agent was offline
  seedTask(2, 'running', 'run-2'); // still executing on the agent
  seedTask(3, 'cancelled', 'run-3'); // cancelled by the user while offline
  seedTask(4, 'running', 'run-4', 'session-4'); // lost by an agent restart
  seedTask(5, 'running', 'run-5', 'session-5'); // an interrupted follow-up with images
  db.prepare(`UPDATE tasks SET continue_prompt = 'Fig. 1 ~ Fig. 8' WHERE id = 5`).run();
  db.prepare(`
    INSERT INTO task_attachments (task_id, position, mime_type, byte_size, data_url, active)
    VALUES (5, 0, 'image/png', 4, 'data:image/png;base64,AAAA', 1)
  `).run();
  seedTask(6, 'running', 'run-6', 'session-6'); // an interrupted follow-up with large images
  db.prepare(`UPDATE tasks SET continue_prompt = 'large figures' WHERE id = 6`).run();
  const largeImage = `data:image/png;base64,${'A'.repeat(300 * 1024)}`;
  db.prepare(`
    INSERT INTO task_attachments (task_id, position, mime_type, byte_size, data_url, active)
    VALUES (6, 0, 'image/png', ?, ?, 1)
  `).run(largeImage.length, largeImage);

  const httpServer = createServer();
  const io = setupWebSocket(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert(address && typeof address !== 'string');
  t.after(async () => {
    agentPool.stop();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const client = connectClient(`http://127.0.0.1:${address.port}/agent`, {
    auth: { token: 'agent-token', agentId: 'a1' },
    transports: ['websocket'],
    reconnection: false,
  });
  t.after(() => client.disconnect());

  type Dispatch = {
    taskId: number;
    recovery?: boolean;
    continueSession?: boolean;
    prompt: string;
    images?: string[];
    imagesRef?: { id: string; count: number; bytes: number };
  };
  const dispatched: Dispatch[] = [];
  client.on('task:execute', (task: Dispatch) => dispatched.push(task));
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('connect_error', reject);
  });

  const ack = await client.timeout(5000).emitWithAck('register', {
    agentId: 'a1',
    agentName: 'a1',
    capabilities: [],
    runningTasks: [
      { taskId: 2, startedAt: 'run-2' },
      { taskId: 3, startedAt: 'run-3' },
    ],
    finishedTasks: [
      { outcome: 'completed', taskId: 1, status: 'completed', sessionId: 'session-1', startedAt: 'run-1' },
    ],
  }) as { cancelTaskIds: number[] };
  await delay(200);

  const finished = await getTaskById(1);
  assert.equal(finished?.status, 'completed');
  assert.equal(finished?.sessionId, 'session-1');
  assert.equal(finished?.recoveryCount ?? 0, 0, 'a finished task must not be recovered');

  const stillRunning = await getTaskById(2);
  assert.equal(stillRunning?.status, 'running');
  assert.equal(stillRunning?.startedAt, 'run-2', 'a surviving run keeps its identity');
  assert.equal(stillRunning?.recoveryCount ?? 0, 0);

  assert.deepEqual(ack.cancelTaskIds, [3]);

  const lost = await getTaskById(4);
  assert.equal(lost?.recoveryCount, 1);
  assert.deepEqual(
    dispatched.map((task) => [task.taskId, task.recovery, task.continueSession]),
    [[4, true, true], [5, true, true], [6, true, true]],
    'only tasks unknown to the agent are re-dispatched'
  );
  assert.equal(dispatched[2].images, undefined, 'large images must not ride in the Socket.IO packet');
  assert.equal(dispatched[2].imagesRef?.count, 1);
  assert.deepEqual(getStagedDispatchImages(dispatched[2].imagesRef!.id, 'a1'), [largeImage]);
  assert.match(dispatched[0].prompt, /^Continue the interrupted task/);
  assert.equal(dispatched[0].images, undefined);
  assert.match(dispatched[1].prompt, /Latest user message:\nFig\. 1 ~ Fig\. 8$/);
  assert.deepEqual(dispatched[1].images, ['data:image/png;base64,AAAA'], 'a re-sent follow-up keeps its images');

  // Runner events are resent after a lost acknowledgement; each applies once.
  const batch = {
    taskId: 2,
    runId: 'run-2',
    events: [
      { seq: 1, event: 'task:output', data: { taskId: 2, text: 'first', startedAt: 'run-2' } },
      { seq: 2, event: 'task:output', data: { taskId: 2, text: 'second', startedAt: 'run-2' } },
    ],
  };
  const firstAck = await client.timeout(5000).emitWithAck('task:events', batch) as { seq: number };
  const resentAck = await client.timeout(5000).emitWithAck('task:events', batch) as { seq: number };
  assert.equal(firstAck.seq, 2);
  assert.equal(resentAck.seq, 2);
  const outputs = db.prepare(`SELECT content FROM task_logs WHERE task_id = 2 AND type = 'output' ORDER BY id`).all() as Array<{ content: string }>;
  // Consecutive output chunks are coalesced into one log row.
  assert.equal(outputs.map((row) => JSON.parse(row.content)).join(''), 'firstsecond');

  // Session transcripts arrive over HTTP; the socket only acknowledges.
  client.on('sessions:detail', (request: { uploadId: string }, ack: (result: unknown) => void) => {
    completeAgentUpload(request.uploadId, 'a1', { ok: true, entries: [{ type: 'user', text: 'hi' }] });
    ack({ ok: true, uploaded: true });
  });
  const detail = await agentPool.requestSessionDetail('a1', '/tmp/p1', 'claude', 'session-x');
  assert.deepEqual(detail, { ok: true, entries: [{ type: 'user', text: 'hi' }] });

  // A catalog re-probed after registration replaces the advertised one.
  const tcodexCatalog = 'models:tcodex:{"installed":true,"models":["gpt-6-astra"]}';
  client.emit('capabilities', [tcodexCatalog]);
  await delay(200);
  assert.deepEqual(agentPool.getAgent('a1')?.capabilities, [tcodexCatalog]);
  const stored = db.prepare(`SELECT capabilities FROM agents WHERE id = 'a1'`).get() as { capabilities: string };
  assert.deepEqual(JSON.parse(stored.capabilities), [tcodexCatalog]);
});
