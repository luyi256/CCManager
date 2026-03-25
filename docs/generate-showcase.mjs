#!/usr/bin/env node
/**
 * Generate showcase screenshots and demo GIF for README.
 *
 * Uses a temporary database with fictional demo data — no real project
 * names, paths, or tokens are exposed.
 *
 * Prerequisites: playwright, ffmpeg (~/bin/ffmpeg)
 *
 * Usage:
 *   node docs/generate-showcase.mjs
 */

import { chromium } from 'playwright';
import { execSync, spawn } from 'child_process';
import { mkdirSync, rmSync, existsSync, statSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const TEMP_DATA = '/tmp/ccm-showcase-data';
const DEMO_PORT = 3099;
const BASE = `http://localhost:${DEMO_PORT}`;
const DEMO_TOKEN = 'demo-showcase-token-2024';
const DEMO_TOKEN_HASH = createHash('sha256').update(DEMO_TOKEN).digest('hex');

// ─── Helpers ────────────────────────────────────────────────────────────

/** Return a date string in SQLite datetime format (no 'Z'), because the
 *  frontend does `new Date(iso + 'Z')` which would double-Z an ISO string. */
function sqliteDatetime(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function timeAgo(hours) {
  return sqliteDatetime(new Date(Date.now() - hours * 3600_000));
}

function timeAgoMin(minutes) {
  return sqliteDatetime(new Date(Date.now() - minutes * 60_000));
}

/** ISO string for task_logs timestamps (these go through a different path). */
function logTs(baseMs, offsetMs) {
  return new Date(baseMs + offsetMs).toISOString();
}

// ─── 1. Create temp database with demo data ─────────────────────────────

function setupDemoDatabase() {
  console.log('=== Setting up demo database ===');

  if (existsSync(TEMP_DATA)) rmSync(TEMP_DATA, { recursive: true });
  mkdirSync(TEMP_DATA, { recursive: true });

  const require = createRequire(import.meta.url);
  const Database = require(path.join(ROOT, 'packages/server/node_modules/better-sqlite3'));
  const db = new Database(path.join(TEMP_DATA, 'ccmanager.db'));
  db.pragma('journal_mode = WAL');

  // Schema (mirroring database.ts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      capabilities TEXT DEFAULT '[]', executor TEXT DEFAULT 'local',
      status TEXT DEFAULT 'offline', last_seen TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      agent_id TEXT, project_path TEXT NOT NULL,
      security_mode TEXT DEFAULT 'auto', auth_type TEXT DEFAULT 'oauth',
      created_at TEXT DEFAULT (datetime('now')), last_activity TEXT,
      post_task_hook TEXT, extra_mounts TEXT, enable_worktree INTEGER DEFAULT 0,
      executor TEXT DEFAULT 'local', docker_image TEXT, allowed_paths TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL, prompt TEXT NOT NULL,
      status TEXT DEFAULT 'pending', is_plan_mode INTEGER DEFAULT 0,
      depends_on INTEGER, worktree_branch TEXT,
      created_at TEXT DEFAULT (datetime('now')), started_at TEXT,
      completed_at TEXT, error TEXT, waiting_until TEXT, wait_reason TEXT,
      check_command TEXT, continue_prompt TEXT, git_info TEXT,
      summary TEXT, security_warnings TEXT, pending_permission TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (depends_on) REFERENCES tasks(id)
    );
    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL, timestamp TEXT DEFAULT (datetime('now')),
      type TEXT NOT NULL, content TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
    CREATE TABLE IF NOT EXISTS device_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now')), last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now')), last_used_at TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);
    CREATE INDEX IF NOT EXISTS idx_projects_agent ON projects(agent_id);
    CREATE INDEX IF NOT EXISTS idx_device_tokens_hash ON device_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(token_hash);
  `);

  // ── Device tokens ──
  db.prepare(`INSERT INTO device_tokens (name, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?)`)
    .run('Work Laptop', DEMO_TOKEN_HASH, timeAgo(168), timeAgoMin(5));
  db.prepare(`INSERT INTO device_tokens (name, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?)`)
    .run('iPhone', createHash('sha256').update('fake1').digest('hex'), timeAgo(120), timeAgo(2));
  db.prepare(`INSERT INTO device_tokens (name, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?)`)
    .run('iPad Pro', createHash('sha256').update('fake2').digest('hex'), timeAgo(96), timeAgo(24));

  // ── Agents ──
  const agents = [
    { id: 'dev-server', name: 'Dev Server', caps: '["linux","gpu","docker"]', executor: 'docker', lastSeen: timeAgoMin(1) },
    { id: 'macbook-pro', name: 'MacBook Pro', caps: '["macos"]', executor: 'local', lastSeen: timeAgoMin(3) },
  ];
  const insertAgent = db.prepare(`INSERT INTO agents (id, name, capabilities, executor, status, last_seen) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const a of agents) {
    insertAgent.run(a.id, a.name, a.caps, a.executor, 'online', a.lastSeen);
  }

  // Agent tokens
  for (const a of agents) {
    db.prepare(`INSERT INTO agent_tokens (agent_id, token_hash, created_at) VALUES (?, ?, ?)`)
      .run(a.id, createHash('sha256').update(`agent-token-${a.id}`).digest('hex'), timeAgo(168));
  }

  // ── Projects ──
  const projectAcme = randomUUID();
  const projectDash = randomUUID();
  const projectMobile = randomUUID();

  const insertProject = db.prepare(
    `INSERT INTO projects (id, name, agent_id, project_path, executor, created_at, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  insertProject.run(projectAcme, 'acme-api', 'dev-server', '/home/dev/projects/acme-api', 'docker', timeAgo(336), timeAgoMin(15));
  insertProject.run(projectDash, 'next-dashboard', 'dev-server', '/home/dev/projects/next-dashboard', 'local', timeAgo(240), timeAgo(4));
  insertProject.run(projectMobile, 'mobile-app', 'macbook-pro', '/Users/dev/projects/mobile-app', 'local', timeAgo(168), timeAgo(12));

  // ── Tasks for acme-api (main demo project) ──
  const insertTask = db.prepare(
    `INSERT INTO tasks (project_id, prompt, status, is_plan_mode, created_at, started_at, completed_at, error, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertLog = db.prepare(
    `INSERT INTO task_logs (task_id, timestamp, type, content) VALUES (?, ?, ?, ?)`
  );

  // Completed tasks
  const t1 = insertTask.run(
    projectAcme,
    'Add user authentication with JWT tokens and refresh token rotation',
    'completed', 0,
    timeAgo(72), timeAgo(72), timeAgo(71), null,
    'Implemented JWT auth with access/refresh token rotation. Added login/register endpoints, auth middleware, and token refresh logic. All 24 tests passing.'
  ).lastInsertRowid;

  // Logs for t1
  const t1Base = Date.now() - 72 * 3600_000;
  const logEntries1 = [
    [0, 'output', "I'll implement JWT authentication with refresh token rotation. Let me start by examining the current codebase structure."],
    [3000, 'tool_use', { taskId: Number(t1), id: 'toolu_1', name: 'Read', input: { file_path: '/home/dev/projects/acme-api/src/index.ts' } }],
    [5000, 'tool_use', { taskId: Number(t1), id: 'toolu_2', name: 'Glob', input: { pattern: 'src/**/*.ts' } }],
    [8000, 'output', "I can see the project structure. I'll create the auth module with:\n\n1. **JWT utilities** — token generation, verification, and refresh\n2. **Auth middleware** — protect routes with token validation\n3. **Auth routes** — login, register, and token refresh endpoints"],
    [13000, 'tool_use', { taskId: Number(t1), id: 'toolu_3', name: 'Write', input: { file_path: '/home/dev/projects/acme-api/src/auth/jwt.ts', content: '// JWT utilities...' } }],
    [16000, 'tool_use', { taskId: Number(t1), id: 'toolu_4', name: 'Write', input: { file_path: '/home/dev/projects/acme-api/src/auth/middleware.ts', content: '// Auth middleware...' } }],
    [19000, 'tool_use', { taskId: Number(t1), id: 'toolu_5', name: 'Write', input: { file_path: '/home/dev/projects/acme-api/src/routes/auth.ts', content: '// Auth routes...' } }],
    [22000, 'tool_use', { taskId: Number(t1), id: 'toolu_6', name: 'Edit', input: { file_path: '/home/dev/projects/acme-api/src/index.ts', old_string: '// routes', new_string: 'import authRoutes...' } }],
    [25000, 'tool_use', { taskId: Number(t1), id: 'toolu_7', name: 'Bash', input: { command: 'npm test -- --coverage', description: 'Run tests with coverage' } }],
    [30000, 'output', "All tests pass. Here's what I implemented:\n\n- **`src/auth/jwt.ts`** — `generateAccessToken()`, `generateRefreshToken()`, `verifyToken()`, `rotateRefreshToken()`\n- **`src/auth/middleware.ts`** — Express middleware that validates JWT from Authorization header\n- **`src/routes/auth.ts`** — `POST /auth/login`, `POST /auth/register`, `POST /auth/refresh`\n\nRefresh tokens are stored in the database with a rotation mechanism — each refresh invalidates the previous token and issues a new pair."],
  ];
  for (const [offset, type, content] of logEntries1) {
    insertLog.run(Number(t1), new Date(t1Base + offset).toISOString(), type, JSON.stringify(typeof content === 'string' ? content : content));
  }

  const t2 = insertTask.run(
    projectAcme,
    'Fix the race condition in the WebSocket reconnection handler that causes duplicate messages',
    'completed', 0,
    timeAgo(48), timeAgo(48), timeAgo(47), null,
    'Fixed race condition by adding a connection lock and deduplication queue. Messages are now idempotent with unique IDs.'
  ).lastInsertRowid;

  // Logs for t2
  const t2Base = Date.now() - 48 * 3600_000;
  const logEntries2 = [
    [0, 'output', "I'll investigate the WebSocket reconnection handler to find and fix the race condition causing duplicate messages."],
    [2000, 'tool_use', { taskId: Number(t2), id: 'toolu_g1', name: 'Grep', input: { pattern: 'reconnect', path: 'src/', type: 'ts' } }],
    [4000, 'tool_use', { taskId: Number(t2), id: 'toolu_r1', name: 'Read', input: { file_path: '/home/dev/projects/acme-api/src/websocket/handler.ts' } }],
    [7000, 'output', "Found the issue. When the WebSocket reconnects, `setupListeners()` is called again without cleaning up the previous listeners.\n\nI'll fix by:\n1. Adding a connection lock to prevent concurrent reconnection attempts\n2. Properly cleaning up listeners before re-registering\n3. Adding message deduplication with unique IDs"],
    [12000, 'tool_use', { taskId: Number(t2), id: 'toolu_e1', name: 'Edit', input: { file_path: '/home/dev/projects/acme-api/src/websocket/handler.ts', old_string: 'function reconnect()', new_string: 'function reconnect() // with lock' } }],
    [15000, 'tool_use', { taskId: Number(t2), id: 'toolu_b1', name: 'Bash', input: { command: 'npm test src/websocket/', description: 'Run WebSocket tests' } }],
    [19000, 'output', "Fixed the race condition. The reconnection handler now uses a mutex lock and messages include unique IDs for deduplication. All WebSocket tests pass."],
  ];
  for (const [offset, type, content] of logEntries2) {
    insertLog.run(Number(t2), new Date(t2Base + offset).toISOString(), type, JSON.stringify(content));
  }

  // Completed with warnings
  const t3 = insertTask.run(
    projectAcme,
    'Refactor the database layer to use connection pooling and add query performance logging',
    'completed_with_warnings', 0,
    timeAgo(24), timeAgo(24), timeAgo(23), null,
    'Refactored DB layer with connection pooling (max 10 connections). Added query timing logs. Warning: 3 slow queries detected (>500ms) that may need index optimization.'
  ).lastInsertRowid;

  const t3Base = Date.now() - 24 * 3600_000;
  const logEntries3 = [
    [0, 'output', "I'll refactor the database layer to add connection pooling and query performance logging."],
    [3000, 'tool_use', { taskId: Number(t3), id: 'toolu_rdb', name: 'Read', input: { file_path: '/home/dev/projects/acme-api/src/database/connection.ts' } }],
    [6000, 'tool_use', { taskId: Number(t3), id: 'toolu_edb', name: 'Edit', input: { file_path: '/home/dev/projects/acme-api/src/database/connection.ts', old_string: 'new Database()', new_string: 'new ConnectionPool()' } }],
    [10000, 'tool_use', { taskId: Number(t3), id: 'toolu_wql', name: 'Write', input: { file_path: '/home/dev/projects/acme-api/src/database/queryLogger.ts', content: '// Query perf logger...' } }],
    [14000, 'output', "Refactored the database layer with connection pooling (max 10 connections). Added query timing logs.\n\n**Warning**: Found 3 queries taking >500ms that may need index optimization:\n- `SELECT * FROM users WHERE email = ?` (avg 620ms)\n- `SELECT * FROM orders JOIN products ON ...` (avg 890ms)\n- `SELECT COUNT(*) FROM audit_logs WHERE ...` (avg 510ms)"],
  ];
  for (const [offset, type, content] of logEntries3) {
    insertLog.run(Number(t3), new Date(t3Base + offset).toISOString(), type, JSON.stringify(content));
  }

  // Running task
  const t4 = insertTask.run(
    projectAcme,
    'Set up CI/CD pipeline with GitHub Actions for automated testing and deployment',
    'running', 0,
    timeAgoMin(45), timeAgoMin(44), null, null, null
  ).lastInsertRowid;

  const t4Base = Date.now() - 44 * 60_000;
  const logEntries4 = [
    [0, 'output', "I'll set up a complete CI/CD pipeline with GitHub Actions. Let me first check the project configuration."],
    [2000, 'tool_use', { taskId: Number(t4), id: 'toolu_rp', name: 'Read', input: { file_path: '/home/dev/projects/acme-api/package.json' } }],
    [4000, 'tool_use', { taskId: Number(t4), id: 'toolu_gc', name: 'Glob', input: { pattern: '.github/**/*' } }],
    [7000, 'output', "No existing CI configuration found. I'll create workflows for:\n1. **CI** — lint, typecheck, and test on every PR\n2. **CD** — build and deploy on merge to main"],
    [10000, 'tool_use', { taskId: Number(t4), id: 'toolu_wci', name: 'Write', input: { file_path: '/home/dev/projects/acme-api/.github/workflows/ci.yml', content: '# CI workflow...' } }],
    [13000, 'output', "Created the CI workflow. Now setting up the deployment pipeline..."],
    [15000, 'tool_use', { taskId: Number(t4), id: 'toolu_wcd', name: 'Write', input: { file_path: '/home/dev/projects/acme-api/.github/workflows/deploy.yml', content: '# Deploy workflow...' } }],
    [18000, 'tool_use', { taskId: Number(t4), id: 'toolu_bt2', name: 'Bash', input: { command: 'npm test -- --coverage', description: 'Run full test suite' } }],
  ];
  for (const [offset, type, content] of logEntries4) {
    insertLog.run(Number(t4), new Date(t4Base + offset).toISOString(), type, JSON.stringify(content));
  }

  // Pending tasks
  insertTask.run(
    projectAcme,
    'Implement rate limiting middleware with Redis-backed sliding window counter',
    'pending', 1,
    timeAgoMin(10), null, null, null, null
  );
  insertTask.run(
    projectAcme,
    'Add comprehensive API documentation using OpenAPI 3.0 spec with Swagger UI',
    'pending', 0,
    timeAgoMin(5), null, null, null, null
  );

  // Failed task
  insertTask.run(
    projectAcme,
    'Write integration tests for the payment processing module',
    'failed', 0,
    timeAgo(6), timeAgo(6), timeAgo(5),
    'Stripe test API key not configured. Set STRIPE_TEST_KEY environment variable.',
    null
  );

  // ── Tasks for next-dashboard (secondary project) ──
  insertTask.run(
    projectDash,
    'Build responsive dashboard layout with sidebar navigation and dark mode toggle',
    'completed', 0,
    timeAgo(96), timeAgo(96), timeAgo(95), null,
    'Created responsive dashboard with collapsible sidebar, breadcrumb navigation, and dark mode toggle using next-themes.'
  );
  insertTask.run(
    projectDash,
    'Add real-time data charts with WebSocket updates using Recharts',
    'completed', 0,
    timeAgo(72), timeAgo(72), timeAgo(71), null,
    'Implemented 4 chart components (line, bar, pie, area) with live WebSocket data feeds. Auto-refreshes every 5 seconds.'
  );
  insertTask.run(
    projectDash,
    'Implement user role-based access control for admin pages',
    'running', 0,
    timeAgoMin(30), timeAgoMin(29), null, null, null
  );
  insertTask.run(
    projectDash,
    'Add CSV/PDF export functionality for all data tables',
    'pending', 0,
    timeAgoMin(5), null, null, null, null
  );

  // ── Tasks for mobile-app ──
  insertTask.run(
    projectMobile,
    'Set up React Native project with TypeScript and navigation',
    'completed', 0,
    timeAgo(120), timeAgo(120), timeAgo(119), null,
    'Initialized React Native project with TypeScript, React Navigation (stack + bottom tabs), and configured ESLint + Prettier.'
  );
  insertTask.run(
    projectMobile,
    'Implement push notifications with Firebase Cloud Messaging',
    'completed_with_warnings', 0,
    timeAgo(48), timeAgo(48), timeAgo(47), null,
    'Push notifications working on both platforms. Warning: iOS requires manual APNs certificate renewal before expiry on 2025-06-15.'
  );
  insertTask.run(
    projectMobile,
    'Add biometric authentication (Face ID / fingerprint)',
    'pending', 0,
    timeAgo(1), null, null, null, null
  );

  db.close();
  console.log('Demo database created at:', path.join(TEMP_DATA, 'ccmanager.db'));
  console.log(`Projects: acme-api (${projectAcme}), next-dashboard (${projectDash}), mobile-app (${projectMobile})`);
  return { projectAcme, projectDash, projectMobile };
}

// ─── 2. Start temp server ────────────────────────────────────────────────

function startDemoServer() {
  console.log('\n=== Starting demo server on port', DEMO_PORT, '===');
  const serverPath = path.join(ROOT, 'packages/server/dist/index.js');
  const staticPath = path.join(ROOT, 'packages/web/dist');

  const server = spawn('node', [serverPath], {
    env: {
      ...process.env,
      DATA_PATH: TEMP_DATA,
      PORT: String(DEMO_PORT),
      SERVE_STATIC: 'true',
      STATIC_PATH: staticPath,
      NODE_ENV: 'production',
    },
    stdio: 'pipe',
  });

  server.stderr.on('data', (d) => {
    const msg = d.toString();
    if (!msg.includes('Migration')) process.stderr.write(`[server] ${msg}`);
  });

  return server;
}

async function waitForServer(maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) { console.log('Server is ready'); return; }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Server did not start in time');
}

