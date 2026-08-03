import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
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

function config(managerUrl: string, dataPath: string): AgentConfig {
  return {
    agentId: 'test-agent',
    agentName: 'Test Agent',
    dataPath,
    managerUrl,
    authToken: 'test-token',
    allowedPaths: [tmpdir()],
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

async function createSocketServer(onConnection: (socket: Socket) => void, port = 0): Promise<TestSocketServer> {
  const httpServer = createServer();
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
