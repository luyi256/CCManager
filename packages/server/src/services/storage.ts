import { db } from './database.js';
import type { Project, Task, GlobalConfig, Agent } from '../types/index.js';

// Global Config
export async function getConfig(): Promise<GlobalConfig> {
  const stmt = db.prepare('SELECT key, value FROM config');
  const rows = stmt.all() as Array<{ key: string; value: string }>;

  const config: GlobalConfig = {
    defaultAuthType: 'oauth',
    defaultSecurityMode: 'auto',
  };

  for (const row of rows) {
    (config as unknown as Record<string, unknown>)[row.key] = row.value;
  }

  return config;
}

// Allowed configuration keys to prevent arbitrary key injection
const ALLOWED_CONFIG_KEYS = new Set([
  'defaultAuthType',
  'defaultSecurityMode',
  'oauthToken',
  'anthropicApiKey',
  'updatedAt',
]);

export async function updateConfig(data: Partial<GlobalConfig>): Promise<GlobalConfig> {
  const stmt = db.prepare(`
    INSERT INTO config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      // Validate key is in allowed list
      if (!ALLOWED_CONFIG_KEYS.has(key)) {
        console.warn(`Attempted to set invalid config key: ${key}`);
        continue;
      }
      stmt.run(key, String(value));
    }
  }

  return getConfig();
}

// Agents
export async function getAgents(): Promise<Agent[]> {
  const stmt = db.prepare('SELECT * FROM agents ORDER BY name');
  const rows = stmt.all() as Array<{
    id: string;
    name: string;
    capabilities: string;
    executor: string;
    status: string;
    last_seen: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    capabilities: safeJsonParse<string[]>(row.capabilities, []) ?? [],
    executor: row.executor as 'local' | 'docker',
    status: row.status as 'online' | 'offline' | 'busy',
    lastSeen: row.last_seen || undefined,
  }));
}

export async function getAgent(agentId: string): Promise<Agent | null> {
  const stmt = db.prepare('SELECT * FROM agents WHERE id = ?');
  const row = stmt.get(agentId) as {
    id: string;
    name: string;
    capabilities: string;
    executor: string;
    status: string;
    last_seen: string | null;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    capabilities: safeJsonParse<string[]>(row.capabilities, []) ?? [],
    executor: row.executor as 'local' | 'docker',
    status: row.status as 'online' | 'offline' | 'busy',
    lastSeen: row.last_seen || undefined,
  };
}

// Projects
export async function getProjects(): Promise<Project[]> {
  const stmt = db.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count,
           (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND status IN ('running', 'waiting', 'waiting_permission', 'plan_review')) as running_count
    FROM projects p
    ORDER BY p.last_activity DESC NULLS LAST
  `);
  const rows = stmt.all() as Array<{
    id: string;
    name: string;
    agent_id: string;
    project_path: string;
    security_mode: string;
    auth_type: string;
    executor: string | null;
    docker_image: string | null;
    post_task_hook: string | null;
    extra_mounts: string | null;
    enable_worktree: number;
    allowed_paths: string | null;
    created_at: string;
    last_activity: string | null;
    task_count: number;
    running_count: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    projectPath: row.project_path,
    securityMode: row.security_mode as 'auto' | 'safe',
    authType: row.auth_type as 'oauth' | 'apikey',
    executor: (row.executor as 'local' | 'docker') || 'local',
    dockerImage: row.docker_image || undefined,
    postTaskHook: row.post_task_hook || undefined,
    extraMounts: safeJsonParse(row.extra_mounts),
    enableWorktree: row.enable_worktree === 1,
    allowedPaths: safeJsonParse(row.allowed_paths),
    createdAt: row.created_at,
    lastActivity: row.last_activity || undefined,
    taskCount: row.task_count,
    runningCount: row.running_count,
  }));
}

