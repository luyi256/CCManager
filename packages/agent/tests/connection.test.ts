import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import type { Server as SocketIOServerType, Socket } from '../../server/node_modules/socket.io/dist/index.js';
import { AgentConnection } from '../src/connection.js';
import type { AgentConfig } from '../src/types.js';

type SocketIOModule = typeof import('../../server/node_modules/socket.io/dist/index.js');
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { Server: SocketIOServer } = requireFromServer('socket.io') as SocketIOModule;

interface TestSocketServer {
  httpServer: HttpServer;
  io: SocketIOServerType;
  url: string;
  closed: boolean;
}

function config(managerUrl: string, dataPath: string, runsDir = mkdtempSync(path.join(tmpdir(), 'ccm-runs-'))): AgentConfig {
  return {
    agentId: 'test-agent',
    agentName: 'Test Agent',
    dataPath,
    managerUrl,
    authToken: 'test-token',
    allowedPaths: [tmpdir()],
    runsDir,
    attachmentsDir: path.join(runsDir, '..', `${path.basename(runsDir)}-attachments`),
  };
}

async function listenHttp(server: HttpServer, port = 0): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

async function createSocketServer(onConnection: (socket: Socket) => void, port = 0, onRequest?: RequestHandler): Promise<TestSocketServer> {
  const httpServer = onRequest ? createServer(onRequest) : createServer();
  const io = new SocketIOServer(httpServer, { serveClient: false });
  io.of('/agent').on('connection', onConnection);
  const url = await listenHttp(httpServer, port);
  return { httpServer, io, url, closed: false };
}

