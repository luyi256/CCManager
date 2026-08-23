#!/usr/bin/env node
/**
 * Generate README screenshots and a short demo from the current production UI.
 *
 * The script creates a temporary SQLite database and a temporary Claude session
 * directory containing fictional data, then starts the built server on port
 * 3099. No real project names, paths, sessions, or tokens are captured.
 *
 * Prerequisites:
 *   - pnpm run build
 *   - Playwright (set PLAYWRIGHT_MODULE if it is not installed in this repo)
 *   - ffmpeg (optional; set FFMPEG_PATH when it is not on PATH)
 *
 * Usage:
 *   PLAYWRIGHT_MODULE=/path/to/playwright node docs/generate-showcase.mjs
 */

import { execFileSync, spawn } from 'child_process';
import { mkdirSync, rmSync, existsSync, statSync, writeFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const TEMP_DATA = '/tmp/ccm-showcase-data';
const TEMP_HOME = '/tmp/ccm-showcase-home';
const DEMO_PORT = 3099;
const ORIGIN = `http://localhost:${DEMO_PORT}`;
const BASE = `${ORIGIN}/ccm`;
const DEMO_TOKEN = 'demo-showcase-token-2026';
const DEMO_TOKEN_HASH = createHash('sha256').update(DEMO_TOKEN).digest('hex');
const DEMO_AGENT_TOKEN = 'demo-studio-linux-agent-token';
const PROJECT_PATH = '/home/demo/projects/commerce-api';
const DEMO_AGENT_CAPABILITIES = [
  'linux',
  'docker',
  'models:claude:{"installed":true,"models":["sonnet","opus"]}',
  'models:claude-grok:{"installed":true,"models":["grok-4.6"]}',
  'models:codex:{"installed":true,"models":["gpt-5.4","gpt-5.3-codex"]}',
  'models:qwen:{"installed":true,"models":[]}',
  'models:tclaude:{"installed":true,"models":["claude-sonnet-4-6","claude-opus-4-6"]}',
  'models:tcodex:{"installed":true,"models":["gpt-5.4"]}',
];
const DEMO_REMOTE_SESSIONS = [
  {
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    runner: 'codex',
    model: 'gpt-5.4',
    firstPrompt: 'Investigate intermittent inventory reservation failures during flash sales',
    lastModifiedOffset: 1,
    fileSize: 14820,
    gitBranch: 'feature/inventory-leases',
    isActive: true,
  },
  {
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    runner: 'qwen',
    model: undefined,
    firstPrompt: 'Compare the generated OpenAPI schema with the production gateway contract',
    lastModifiedOffset: 2,
    fileSize: 9320,
    gitBranch: 'audit/openapi',
    isActive: true,
  },
  {
    sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    runner: 'tclaude',
    model: 'claude-sonnet-4-6',
    firstPrompt: 'Reduce cold-start latency in the webhook worker without changing delivery order',
    lastModifiedOffset: 90,
    fileSize: 22140,
    gitBranch: 'perf/webhook-worker',
    isActive: false,
  },
];

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const modulePath = process.env.PLAYWRIGHT_MODULE;
    if (!modulePath) {
      throw new Error(
        'Playwright is not installed in this workspace. Set PLAYWRIGHT_MODULE to its package directory.'
      );
    }
    return import(pathToFileURL(path.join(path.resolve(modulePath), 'index.js')).href);
  }
}