export async function getProject(projectId: string): Promise<Project | null> {
  const stmt = db.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count,
           (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND status IN ('running', 'waiting', 'waiting_permission', 'plan_review')) as running_count
    FROM projects p
    WHERE p.id = ?
  `);
  const row = stmt.get(projectId) as {
    id: string;
    name: string;
    agent_id: string;
    project_path: string;
    security_mode: string;
    auth_type: string;
    executor: string | null;
    docker_image: string | null;
    post_task_hook: string | null;
    extra_mounts: string | null;
    enable_worktree: number;
    allowed_paths: string | null;
    created_at: string;
    last_activity: string | null;
    task_count: number;
    running_count: number;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    projectPath: row.project_path,
    securityMode: row.security_mode as 'auto' | 'safe',
    authType: row.auth_type as 'oauth' | 'apikey',
    executor: (row.executor as 'local' | 'docker') || 'local',
    dockerImage: row.docker_image || undefined,
    postTaskHook: row.post_task_hook || undefined,
    extraMounts: safeJsonParse(row.extra_mounts),
    enableWorktree: row.enable_worktree === 1,
    allowedPaths: safeJsonParse(row.allowed_paths),
    createdAt: row.created_at,
    lastActivity: row.last_activity || undefined,
    taskCount: row.task_count,
    runningCount: row.running_count,
  };
}

export async function saveProject(project: Omit<Project, 'taskCount' | 'runningCount'>): Promise<void> {
  const stmt = db.prepare(`
    INSERT INTO projects (id, name, agent_id, project_path, security_mode, auth_type, executor, docker_image, post_task_hook, extra_mounts, enable_worktree, allowed_paths, created_at, last_activity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      agent_id = excluded.agent_id,
      project_path = excluded.project_path,
      security_mode = excluded.security_mode,
      auth_type = excluded.auth_type,
      executor = excluded.executor,
      docker_image = excluded.docker_image,
      post_task_hook = excluded.post_task_hook,
      extra_mounts = excluded.extra_mounts,
      enable_worktree = excluded.enable_worktree,
      allowed_paths = excluded.allowed_paths,
      last_activity = excluded.last_activity
  `);
  stmt.run(
    project.id,
    project.name,
    project.agentId,
    project.projectPath,
    project.securityMode,
    project.authType || 'oauth',
    project.executor || 'local',
    project.dockerImage || null,
    project.postTaskHook || null,
    project.extraMounts ? JSON.stringify(project.extraMounts) : null,
    project.enableWorktree ? 1 : 0,
    project.allowedPaths?.length ? JSON.stringify(project.allowedPaths) : null,
    project.createdAt,
    project.lastActivity || null
  );
}

export async function deleteProject(projectId: string): Promise<void> {
  // Delete task logs first
  db.prepare('DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)').run(projectId);
  // Delete tasks
  db.prepare('DELETE FROM tasks WHERE project_id = ?').run(projectId);
  // Delete project
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
}

// Tasks
export async function getTasks(projectId: string): Promise<Task[]> {
  const stmt = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY id DESC');
  const rows = stmt.all(projectId) as Array<{
    id: number;
    project_id: string;
    prompt: string;
    status: string;
    is_plan_mode: number;
    depends_on: number | null;
    worktree_branch: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    error: string | null;
    waiting_until: string | null;
    wait_reason: string | null;
    check_command: string | null;
    continue_prompt: string | null;
    git_info: string | null;
    summary: string | null;
    security_warnings: string | null;
    pending_permission: string | null;
  }>;

  return rows.map(rowToTask);
}

export async function getTask(projectId: string, taskId: number): Promise<Task | null> {
  const stmt = db.prepare('SELECT * FROM tasks WHERE project_id = ? AND id = ?');
  const row = stmt.get(projectId, taskId);
  if (!row) return null;
  return rowToTask(row as Parameters<typeof rowToTask>[0]);
}

export async function getTaskById(taskId: number): Promise<Task | null> {
  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const row = stmt.get(taskId);
  if (!row) return null;
  return rowToTask(row as Parameters<typeof rowToTask>[0]);
}

// Get all running tasks for a specific agent (for recovery after restart)
export async function getRunningTasksForAgent(agentId: string): Promise<Array<{ task: Task; project: Project }>> {
  const stmt = db.prepare(`
    SELECT t.*, p.id as p_id, p.name as p_name, p.agent_id, p.project_path, p.security_mode, p.auth_type, p.post_task_hook, p.extra_mounts, p.allowed_paths
    FROM tasks t
    JOIN projects p ON t.project_id = p.id
    WHERE p.agent_id = ? AND t.status = 'running'
    ORDER BY t.id ASC
  `);
  const rows = stmt.all(agentId) as Array<{
    id: number;
    project_id: string;
    prompt: string;
    status: string;
    is_plan_mode: number;
    depends_on: number | null;
    worktree_branch: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    error: string | null;
    waiting_until: string | null;
    wait_reason: string | null;
    check_command: string | null;
    continue_prompt: string | null;
    git_info: string | null;
    summary: string | null;
    security_warnings: string | null;
    pending_permission: string | null;
    p_id: string;
    p_name: string;
    agent_id: string;
    project_path: string;
    security_mode: string;
    auth_type: string;
    post_task_hook: string | null;
    extra_mounts: string | null;
    allowed_paths: string | null;
  }>;

  return rows.map(row => ({
    task: rowToTask(row),
    project: {
      id: row.p_id,
      name: row.p_name,
      agentId: row.agent_id,
      projectPath: row.project_path,
      securityMode: row.security_mode as 'auto' | 'safe',
      authType: row.auth_type as 'oauth' | 'apikey',
      postTaskHook: row.post_task_hook || undefined,
      extraMounts: safeJsonParse(row.extra_mounts),
      enableWorktree: (row as unknown as { enable_worktree: number }).enable_worktree === 1,
      allowedPaths: safeJsonParse(row.allowed_paths),
      createdAt: '',
      taskCount: 0,
      runningCount: 0,
    }
  }));
}

// Safe JSON parse with fallback (Bug #16 fix)
function safeJsonParse<T>(value: string | null, fallback: T | undefined = undefined): T | undefined {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.error('Failed to parse JSON:', error, 'Value:', value);
    return fallback;
  }
}

function rowToTask(row: {
  id: number;
  project_id: string;
  prompt: string;
  status: string;
  is_plan_mode: number;
  depends_on: number | null;
  worktree_branch: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  waiting_until: string | null;
  wait_reason: string | null;
  check_command: string | null;
  continue_prompt: string | null;
  git_info: string | null;
  summary: string | null;
  security_warnings: string | null;
  pending_permission: string | null;
}): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    prompt: row.prompt,
    status: row.status as Task['status'],
    isPlanMode: row.is_plan_mode === 1,
    dependsOn: row.depends_on || undefined,
    worktreeBranch: row.worktree_branch || undefined,
    createdAt: row.created_at,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    error: row.error || undefined,
    waitingUntil: row.waiting_until || undefined,
    waitReason: row.wait_reason || undefined,
    checkCommand: row.check_command || undefined,
    continuePrompt: row.continue_prompt || undefined,
    git: safeJsonParse(row.git_info),
    gitInfo: row.git_info || undefined,
    summary: row.summary || undefined,
    securityWarnings: safeJsonParse(row.security_warnings),
    pendingPermission: safeJsonParse(row.pending_permission),
  };
}

export async function saveTask(projectId: string, task: Task): Promise<void> {
  const stmt = db.prepare(`
    INSERT INTO tasks (
      id, project_id, prompt, status, is_plan_mode, depends_on, worktree_branch,
      created_at, started_at, completed_at, error, waiting_until, wait_reason,
      check_command, continue_prompt, git_info, summary, security_warnings, pending_permission
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      error = excluded.error,
      waiting_until = excluded.waiting_until,
      wait_reason = excluded.wait_reason,
      check_command = excluded.check_command,
      continue_prompt = excluded.continue_prompt,
      git_info = excluded.git_info,
      summary = excluded.summary,
      security_warnings = excluded.security_warnings,
      pending_permission = excluded.pending_permission
  `);
  stmt.run(
    task.id,
    projectId,
    task.prompt,
    task.status,
    task.isPlanMode ? 1 : 0,
    task.dependsOn || null,
    task.worktreeBranch || null,
    task.createdAt,
    task.startedAt || null,
    task.completedAt || null,
    task.error || null,
    task.waitingUntil || null,
    task.waitReason || null,
    task.checkCommand || null,
    task.continuePrompt || null,
    task.gitInfo || (task.git ? JSON.stringify(task.git) : null),
    task.summary || null,
    task.securityWarnings ? JSON.stringify(task.securityWarnings) : null,
    task.pendingPermission ? JSON.stringify(task.pendingPermission) : null
  );

  // Update project last_activity
  db.prepare(`UPDATE projects SET last_activity = datetime('now') WHERE id = ?`).run(projectId);
}

export async function createTask(projectId: string, task: Omit<Task, 'id'>): Promise<Task> {
  const stmt = db.prepare(`
    INSERT INTO tasks (
      project_id, prompt, status, is_plan_mode, depends_on, worktree_branch,
      created_at, started_at, completed_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    projectId,
    task.prompt,
    task.status,
    task.isPlanMode ? 1 : 0,
    task.dependsOn || null,
    task.worktreeBranch || null,
    task.createdAt,
    task.startedAt || null,
    task.completedAt || null,
    task.error || null
  );

  // Update project last_activity
  db.prepare(`UPDATE projects SET last_activity = datetime('now') WHERE id = ?`).run(projectId);

  return {
    ...task,
    id: Number(result.lastInsertRowid),
  };
}

export async function getNextTaskId(projectId: string): Promise<number> {
  const stmt = db.prepare('SELECT MAX(id) as max_id FROM tasks WHERE project_id = ?');
  const row = stmt.get(projectId) as { max_id: number | null };
  return (row.max_id || 0) + 1;
}

// Task Logs
export async function appendTaskLog(
  projectId: string,
  taskId: number,
  entry: { type: string; content: unknown }
): Promise<void> {
  const stmt = db.prepare(`
    INSERT INTO task_logs (task_id, timestamp, type, content)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(taskId, new Date().toISOString(), entry.type, JSON.stringify(entry.content));
}

export async function getTaskLogs(
  projectId: string,
  taskId: number
): Promise<Array<{ timestamp: string; type: string; content: unknown }>> {
  const stmt = db.prepare('SELECT * FROM task_logs WHERE task_id = ? ORDER BY id');
  const rows = stmt.all(taskId) as Array<{
    timestamp: string;
    type: string;
    content: string;
  }>;

  return rows.map((row) => ({
    timestamp: row.timestamp,
    type: row.type,
    content: safeJsonParse(row.content, row.content),
  }));
}

// Device Tokens
export interface DeviceToken {
  id: number;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function findDeviceByHash(tokenHash: string): DeviceToken | null {
  const stmt = db.prepare('SELECT * FROM device_tokens WHERE token_hash = ?');
  const row = stmt.get(tokenHash) as {
    id: number;
    name: string;
    token_hash: string;
    created_at: string;
    last_used_at: string | null;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function createDevice(name: string, tokenHash: string): DeviceToken {
  const stmt = db.prepare(`
    INSERT INTO device_tokens (name, token_hash)
    VALUES (?, ?)
  `);
  const result = stmt.run(name, tokenHash);
  return {
    id: Number(result.lastInsertRowid),
    name,
    tokenHash,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
}

export function listDevices(): DeviceToken[] {
  const stmt = db.prepare('SELECT * FROM device_tokens ORDER BY created_at DESC');
  const rows = stmt.all() as Array<{
    id: number;
    name: string;
    token_hash: string;
    created_at: string;
    last_used_at: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

export function deleteDevice(id: number): boolean {
  const result = db.prepare('DELETE FROM device_tokens WHERE id = ?').run(id);
  return result.changes > 0;
}

// In-memory debounce map: tokenHash → last update timestamp
const lastUsedUpdateMap = new Map<string, number>();
const LAST_USED_DEBOUNCE_MS = 60_000; // 60 seconds

export function updateDeviceLastUsed(tokenHash: string): void {
  const now = Date.now();
  const lastUpdate = lastUsedUpdateMap.get(tokenHash);
  if (lastUpdate && now - lastUpdate < LAST_USED_DEBOUNCE_MS) return;
  lastUsedUpdateMap.set(tokenHash, now);
  db.prepare(`UPDATE device_tokens SET last_used_at = datetime('now') WHERE token_hash = ?`).run(tokenHash);
}

// Agent Tokens (per-agent authentication)
export interface AgentToken {
  id: number;
  agentId: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function findAgentTokenByHash(tokenHash: string): AgentToken | null {
  const stmt = db.prepare('SELECT * FROM agent_tokens WHERE token_hash = ?');
  const row = stmt.get(tokenHash) as {
    id: number;
    agent_id: string;
    token_hash: string;
    created_at: string;
    last_used_at: string | null;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function createAgentToken(agentId: string, tokenHash: string): AgentToken {
  // Delete existing token for this agent first
  db.prepare('DELETE FROM agent_tokens WHERE agent_id = ?').run(agentId);
  const stmt = db.prepare(`
    INSERT INTO agent_tokens (agent_id, token_hash)
    VALUES (?, ?)
  `);
  const result = stmt.run(agentId, tokenHash);
  return {
    id: Number(result.lastInsertRowid),
    agentId,
    tokenHash,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
}

export function getAgentTokenInfo(agentId: string): { hasToken: boolean; createdAt?: string; lastUsedAt?: string | null } {
  const stmt = db.prepare('SELECT created_at, last_used_at FROM agent_tokens WHERE agent_id = ?');
  const row = stmt.get(agentId) as { created_at: string; last_used_at: string | null } | undefined;
  if (!row) return { hasToken: false };
  return {
    hasToken: true,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function deleteAgentToken(agentId: string): boolean {
  const result = db.prepare('DELETE FROM agent_tokens WHERE agent_id = ?').run(agentId);
  return result.changes > 0;
}

const agentTokenLastUsedMap = new Map<string, number>();

export function updateAgentTokenLastUsed(tokenHash: string): void {
  const now = Date.now();
  const lastUpdate = agentTokenLastUsedMap.get(tokenHash);
  if (lastUpdate && now - lastUpdate < LAST_USED_DEBOUNCE_MS) return;
  agentTokenLastUsedMap.set(tokenHash, now);
  db.prepare(`UPDATE agent_tokens SET last_used_at = datetime('now') WHERE token_hash = ?`).run(tokenHash);
}

// For backward compatibility, these are no longer needed but kept as stubs
export async function getProjectIndex(): Promise<{ projects: Array<{ id: string; name: string; agentId: string }>; updatedAt?: string }> {
  const projects = await getProjects();
  return {
    projects: projects.map((p) => ({ id: p.id, name: p.name, agentId: p.agentId })),
    updatedAt: new Date().toISOString(),
  };
}

export async function getTasksFile(projectId: string): Promise<{ projectId: string; tasks: Task[] }> {
  const tasks = await getTasks(projectId);
  return { projectId, tasks };
}

export async function saveTasksFile(projectId: string, tasksFile: { tasks: Task[] }): Promise<void> {
  for (const task of tasksFile.tasks) {
    await saveTask(projectId, task);
  }
}