// ─── 3. Playwright: Screenshots + GIF ────────────────────────────────────

async function login(page) {
  await page.goto(BASE);
  await page.waitForTimeout(500);
  await page.evaluate((token) => {
    localStorage.setItem('ccm_api_token', token);
  }, DEMO_TOKEN);
  await page.reload();
  await page.waitForTimeout(2500);
}

async function takeScreenshots(browser) {
  console.log('\n=== Taking screenshots ===');
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await login(page);

  // Home page
  console.log('Screenshot: home');
  await page.screenshot({ path: `${SCREENSHOTS_DIR}/home.png` });

  // Navigate to acme-api (first project card)
  const projectLink = await page.$('a[href*="/project/"]');
  if (projectLink) {
    await projectLink.click();
    await page.waitForTimeout(3000);
  }

  // Task board — scroll to show all columns
  const board = await page.$('.overflow-x-auto');
  if (board) {
    await board.evaluate(el => { el.scrollLeft = 0; });
    await page.waitForTimeout(1000);
  }
  console.log('Screenshot: task-board');
  await page.screenshot({ path: `${SCREENSHOTS_DIR}/task-board.png` });

  // Task detail — click JWT auth completed task
  const cards = await page.$$('.cursor-pointer');
  for (const card of cards) {
    const text = await card.textContent();
    if (text?.includes('JWT') || text?.includes('user authentication')) {
      await card.click();
      break;
    }
  }
  await page.waitForTimeout(2500);
  console.log('Screenshot: task-detail');
  await page.screenshot({ path: `${SCREENSHOTS_DIR}/task-detail.png` });

  // Settings page
  await page.goto(`${BASE}/settings`);
  await page.waitForTimeout(2000);
  console.log('Screenshot: settings');
  await page.screenshot({ path: `${SCREENSHOTS_DIR}/settings.png` });

  // Mobile screenshots
  console.log('Taking mobile screenshots...');
  const mobileCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const mobilePage = await mobileCtx.newPage();
  await login(mobilePage);

  console.log('Screenshot: mobile-home');
  await mobilePage.screenshot({ path: `${SCREENSHOTS_DIR}/mobile-home.png` });

  const mobileLink = await mobilePage.$('a[href*="/project/"]');
  if (mobileLink) {
    await mobileLink.click();
    await mobilePage.waitForTimeout(3000);
    console.log('Screenshot: mobile-task-board');
    await mobilePage.screenshot({ path: `${SCREENSHOTS_DIR}/mobile-task-board.png` });
  }

  await ctx.close();
  await mobileCtx.close();
}