function sqliteDatetime(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function timeAgo(hours) {
  return sqliteDatetime(new Date(Date.now() - hours * 3600_000));
}

function timeAgoMin(minutes) {
  return sqliteDatetime(new Date(Date.now() - minutes * 60_000));
}

function writeSession(sessionId, entries, minutesAgo = 3) {
  const sessionDir = path.join(
    TEMP_HOME,
    '.claude',
    'projects',
    PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-')
  );
  mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
  const base = Date.now() - minutesAgo * 60_000;
  const rows = entries.map((entry, index) => ({
    uuid: randomUUID(),
    parentUuid: index > 0 ? `entry-${index - 1}` : null,
    timestamp: new Date(base + index * 18_000).toISOString(),
    gitBranch: 'feature/live-checkout',
    ...entry,
  }));
  writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const modified = new Date(Date.now() - minutesAgo * 60_000);
  return { filePath, modified };
}

function touchSession(filePath, modified) {
  const seconds = modified.getTime() / 1000;
  execFileSync('touch', ['-d', `@${seconds}`, filePath]);
}

function setupDemoDatabase() {
  console.log('=== Setting up current demo data ===');
  for (const dir of [TEMP_DATA, TEMP_HOME]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
  }

  const require = createRequire(import.meta.url);
  const Database = require(path.join(ROOT, 'packages/server/node_modules/better-sqlite3'));
  const db = new Database(path.join(TEMP_DATA, 'ccmanager.db'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      capabilities TEXT DEFAULT '[]', executor TEXT DEFAULT 'local',
      status TEXT DEFAULT 'offline', last_seen TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      agent_id TEXT, project_path TEXT NOT NULL,
      security_mode TEXT DEFAULT 'auto', auth_type TEXT DEFAULT 'oauth',
      created_at TEXT DEFAULT (datetime('now')), last_activity TEXT,
      post_task_hook TEXT, extra_mounts TEXT, enable_worktree INTEGER DEFAULT 0,
      executor TEXT DEFAULT 'local', docker_image TEXT, allowed_paths TEXT,
      last_model TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL, prompt TEXT NOT NULL,
      status TEXT DEFAULT 'pending', is_plan_mode INTEGER DEFAULT 0,
      runner TEXT DEFAULT 'claude', model TEXT,
      depends_on INTEGER, worktree_branch TEXT,
      created_at TEXT DEFAULT (datetime('now')), started_at TEXT,
      completed_at TEXT, error TEXT, waiting_until TEXT, wait_reason TEXT,
      check_command TEXT, continue_prompt TEXT, git_info TEXT,
      summary TEXT, security_warnings TEXT, pending_permission TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (depends_on) REFERENCES tasks(id)
    );
    CREATE TABLE task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL, timestamp TEXT DEFAULT (datetime('now')),
      type TEXT NOT NULL, content TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
    CREATE TABLE device_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now')), last_used_at TEXT
    );
    CREATE TABLE agent_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now')), last_used_at TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );
    CREATE TABLE model_cache (
      agent_id TEXT NOT NULL, runner TEXT NOT NULL, models TEXT NOT NULL,
      raw TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, runner)
    );
    CREATE INDEX idx_tasks_project ON tasks(project_id);
    CREATE INDEX idx_tasks_status ON tasks(status);
    CREATE INDEX idx_task_logs_task ON task_logs(task_id);
    CREATE INDEX idx_projects_agent ON projects(agent_id);
    CREATE INDEX idx_device_tokens_hash ON device_tokens(token_hash);
    CREATE INDEX idx_agent_tokens_hash ON agent_tokens(token_hash);
  `);

  db.prepare(`INSERT INTO device_tokens (name, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?)`)
    .run('Demo Browser', DEMO_TOKEN_HASH, timeAgo(168), timeAgoMin(1));
  db.prepare(`INSERT INTO device_tokens (name, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?)`)
    .run('Phone', createHash('sha256').update('demo-phone').digest('hex'), timeAgo(96), timeAgo(2));

  const agents = [
    {
      id: 'studio-linux',
      name: 'Studio Linux',
      capabilities: DEMO_AGENT_CAPABILITIES,
      executor: 'docker',
      status: 'online',
      lastSeen: timeAgoMin(1),
    },
    {
      id: 'macbook-pro',
      name: 'MacBook Pro',
      capabilities: [
        'macos',
        'models:claude:{"installed":true,"models":["sonnet","opus"]}',
        'models:codex:{"installed":true,"models":["gpt-5.4"]}',
      ],
      executor: 'local',
      status: 'offline',
      lastSeen: timeAgo(8),
    },
  ];
  const insertAgent = db.prepare(
    `INSERT INTO agents (id, name, capabilities, executor, status, last_seen) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const agent of agents) {
    insertAgent.run(
      agent.id,
      agent.name,
      JSON.stringify(agent.capabilities),
      agent.executor,
      agent.status,
      agent.lastSeen
    );
    db.prepare(`INSERT INTO agent_tokens (agent_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?)`)
      .run(
        agent.id,
        createHash('sha256').update(
          agent.id === 'studio-linux' ? DEMO_AGENT_TOKEN : `agent-token-${agent.id}`
        ).digest('hex'),
        timeAgo(168),
        agent.status === 'online' ? timeAgoMin(1) : timeAgo(8)
      );
  }

  const projectCommerce = randomUUID();
  const projectPortal = randomUUID();
  const projectMobile = randomUUID();
  const insertProject = db.prepare(`
    INSERT INTO projects (
      id, name, agent_id, project_path, security_mode, executor, docker_image,
      enable_worktree, allowed_paths, last_model, created_at, last_activity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertProject.run(
    projectCommerce,
    'commerce-api',
    'studio-linux',
    PROJECT_PATH,
    'safe',
    'docker',
    'ccmanager-runner:latest',
    1,
    JSON.stringify(['/home/demo/projects/**']),
    'gpt-5.4',
    timeAgo(336),
    timeAgoMin(4)
  );
  insertProject.run(
    projectPortal,
    'ops-dashboard',
    'studio-linux',
    '/home/demo/projects/ops-dashboard',
    'auto',
    'local',
    null,
    0,
    null,
    'sonnet',
    timeAgo(240),
    timeAgo(2)
  );
  insertProject.run(
    projectMobile,
    'mobile-client',
    'macbook-pro',
    '/Users/demo/projects/mobile-client',
    'auto',
    'local',
    null,
    0,
    null,
    'gpt-5.4',
    timeAgo(168),
    timeAgo(12)
  );

  const insertTask = db.prepare(`
    INSERT INTO tasks (
      project_id, prompt, status, is_plan_mode, runner, model, depends_on,
      worktree_branch, created_at, started_at, completed_at, error, git_info, summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLog = db.prepare(
    `INSERT INTO task_logs (task_id, timestamp, type, content) VALUES (?, ?, ?, ?)`
  );
  const addLogs = (taskId, baseMs, entries) => {
    for (const [offset, type, content] of entries) {
      insertLog.run(
        Number(taskId),
        new Date(baseMs + offset).toISOString(),
        type,
        JSON.stringify(content)
      );
    }
  };

  const liveTask = insertTask.run(
    projectCommerce,
    'Add idempotent checkout retries and expose retry diagnostics in the admin API',
    'running',
    0,
    'codex',
    'gpt-5.4',
    null,
    'ccm/task-18-checkout-retries',
    timeAgoMin(18),
    timeAgoMin(17),
    null,
    null,
    JSON.stringify({ sessionId: '11111111-1111-4111-8111-111111111111' }),
    'Implementing idempotent checkout retries with observable diagnostics'
  ).lastInsertRowid;
  const liveBase = Date.now() - 17 * 60_000;
  addLogs(liveTask, liveBase, [
    [0, 'output', 'I’ll trace the checkout retry path, add an idempotency boundary, and keep the diagnostics visible without changing the public payment contract.'],
    [2500, 'tool_use', { id: 'live-read-1', name: 'Read', input: { file_path: '/home/demo/projects/commerce-api/src/payments/checkout.ts' } }],
    [4500, 'tool_use', { id: 'live-grep-1', name: 'Grep', input: { pattern: 'retry|idempotency', path: 'src/payments' } }],
    [7500, 'output', 'The race is between the gateway timeout handler and the retry queue. I’m moving key creation ahead of the first request and persisting every attempt under the same checkout operation.'],
    [11000, 'tool_use', { id: 'live-edit-1', name: 'Edit', input: { file_path: '/home/demo/projects/commerce-api/src/payments/checkout.ts', old_string: 'gateway.charge(request)', new_string: 'gateway.charge(request, { idempotencyKey })' } }],
    [14500, 'tool_use', { id: 'live-write-1', name: 'Write', input: { file_path: '/home/demo/projects/commerce-api/src/routes/admin/retryDiagnostics.ts', content: '// redacted demo source' } }],
    [18000, 'output', 'The core retry path is updated. I’m running focused tests now, then I’ll add the admin response fields and document the behavior.'],
    [22000, 'tool_use', { id: 'live-test-1', name: 'Bash', input: { command: 'pnpm test --filter checkout-retry', description: 'Run checkout retry tests' } }],
  ]);

  const completedTask = insertTask.run(
    projectCommerce,
    'Add request tracing across HTTP handlers, background jobs, and outbound provider calls',
    'completed',
    0,
    'claude',
    'sonnet',
    null,
    null,
    timeAgo(30),
    timeAgo(30),
    timeAgo(29),
    null,
    JSON.stringify({ sessionId: '22222222-2222-4222-8222-222222222222' }),
    'Added end-to-end request tracing with structured logs and trace propagation'
  ).lastInsertRowid;
  const completedBase = Date.now() - 30 * 3600_000;
  addLogs(completedTask, completedBase, [
    [0, 'output', 'I’ll first map the request boundaries and existing logger usage, then add trace propagation without changing handler signatures.'],
    [2200, 'tool_use', { id: 'trace-glob', name: 'Glob', input: { pattern: 'src/**/*.{ts,tsx}' } }],
    [4200, 'tool_use', { id: 'trace-read', name: 'Read', input: { file_path: '/home/demo/projects/commerce-api/src/lib/logger.ts' } }],
    [7600, 'output', 'There are three boundaries to connect: inbound HTTP requests, queue jobs, and provider SDK calls. I’ll use AsyncLocalStorage so application code can read the current trace without threading it through every function.'],
    [11000, 'tool_use', { id: 'trace-write', name: 'Write', input: { file_path: '/home/demo/projects/commerce-api/src/lib/traceContext.ts', content: '// redacted demo source' } }],
    [14500, 'tool_use', { id: 'trace-edit-1', name: 'Edit', input: { file_path: '/home/demo/projects/commerce-api/src/http/middleware.ts', old_string: 'next()', new_string: 'traceContext.run({ traceId }, next)' } }],
    [17500, 'tool_use', { id: 'trace-edit-2', name: 'Edit', input: { file_path: '/home/demo/projects/commerce-api/src/jobs/worker.ts', old_string: 'await handler(job)', new_string: 'await traceContext.run({ traceId }, () => handler(job))' } }],
    [21000, 'tool_use', { id: 'trace-test', name: 'Bash', input: { command: 'pnpm test && pnpm typecheck', description: 'Run tests and typecheck' } }],
    [26000, 'output', 'Implemented tracing across all three boundaries.\n\n- Added `traceContext` using `AsyncLocalStorage`\n- Propagated `x-request-id` through HTTP, jobs, and provider calls\n- Added structured timing fields to the logger\n- Added regression coverage for nested and concurrent requests\n\nAll tests and type checks pass.'],
  ]);

  const grokTask = insertTask.run(
    projectCommerce,
    'Review the webhook verification flow and propose a smaller, safer API surface',
    'completed_with_warnings',
    1,
    'claude-grok',
    'grok-4.6',
    null,
    null,
    timeAgo(9),
    timeAgo(9),
    timeAgo(8),
    null,
    JSON.stringify({ sessionId: '33333333-3333-4333-8333-333333333333' }),
    'Reviewed webhook verification and proposed a safer API boundary'
  ).lastInsertRowid;
  addLogs(grokTask, Date.now() - 9 * 3600_000, [
    [0, 'output', 'I’ll inspect the signature verification boundary and produce a migration plan before making changes.'],
    [3000, 'tool_use', { id: 'grok-read', name: 'Read', input: { file_path: '/home/demo/projects/commerce-api/src/webhooks/verify.ts' } }],
    [7000, 'output', 'The current flow exposes raw provider payloads too broadly. The safer shape is a small verified-event object plus provider-specific adapters. One legacy consumer still reads the raw body and needs migration.'],
  ]);

  insertTask.run(
    projectCommerce,
    'Generate an OpenAPI changelog for the next release',
    'pending',
    0,
    'qwen',
    null,
    Number(liveTask),
    null,
    timeAgoMin(5),
    null,
    null,
    null,
    null,
    null
  );

  insertTask.run(
    projectPortal,
    'Build a deployment health overview with WebSocket updates',
    'completed',
    0,
    'tclaude',
    'claude-sonnet-4-6',
    null,
    null,
    timeAgo(48),
    timeAgo(48),
    timeAgo(47),
    null,
    null,
    'Built the deployment health overview with live updates'
  );
  insertTask.run(
    projectPortal,
    'Add role-aware incident timeline filters',
    'completed',
    0,
    'tcodex',
    'gpt-5.4',
    null,
    null,
    timeAgo(20),
    timeAgo(20),
    timeAgo(19),
    null,
    null,
    'Added role-aware incident timeline filters'
  );
  insertTask.run(
    projectMobile,
    'Improve offline synchronization conflict handling',
    'completed_with_warnings',
    0,
    'codex',
    'gpt-5.4',
    null,
    null,
    timeAgo(72),
    timeAgo(72),
    timeAgo(71),
    null,
    null,
    'Improved offline synchronization with conflict diagnostics'
  );

  db.close();

  const activeSession = '44444444-4444-4444-8444-444444444444';
  const active = writeSession(activeSession, [
    {
      type: 'user',
      message: { role: 'user', content: 'Profile checkout event fan-out during traffic spikes' },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I’ll inspect reservation locking, timeout behavior, and the queue consumer before proposing a fix.' },
          { type: 'tool_use', id: 'session-read', name: 'Read', input: { file_path: `${PROJECT_PATH}/src/inventory/reservations.ts` } },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'session-read', content: 'export async function reserveInventory(...) { /* demo */ }' },
        ],
      },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The current lock expires before the queue retry window. I’m checking whether extending the lease or renewing it is safer under load.' }] },
    },
  ], 1);
  touchSession(active.filePath, active.modified);

  const oldSession = '55555555-5555-4555-8555-555555555555';
  const old = writeSession(oldSession, [
    {
      type: 'user',
      message: { role: 'user', content: 'Audit the admin export endpoints for memory spikes' },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The CSV export buffers the entire result. I’ll replace it with a streaming response and add a bounded page size.' }] },
    },
  ], 180);
  touchSession(old.filePath, old.modified);

  console.log('Demo database:', path.join(TEMP_DATA, 'ccmanager.db'));
  return { projectCommerce, liveTask: Number(liveTask), completedTask: Number(completedTask) };
}

