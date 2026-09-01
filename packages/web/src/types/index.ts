export interface Agent {
  id: string;
  name: string;
  capabilities: string[];
  executor: 'local' | 'docker';
  status: 'online' | 'offline' | 'busy';
  lastSeen?: string;
}

export interface ExtraMount {
  source: string;
  target: string;
  readonly?: boolean;
}

export interface Project {
  id: string;
  name: string;
  agentId: string;
  projectPath: string;
  securityMode: 'auto' | 'safe';
  authType?: 'oauth' | 'apikey';
  executor?: 'local' | 'docker';
  dockerImage?: string;
  postTaskHook?: string;
  extraMounts?: ExtraMount[];
  enableWorktree?: boolean;
  allowedPaths?: string[];
  lastModel?: string;
  createdAt: string;
  lastActivity?: string;
  taskCount: number;
  runningCount: number;
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'waiting_permission'
  | 'plan_review'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed'
  | 'cancelled';

export type Runner = 'claude' | 'claude-grok' | 'codex' | 'qwen' | 'tclaude' | 'tcodex';

export type TaskStreamPhase =
  | 'connecting'
  | 'queued'
  | 'starting'
  | 'recovering'
  | 'thinking'
  | 'tool'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskStreamEvent {
  version: 1;
  taskId: number;
  eventId: string;
  kind: 'phase' | 'text' | 'tool' | 'interaction' | 'error';
  timestamp: string;
  logId?: number;
  runId?: string;
  blockId?: string;
  phase?: TaskStreamPhase;
  mode?: 'delta' | 'snapshot';
  offset?: number;
  text?: string;
  tool?: {
    id: string;
    name: string;
    input?: unknown;
    result?: unknown;
    status: 'running' | 'completed' | 'failed';
  };
  interaction?: {
    type: 'plan_question' | 'permission_request';
    data: unknown;
  };
  error?: string;
  replay?: boolean;
  heartbeat?: boolean;
}

export interface TaskStreamSnapshot {
  version: 1;
  taskId: number;
  cursor: number;
  phase: TaskStreamPhase;
  runId?: string;
  generatedAt: string;
  events: TaskStreamEvent[];
}

export interface GitInfo {
  branch: string;
  commits: Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
  }>;
  mergedTo?: string;
  mergedAt?: string;
  mergeCommit?: string;
}

export interface Task {
  id: number;
  projectId: string;
  prompt: string;
  status: TaskStatus;
  isPlanMode: boolean;
  runner?: Runner;
  model?: string;
  dependsOn?: number;
  worktreeBranch?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  waitingUntil?: string;
  waitReason?: string;
  checkCommand?: string;
  continuePrompt?: string;
  git?: GitInfo;
  gitInfo?: string; // JSON string for storing session info
  summary?: string;
  securityWarnings?: Violation[];
  pendingPermission?: PermissionRequest;
  sessionId?: string;
  sessionRunner?: Runner;
  attemptCount?: number;
  recoveryCount?: number;
  lastProgressAt?: string;
  lastRecoveryAt?: string;
}

export interface Violation {
  type: 'file_write' | 'bash_command' | 'absolute_path';
  target: string;
  timestamp: string;
}

export interface PermissionRequest {
  id: string;
  type: 'file_write' | 'file_edit' | 'bash' | 'other';
  action: string;
  target: string;
  description?: string;
}

export interface PlanQuestion {
  id: string;
  question: string;
  options: Array<{
    label: string;
    description?: string;
  }>;
  multiSelect?: boolean;
  selectedOptions?: number[];
}

export interface TaskLogEntry {
  id: number;
  timestamp: string;
  type:
    | 'output'
    | 'tool_use'
    | 'tool_result'
    | 'plan_question'
    | 'permission_request'
    | 'user_message'
    | 'stream_phase';
  content: unknown;
}

export interface StreamEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'plan_question' | 'completed' | 'failed';
  data: unknown;
}

export interface GlobalConfig {
  defaultAuthType: 'oauth' | 'apikey';
  defaultSecurityMode: 'auto' | 'safe';
  oauthToken?: string;
  anthropicApiKey?: string;
}
