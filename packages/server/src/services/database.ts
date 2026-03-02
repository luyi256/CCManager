import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_PATH || path.resolve(process.cwd(), '../../data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'ccmanager.db');

export const db: DatabaseType = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Initialize schema
db.exec(`
  -- Global config table
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Agents table
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    capabilities TEXT DEFAULT '[]',
    executor TEXT DEFAULT 'local',
    status TEXT DEFAULT 'offline',
    last_seen TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Projects table
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    agent_id TEXT,
    project_path TEXT NOT NULL,
    security_mode TEXT DEFAULT 'auto',
    auth_type TEXT DEFAULT 'oauth',
    created_at TEXT DEFAULT (datetime('now')),
    last_activity TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  -- Tasks table
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    is_plan_mode INTEGER DEFAULT 0,
    depends_on INTEGER,
    worktree_branch TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    waiting_until TEXT,
    wait_reason TEXT,
    check_command TEXT,
    continue_prompt TEXT,
    git_info TEXT,
    summary TEXT,
    security_warnings TEXT,
    pending_permission TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (depends_on) REFERENCES tasks(id)
  );

  -- Task logs table
  CREATE TABLE IF NOT EXISTS task_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')),
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );

  -- Create indexes
  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);
  CREATE INDEX IF NOT EXISTS idx_projects_agent ON projects(agent_id);
`);

// Migrations
// Add post_task_hook column to projects table
try {
  db.exec(`ALTER TABLE projects ADD COLUMN post_task_hook TEXT`);
  console.log('Migration: Added post_task_hook column to projects table');
} catch {
  // Column already exists, ignore
}

// Add extra_mounts column to projects table
try {
  db.exec(`ALTER TABLE projects ADD COLUMN extra_mounts TEXT`);
  console.log('Migration: Added extra_mounts column to projects table');
} catch {
  // Column already exists, ignore
}

console.log('Database initialized at:', DB_PATH);