function startDemoServer() {
  console.log(`\n=== Starting demo server on ${ORIGIN} ===`);
  const server = spawn('node', [path.join(ROOT, 'packages/server/dist/index.js')], {
    env: {
      ...process.env,
      HOME: TEMP_HOME,
      DATA_PATH: TEMP_DATA,
      PORT: String(DEMO_PORT),
      HOST: '127.0.0.1',
      SERVE_STATIC: 'true',
      STATIC_PATH: path.join(ROOT, 'packages/web/dist'),
      NODE_ENV: 'production',
      SOCKET_IO_PATH: '/ccm/socket.io',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (data) => process.stdout.write(`[server] ${data}`));
  server.stderr.on('data', (data) => process.stderr.write(`[server] ${data}`));
  return server;
}

async function waitForServer(maxWait = 15_000) {
  const started = Date.now();
  while (Date.now() - started < maxWait) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // Keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('Demo server did not start in time');
}

async function connectDemoAgent() {
  const require = createRequire(import.meta.url);
  const { io } = require(path.join(ROOT, 'packages/agent/node_modules/socket.io-client'));
  const socket = io(`${ORIGIN}/agent`, {
    path: '/ccm/socket.io',
    auth: {
      token: DEMO_AGENT_TOKEN,
      agentId: 'studio-linux',
    },
    transports: ['websocket'],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Demo agent connection timed out')), 5000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.emit('register', {
        agentId: 'studio-linux',
        agentName: 'Studio Linux',
        capabilities: DEMO_AGENT_CAPABILITIES,
        executor: 'docker',
      });
      socket.emit('status', { status: 'online', runningTasks: [1], taskCount: 1 });
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  const serializeSessions = (activeOnly = false) => DEMO_REMOTE_SESSIONS
    .filter((session) => !activeOnly || session.isActive)
    .map(({ lastModifiedOffset, ...session }) => ({
      ...session,
      lastModified: new Date(Date.now() - lastModifiedOffset * 60_000).toISOString(),
    }));
  socket.on('sessions:list', (_data, callback) => {
    callback({ ok: true, sessions: serializeSessions(false) });
  });
  socket.on('sessions:active', (_data, callback) => {
    callback({ ok: true, sessions: serializeSessions(true) });
  });
  socket.on('sessions:detail', (data, callback) => {
    const session = DEMO_REMOTE_SESSIONS.find(
      (item) => item.sessionId === data.sessionId && item.runner === data.runner
    );
    callback(session ? {
      ok: true,
      entries: [
        {
          id: 'user-0',
          type: 'user_message',
          timestamp: Date.now() - 120_000,
          content: session.firstPrompt,
        },
        {
          id: 'assistant-1',
          type: 'output',
          timestamp: Date.now() - 90_000,
          content: 'I found the relevant execution path and am comparing its concurrency assumptions with the current tests.',
        },
        {
          id: 'tool-2',
          type: 'tool_use',
          timestamp: Date.now() - 60_000,
          content: '',
          toolName: 'Read',
          toolInput: { file_path: `${PROJECT_PATH}/src/inventory/reservations.ts` },
        },
      ],
    } : { ok: false, error: 'Session not found' });
  });
  socket.on('sessions:search', (data, callback) => {
    const query = String(data.query || '').toLowerCase();
    const results = serializeSessions(false)
      .filter((session) => session.firstPrompt.toLowerCase().includes(query))
      .map((session) => ({
        ...session,
        matches: [{
          message: session.firstPrompt,
          entryId: 'user-0',
          context: [],
        }],
        matchedMessage: session.firstPrompt,
        matchedEntryIndex: 0,
        matchedEntryId: 'user-0',
      }));
    callback({ ok: true, results });
  });
  return socket;
}

async function login(page) {
  await page.goto(BASE);
  await page.evaluate((token) => localStorage.setItem('ccm_api_token', token), DEMO_TOKEN);
  await page.reload();
  await page.waitForLoadState('networkidle');
}

async function takeScreenshots(browser, demo) {
  console.log('\n=== Taking screenshots ===');
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await login(page);

  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'projects.png') });

  await page.goto(`${BASE}/project/${demo.projectCommerce}`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'new-conversation.png') });

  await page.getByRole('button', { name: /Implementing idempotent checkout retries/i }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'conversation.png') });

  await page.getByRole('button', { name: 'CLI Sessions' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'cli-sessions.png') });
  await page.getByRole('button', { name: 'Close CLI sessions' }).click();

  await page.goto(`${BASE}/settings`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'settings.png'), fullPage: true });

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  const mobile = await mobileContext.newPage();
  const mobileErrors = [];
  mobile.on('pageerror', (error) => mobileErrors.push(error.message));
  await login(mobile);
  await mobile.screenshot({ path: path.join(SCREENSHOTS_DIR, 'mobile-projects.png') });
  await mobile.goto(`${BASE}/project/${demo.projectCommerce}`);
  await mobile.waitForLoadState('networkidle');
  await mobile.screenshot({ path: path.join(SCREENSHOTS_DIR, 'mobile-conversation.png') });

  if (pageErrors.length || mobileErrors.length) {
    throw new Error(`Browser errors: ${[...pageErrors, ...mobileErrors].join('; ')}`);
  }
  await context.close();
  await mobileContext.close();
}