async function recordGif(browser) {
  console.log('\n=== Recording GIF ===');
  const recordDir = '/tmp/ccm-showcase-recording/';
  if (existsSync(recordDir)) rmSync(recordDir, { recursive: true });
  mkdirSync(recordDir, { recursive: true });

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    recordVideo: { dir: recordDir, size: { width: 1280, height: 800 } },
  });
  const page = await ctx.newPage();
  await login(page);

  // Scene 1: Home page overview (2.5s)
  console.log('Scene 1: Home page');
  await page.waitForTimeout(2500);

  // Scene 2: Click into acme-api project
  console.log('Scene 2: Navigate to project');
  const link = await page.$('a[href*="/project/"]');
  if (link) await link.click();
  await page.waitForTimeout(3000);

  // Scene 3: Show all columns
  console.log('Scene 3: Task board');
  const board = await page.$('.overflow-x-auto');
  if (board) {
    await board.evaluate(el => { el.scrollLeft = 0; });
    await page.waitForTimeout(2000);
  }

  // Scene 4: Click completed task to show detail panel
  console.log('Scene 4: Task detail');
  const cards = await page.$$('.cursor-pointer');
  for (const card of cards) {
    const text = await card.textContent();
    if (text?.includes('JWT') || text?.includes('user authentication')) {
      await card.click();
      break;
    }
  }
  await page.waitForTimeout(4000);

  // Scene 5: Close detail panel by clicking the backdrop overlay
  console.log('Scene 5: Close detail');
  const backdrop = await page.$('.backdrop-blur-sm');
  if (backdrop) {
    await backdrop.click({ force: true });
  } else {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(1500);

  // Ensure overlay is fully gone
  await page.evaluate(() => {
    document.querySelectorAll('.backdrop-blur-sm').forEach(el => el.remove());
  });
  await page.waitForTimeout(500);

  console.log('Scene 6: Type new task');
  const textarea = await page.$('textarea');
  if (textarea) {
    await textarea.click({ force: true });
    await page.waitForTimeout(500);
    await page.keyboard.type('Add dark mode with system preference detection', { delay: 45 });
    await page.waitForTimeout(2000);
  }

  // End pause
  await page.waitForTimeout(1500);

  const videoPath = await page.video().path();
  await ctx.close();
  console.log('Video saved:', videoPath);

  // Convert to GIF
  console.log('Converting to GIF...');
  const ffmpeg = process.env.FFMPEG_PATH || `${process.env.HOME}/bin/ffmpeg`;
  try {
    execSync(
      `${ffmpeg} -y -ss 2 -i "${videoPath}" -vf "fps=10,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" /tmp/ccm-palette.png`,
      { stdio: 'pipe' }
    );
    execSync(
      `${ffmpeg} -y -ss 2 -i "${videoPath}" -i /tmp/ccm-palette.png -lavfi "fps=10,scale=960:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" "${SCREENSHOTS_DIR}/demo.gif"`,
      { stdio: 'pipe' }
    );
    const stats = statSync(`${SCREENSHOTS_DIR}/demo.gif`);
    console.log('GIF size:', (stats.size / 1024 / 1024).toFixed(1), 'MB');
  } catch (e) {
    console.error('GIF conversion failed:', e.stderr?.toString().slice(-300));
  }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const projects = setupDemoDatabase();
  const server = startDemoServer();

  try {
    await waitForServer();

    const browser = await chromium.launch({ headless: true });
    await takeScreenshots(browser);
    await recordGif(browser);
    await browser.close();
  } finally {
    server.kill();
    // Cleanup
    if (existsSync(TEMP_DATA)) rmSync(TEMP_DATA, { recursive: true });
    if (existsSync('/tmp/ccm-showcase-recording')) rmSync('/tmp/ccm-showcase-recording', { recursive: true });
    if (existsSync('/tmp/ccm-palette.png')) rmSync('/tmp/ccm-palette.png');
    console.log('\nCleaned up temp files.');
  }

  console.log('\nDone! Screenshots and GIF saved to:', SCREENSHOTS_DIR);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