async function closeSocketServer(server: TestSocketServer): Promise<void> {
  if (server.closed) return;
  server.closed = true;
  await new Promise<void>((resolve) => server.io.close(() => resolve()));
  if (server.httpServer.listening) {
    await new Promise<void>((resolve, reject) => {
      server.httpServer.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(message);
}

test('reconnects after a server-initiated disconnect, sends immediate status, and skips duplicate recovery', async (t) => {
  let registrations = 0;
  let statuses = 0;
  let fakeCancelCalls = 0;

  const server = await createSocketServer((socket) => {
    socket.on('register', () => {
      registrations++;
      if (registrations === 1) {
        socket.disconnect(true);
      } else {
        socket.emit('task:execute', {
          taskId: 42,
          projectId: 'project',
          projectPath: tmpdir(),
          prompt: 'recovered task',
          isPlanMode: false,
        });
      }
    });
    socket.on('status', () => {
      statuses++;
    });
  });
  t.after(() => closeSocketServer(server));

  const connection = new AgentConnection(config(server.url, tmpdir()));
  const internals = connection as unknown as {
    executors: Map<number, { cancel(): void; isRunning: boolean }>;
  };
  internals.executors.set(42, {
    cancel: () => {
      fakeCancelCalls++;
    },
    isRunning: true,
  });
  t.after(() => connection.disconnect());

  connection.connect();
  await waitFor(() => registrations >= 2, 'agent did not reconnect after io server disconnect');
  await waitFor(() => statuses >= 1, 'agent did not publish an immediate heartbeat status');
  await delay(100);

  assert.equal(fakeCancelCalls, 0, 'duplicate recovery should not replace an active executor');
  assert.equal(internals.executors.has(42), true);
  assert.equal(connection.isConnected, true);
});

test('stops tasks the server reports as cancelled while the agent was disconnected', async (t) => {
  let cancelCalls = 0;
  const server = await createSocketServer((socket) => {
    socket.on('register', (_info, ack?: (data: unknown) => void) => {
      ack?.({ runningTasks: [], cancelTaskIds: [42] });
    });
  });
  t.after(() => closeSocketServer(server));

  const connection = new AgentConnection(config(server.url, tmpdir()));
  const internals = connection as unknown as {
    executors: Map<number, { cancel(): void; isRunning: boolean }>;
  };
  internals.executors.set(42, {
    cancel: () => {
      cancelCalls++;
    },
    isRunning: false,
  });
  t.after(() => connection.disconnect());

  connection.connect();
  await waitFor(() => cancelCalls === 1, 'cancelled task was not stopped after reconnect');
  assert.equal(internals.executors.has(42), false);
});

test('reconnects and re-registers after a transient server restart at the same URL', async (t) => {
  let registrations = 0;
  let statuses = 0;
  let replacement: TestSocketServer | null = null;

  const first = await createSocketServer((socket) => {
    socket.on('register', () => {
      registrations++;
    });
  });
  const connection = new AgentConnection(config(first.url, tmpdir()));
  t.after(() => connection.disconnect());
  t.after(() => closeSocketServer(first));
  t.after(async () => {
    if (replacement) await closeSocketServer(replacement);
  });

  connection.connect();
  await waitFor(() => registrations === 1, 'agent did not register before the restart');

  const port = Number(new URL(first.url).port);
  await closeSocketServer(first);
  replacement = await createSocketServer((socket) => {
    socket.on('register', () => {
      registrations++;
    });
    socket.on('status', () => {
      statuses++;
    });
  }, port);

  await waitFor(() => registrations >= 2, 'agent did not reconnect after the server restart', 7000);
  await waitFor(() => statuses >= 1, 'agent did not resume heartbeats after the server restart');

  assert.equal(connection.isConnected, true);
});

test('re-reads a remote server URL and preserves Socket.IO buffered task events when switching servers', async (t) => {
  let firstRegistrations = 0;
  let secondRegistrations = 0;
  const completedTaskIds: number[] = [];

  const first = await createSocketServer((socket) => {
    socket.on('register', () => {
      firstRegistrations++;
    });
  });
  const second = await createSocketServer((socket) => {
    socket.on('register', () => {
      secondRegistrations++;
    });
    socket.on('task:completed', (data: { taskId: number }) => {
      completedTaskIds.push(data.taskId);
    });
  });
  t.after(() => closeSocketServer(first));
  t.after(() => closeSocketServer(second));

  let discoveryRequests = 0;
  const discoveryHttp = createServer(async (request, response) => {
    if (request.url?.startsWith('/server-url.txt')) {
      discoveryRequests++;
      await delay(250);
      response.writeHead(200, {
        'content-type': 'text/plain',
        'cache-control': 'no-store',
      });
      response.end(second.url);
      return;
    }
    response.writeHead(404).end();
  });
  const discoveryUrl = await listenHttp(discoveryHttp);
  t.after(() => new Promise<void>((resolve, reject) => {
    if (discoveryHttp.listening) {
      discoveryHttp.close((error) => error ? reject(error) : resolve());
    } else {
      resolve();
    }
  }));

  const connection = new AgentConnection(config(first.url, discoveryUrl));
  const internals = connection as unknown as {
    socket: { emit(event: string, ...args: unknown[]): void } | null;
  };
  t.after(() => connection.disconnect());

  connection.connect();
  await waitFor(() => firstRegistrations === 1, 'agent did not register with the first server');

  const closing = closeSocketServer(first);
  await waitFor(() => !connection.isConnected, 'agent did not observe the first server disconnect');
  internals.socket?.emit('task:completed', { taskId: 77, status: 'completed' });

  await waitFor(() => secondRegistrations >= 1, 'agent did not switch to the discovered server', 7000);
  await waitFor(() => completedTaskIds.includes(77), 'buffered task completion was lost during URL switch');
  await closing;

  assert.ok(discoveryRequests >= 1);
  assert.equal(connection.isConnected, true);
});

test('local URL discovery reads server-url.txt and never silently switches to localhost', async (t) => {
  const dataPath = await mkdtemp(path.join(tmpdir(), 'ccmanager-agent-discovery-'));
  t.after(() => rm(dataPath, { recursive: true, force: true }));
  await writeFile(path.join(dataPath, 'server-url.txt'), 'https://remote.example.test/ccm/\n');

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error('local discovery must not use HTTP');
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const connection = new AgentConnection(config('https://old.example.test', dataPath));
  const discovered = await (connection as unknown as {
    discoverUrl(): Promise<string | null>;
  }).discoverUrl();

  assert.equal(discovered, 'https://remote.example.test/ccm');
  assert.equal(fetchCalls, 0);
});

interface AppliedEvent {
  event: string;
  data: Record<string, unknown>;
}

interface RunnerTestServer extends TestSocketServer {
  applied: AppliedEvent[];
  registrations: Array<{ runningTasks?: Array<{ taskId: number; startedAt?: string }> }>;
  sockets: Socket[];
}

/** Mirrors the real server: applies each (task, run, seq) at most once and acknowledges the cursor. */
async function createRunnerTestServer(
  onRegister?: (socket: Socket, count: number) => void,
  onRequest?: RequestHandler
): Promise<RunnerTestServer> {
  const cursors = new Map<string, number>();
  const applied: AppliedEvent[] = [];
  const registrations: RunnerTestServer['registrations'] = [];
  const sockets: Socket[] = [];
  const server = await createSocketServer((socket) => {
    sockets.push(socket);
    socket.on('register', (info, ack?: (data: unknown) => void) => {
      registrations.push(info);
      ack?.({ runningTasks: [], cancelTaskIds: [] });
      onRegister?.(socket, registrations.length);
    });
    socket.on('task:events', (batch: { taskId: number; runId?: string; events: Array<{ seq: number } & AppliedEvent> }, ack?: (data: unknown) => void) => {
      const key = `${batch.taskId}:${batch.runId ?? ''}`;
      let seq = cursors.get(key) ?? 0;
      for (const record of batch.events) {
        if (record.seq <= seq) continue;
        applied.push({ event: record.event, data: record.data });
        seq = record.seq;
      }
      cursors.set(key, seq);
      ack?.({ seq });
    });
  }, 0, onRequest);
  return { ...server, applied, registrations, sockets };
}

/** A stand-in `claude` CLI that streams stream-json and waits for a release file. */
function installFakeClaude(t: { after(fn: () => void): void }): { release: string; projectPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'ccm-fake-claude-'));
  const bin = path.join(root, 'bin');
  const projectPath = path.join(root, 'project');
  const release = path.join(root, 'release');
  mkdirSync(bin, { recursive: true });
  mkdirSync(projectPath, { recursive: true });
  const script = path.join(bin, 'claude');
  writeFileSync(script, [
    '#!/bin/sh',
    `echo '{"type":"system","subtype":"init","session_id":"sess-1"}'`,
    `echo '{"type":"content_block_delta","delta":{"type":"text_delta","text":"working"}}'`,
    `while [ ! -f "${release}" ]; do sleep 0.05; done`,
    `echo '{"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}'`,
    `echo '{"type":"result","session_id":"sess-1"}'`,
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
    writeFileSync(release, '');
  });
  return { release, projectPath };
}

function runnerPids(runsDir: string): number[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).flatMap((name) => {
    try {
      return [JSON.parse(readFileSync(path.join(runsDir, name, 'runner.json'), 'utf8')).pid as number];
    } catch {
      return [];
    }
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function outputs(applied: AppliedEvent[]): string[] {
  return applied.filter((item) => item.event === 'task:output').map((item) => String(item.data.text));
}

test('a task keeps running across an agent restart and its result is delivered exactly once', async (t) => {
  const { release, projectPath } = installFakeClaude(t);
  const server = await createRunnerTestServer((socket, count) => {
    if (count !== 1) return;
    socket.emit('task:execute', {
      taskId: 5,
      projectId: 'project',
      projectPath,
      prompt: 'long task',
      isPlanMode: false,
      runner: 'claude',
      startedAt: 'run-5',
    });
  });
  t.after(() => closeSocketServer(server));

  const runsDir = mkdtempSync(path.join(tmpdir(), 'ccm-runs-'));
  const first = new AgentConnection(config(server.url, tmpdir(), runsDir));
  first.connect();
  await waitFor(() => outputs(server.applied).includes('working'), 'runner output did not reach the server', 20000);

  // Simulate stopping the agent process (PM2 restart / upgrade).
  first.disconnect();
  const [pid] = runnerPids(runsDir);
  assert.ok(pid && processAlive(pid), 'runner must survive the agent stopping');
  if (existsSync(`/proc/${pid}/stat`)) {
    // Process managers kill the agent's descendants; the runner must not be one.
    const parentPid = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
    assert.notEqual(parentPid, process.pid);
  }

  writeFileSync(release, '');
  await waitFor(() => !processAlive(pid), 'runner did not finish', 10000);

  const second = new AgentConnection(config(server.url, tmpdir(), runsDir));
  t.after(() => second.disconnect());
  second.connect();

  await waitFor(() => server.applied.some((item) => item.event === 'task:completed'), 'completion was not delivered after restart', 10000);
  await waitFor(() => readdirSync(runsDir).length === 0, 'finished run directory was not cleaned up');

  assert.deepEqual(
    server.registrations[1].runningTasks?.map((task) => [task.taskId, task.startedAt]),
    [[5, 'run-5']],
    'a finished but undelivered run is reported as running so the server does not recover it'
  );
  assert.deepEqual(outputs(server.applied), ['working', 'done']);
  const completions = server.applied.filter((item) => item.event === 'task:completed');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].data.sessionId, 'sess-1');
  assert.equal(completions[0].data.startedAt, 'run-5');
});

test('downloads large dispatch images over HTTP before starting the runner', async (t) => {
  const { release, projectPath } = installFakeClaude(t);
  const image = `data:image/png;base64,${Buffer.alloc(16).toString('base64')}`;
  let authorization = '';
  const server = await createRunnerTestServer((socket, count) => {
    if (count !== 1) return;
    socket.emit('task:execute', {
      taskId: 7,
      projectId: 'project',
      projectPath,
      prompt: 'look at these',
      isPlanMode: false,
      runner: 'claude',
      startedAt: 'run-7',
      imagesRef: { id: 'staged-7', count: 2, bytes: image.length * 2 },
    });
  }, (request, response) => {
    if (request.url !== '/api/agent/dispatch-images/staged-7') return;
    authorization = request.headers.authorization || '';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ images: [image, image] }));
  });
  t.after(() => closeSocketServer(server));

  const runsDir = mkdtempSync(path.join(tmpdir(), 'ccm-runs-'));
  const connection = new AgentConnection(config(server.url, tmpdir(), runsDir));
  t.after(() => connection.disconnect());
  connection.connect();

  await waitFor(() => outputs(server.applied).includes('working'), 'runner did not start after the image download', 20000);
  const [runName] = readdirSync(runsDir);
  const request = JSON.parse(readFileSync(path.join(runsDir, runName, 'request.json'), 'utf8'));
  assert.equal(authorization, 'Bearer test-token');
  assert.deepEqual(request.task.images, [image, image]);
  assert.equal(request.task.imagesRef, undefined);

  writeFileSync(release, '');
  await waitFor(() => server.applied.some((item) => item.event === 'task:completed'), 'task did not complete', 10000);
});