async function recordDemo(browser, demo) {
  console.log('\n=== Recording demo ===');
  const recordDir = '/tmp/ccm-showcase-recording';
  if (existsSync(recordDir)) rmSync(recordDir, { recursive: true });
  mkdirSync(recordDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: recordDir, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();
  await login(page);
  await page.waitForTimeout(700);

  const firstProject = page.getByRole('link', { name: /commerce-api/i });
  await firstProject.hover();
  await page.waitForTimeout(500);
  await firstProject.click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(900);

  await page.getByRole('button', { name: /Implementing idempotent checkout retries/i }).click();
  await page.waitForTimeout(1600);
  await page.getByRole('button', { name: 'CLI Sessions' }).click();
  await page.waitForTimeout(1400);
  await page.getByRole('button', { name: 'Close CLI sessions' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'New Conversation' }).click();
  await page.waitForTimeout(600);

  const textarea = page.getByPlaceholder('Describe the coding task...');
  await textarea.fill('Add a read-only incident replay endpoint with regression tests');
  await page.waitForTimeout(900);
  await page.getByTitle('Switch coding model').click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: /Claude Grok/i }).click();
  await page.waitForTimeout(700);
  const grokModel = page.getByRole('button', { name: /grok-4\\.6/i });
  if (await grokModel.count()) await grokModel.click();
  await page.waitForTimeout(900);

  const videoPath = await page.video().path();
  await context.close();

  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    execFileSync(ffmpeg, [
      '-y', '-i', videoPath,
      '-vf', 'scale=1280:-2:flags=lanczos',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      path.join(SCREENSHOTS_DIR, 'demo.mp4'),
    ], { stdio: 'pipe' });
    execFileSync(ffmpeg, [
      '-y', '-i', videoPath,
      '-vf', 'fps=10,scale=1120:-1:flags=lanczos,palettegen=max_colors=192:stats_mode=diff',
      '/tmp/ccm-palette.png',
    ], { stdio: 'pipe' });
    execFileSync(ffmpeg, [
      '-y', '-i', videoPath, '-i', '/tmp/ccm-palette.png',
      '-lavfi', 'fps=10,scale=1120:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
      path.join(SCREENSHOTS_DIR, 'demo.gif'),
    ], { stdio: 'pipe' });
    console.log(
      'Demo sizes:',
      `${(statSync(path.join(SCREENSHOTS_DIR, 'demo.mp4')).size / 1024 / 1024).toFixed(1)} MB MP4,`,
      `${(statSync(path.join(SCREENSHOTS_DIR, 'demo.gif')).size / 1024 / 1024).toFixed(1)} MB GIF`
    );
  } catch (error) {
    console.warn('Video conversion skipped:', error instanceof Error ? error.message : error);
  }
}

async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const demo = setupDemoDatabase();
  const server = startDemoServer();
  let demoAgent;
  try {
    await waitForServer();
    demoAgent = await connectDemoAgent();
    const playwright = await loadPlaywright();
    const chromium = playwright.chromium ?? playwright.default?.chromium;
    if (!chromium) throw new Error('Could not load Playwright Chromium');
    const browser = await chromium.launch({ headless: true });
    await takeScreenshots(browser, demo);
    await recordDemo(browser, demo);
    await browser.close();
  } finally {
    demoAgent?.close();
    server.kill('SIGTERM');
    for (const target of [TEMP_DATA, TEMP_HOME, '/tmp/ccm-showcase-recording', '/tmp/ccm-palette.png']) {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    }
  }
  console.log('\nDone:', SCREENSHOTS_DIR);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