test('uploads session detail over HTTP with gzip and the agent token', async (t) => {
  let received: { authorization?: string; encoding?: string; body?: unknown } = {};
  const server = await createRunnerTestServer(undefined, (request, response) => {
    if (request.url !== '/api/agent/session-detail/upload-1' || request.method !== 'POST') return;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received = {
        authorization: request.headers.authorization,
        encoding: request.headers['content-encoding'],
        body: JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8')),
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  t.after(() => closeSocketServer(server));

  const connection = new AgentConnection(config(server.url, tmpdir()));
  t.after(() => connection.disconnect());
  const payload = { ok: true, entries: [{ type: 'assistant', text: 'x'.repeat(100_000) }] };
  await (connection as unknown as { uploadResult(endpoint: string, id: string, result: unknown, timeoutMs: number): Promise<void> })
    .uploadResult('session-detail', 'upload-1', payload, 10_000);

  assert.equal(received.authorization, 'Bearer test-token');
  assert.equal(received.encoding, 'gzip');
  assert.deepEqual(received.body, payload);
});

test('lists project files over the socket and uploads large previews over HTTP', async (t) => {
  const projectPath = mkdtempSync(path.join(tmpdir(), 'ccm-files-project-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  mkdirSync(path.join(projectPath, 'src'));
  writeFileSync(path.join(projectPath, 'small.txt'), 'hi');
  writeFileSync(path.join(projectPath, 'large.txt'), 'y'.repeat(400 * 1024));

  let uploaded: { url?: string; body?: { ok: boolean; kind: string; content: string } } = {};
  let registeredSocket: Socket | null = null;
  const server = await createRunnerTestServer((socket) => {
    registeredSocket = socket;
  }, (request, response) => {
    if (!request.url?.startsWith('/api/agent/uploads/') || request.method !== 'POST') return;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      uploaded = { url: request.url, body: JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8')) };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  t.after(() => closeSocketServer(server));

  const connection = new AgentConnection({ ...config(server.url, tmpdir()), allowedPaths: [projectPath] });
  t.after(() => connection.disconnect());
  connection.connect();
  await waitFor(() => registeredSocket !== null, 'agent did not register');
  const socket = registeredSocket as unknown as Socket;

  const listing = await socket.timeout(5000).emitWithAck('files:list', { projectPath, path: '' }) as {
    ok: boolean;
    entries: Array<{ name: string; type: string }>;
  };
  assert.equal(listing.ok, true);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['src', 'large.txt', 'small.txt']);

  const small = await socket.timeout(5000).emitWithAck('files:read', { projectPath, path: 'small.txt', uploadId: 'u-small' }) as {
    ok: boolean;
    content?: string;
  };
  assert.equal(small.content, 'hi');
  assert.equal(uploaded.url, undefined);

  const large = await socket.timeout(5000).emitWithAck('files:read', { projectPath, path: 'large.txt', uploadId: 'u-large' });
  assert.deepEqual(large, { ok: true, uploaded: true });
  assert.equal(uploaded.url, '/api/agent/uploads/u-large');
  assert.equal(uploaded.body?.kind, 'text');
  assert.equal(uploaded.body?.content.length, 400 * 1024);

  const denied = await socket.timeout(5000).emitWithAck('files:read', { projectPath, path: '../escape.txt' }) as {
    ok: boolean;
    code?: string;
  };
  assert.deepEqual([denied.ok, denied.code], [false, 'denied']);
});

test('saves file attachments where the runner can read them', async (t) => {
  const { release, projectPath } = installFakeClaude(t);
  const notes = `data:text/markdown;name=${encodeURIComponent('review notes.md')};base64,${Buffer.from('# Cons 1').toString('base64')}`;
  const server = await createRunnerTestServer((socket, count) => {
    if (count !== 1) return;
    socket.emit('task:execute', {
      taskId: 8,
      projectId: 'project',
      projectPath,
      prompt: 'read the notes',
      isPlanMode: false,
      runner: 'claude',
      startedAt: 'run-8',
      images: [notes],
    });
  });
  t.after(() => closeSocketServer(server));

  const runsDir = mkdtempSync(path.join(tmpdir(), 'ccm-runs-'));
  const agentConfig = config(server.url, tmpdir(), runsDir);
  const connection = new AgentConnection(agentConfig);
  t.after(() => connection.disconnect());
  connection.connect();

  await waitFor(() => outputs(server.applied).includes('working'), 'runner did not start', 20000);
  const saved = path.join(agentConfig.attachmentsDir!, 'task-8', 'review notes.md');
  assert.equal(readFileSync(saved, 'utf8'), '# Cons 1');

  writeFileSync(release, '');
  await waitFor(() => server.applied.some((item) => item.event === 'task:completed'), 'task did not complete', 10000);
});

test('cancelling a task stops its runner without reporting a failure', async (t) => {
  const { projectPath } = installFakeClaude(t);
  const server = await createRunnerTestServer((socket, count) => {
    if (count !== 1) return;
    socket.emit('task:execute', {
      taskId: 6,
      projectId: 'project',
      projectPath,
      prompt: 'cancel me',
      isPlanMode: false,
      runner: 'claude',
      startedAt: 'run-6',
    });
  });
  t.after(() => closeSocketServer(server));

  const runsDir = mkdtempSync(path.join(tmpdir(), 'ccm-runs-'));
  const connection = new AgentConnection(config(server.url, tmpdir(), runsDir));
  t.after(() => connection.disconnect());
  connection.connect();
  await waitFor(() => outputs(server.applied).includes('working'), 'runner output did not reach the server', 20000);
  const [pid] = runnerPids(runsDir);

  server.sockets[0].emit('task:cancel', { taskId: 6 });
  await waitFor(() => !processAlive(pid), 'cancelled runner did not exit', 10000);
  await waitFor(() => readdirSync(runsDir).length === 0, 'cancelled run directory was not cleaned up');

  assert.equal(
    server.applied.some((item) => item.event === 'task:completed' || item.event === 'task:failed'),
    false
  );
});

test('a run whose runner died while the agent was down is left to server recovery', async (t) => {
  const server = await createRunnerTestServer();
  t.after(() => closeSocketServer(server));

  const runsDir = mkdtempSync(path.join(tmpdir(), 'ccm-runs-'));
  const runDir = path.join(runsDir, '9-run-9-abc');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'request.json'), JSON.stringify({
    task: { taskId: 9, projectId: 'p', projectPath: tmpdir(), prompt: 'x', isPlanMode: false, startedAt: 'run-9' },
    executionPath: tmpdir(),
  }));
  writeFileSync(path.join(runDir, 'runner.json'), JSON.stringify({ pid: 2 ** 22 - 3 }));

  const connection = new AgentConnection(config(server.url, tmpdir(), runsDir));
  t.after(() => connection.disconnect());
  connection.connect();

  await waitFor(() => server.registrations.length === 1, 'agent did not register');
  assert.deepEqual(server.registrations[0].runningTasks, []);
  assert.equal(existsSync(runDir), false);
});
