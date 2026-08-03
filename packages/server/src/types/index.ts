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

export type Runner = 'claude' | 'codex' | 'qwen' | 'tclaude' | 'tcodex';

export type TaskStreamPhase =
  | 'connecting'
  | 'queued'
  | 'starting'
  | 'thinking'
  | 'tool'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskStreamTool {
  id: string;
  name: string;
  input?: unknown;
  result?: unknown;
  status: 'running' | 'completed' | 'failed';
}

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
  tool?: TaskStreamTool;
  interaction?: {
    type: 'plan_question' | 'permission_request';
    data: unknown;
  };
  error?: string;
  replay?: boolean;
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

export interface GlobalConfig {
  defaultAuthType: 'oauth' | 'apikey';
  defaultSecurityMode: 'auto' | 'safe';
  oauthToken?: string;
  anthropicApiKey?: string;
  updatedAt?: string;
}

// Socket.IO event types
export interface ServerToAgentEvents {
  'task:execute': (task: {
    taskId: number;
    projectId: string;
    projectPath: string;
    prompt: string;
    isPlanMode: boolean;
    runner?: Runner;
    model?: string;
    executor?: 'local' | 'docker';
    dockerImage?: string;
    worktreeBranch?: string;
    continueSession?: boolean;
    sessionId?: string;
    isRetry?: boolean;
    postTaskHook?: string;
    extraMounts?: ExtraMount[];
    allowedPaths?: string[];
    images?: string[];
    startedAt?: string;
  }) => void;
  'task:input': (data: { taskId: number; input: string }) => void;
  'task:cancel': (data: { taskId: number }) => void;
  'task:merge': (data: { taskId: number; projectPath: string; branch: string; deleteBranch?: boolean }) => void;
  'task:cleanup-worktree': (data: { taskId: number; projectPath: string; branch: string }) => void;
}

export interface AgentToServerEvents {
  register: (info: {
    agentId: string;
    agentName: string;
    capabilities: string[];
    executor?: 'local' | 'docker';
  }) => void;
  status: (data: { status: 'online' | 'busy'; taskId?: number; runningTasks?: number[]; taskCount?: number }) => void;
  'task:stream': (data: TaskStreamEvent) => void;
  'task:output': (data: { taskId: number; text: string }) => void;
  'task:tool_use': (data: { taskId: number; id: string; name: string; input: unknown }) => void;
  'task:tool_result': (data: { taskId: number; id: string; result: unknown }) => void;
  'task:plan_question': (data: { taskId: number; question: unknown }) => void;
  'task:permission_request': (data: { taskId: number; request: unknown }) => void;
  'task:session_id': (data: { taskId: number; sessionId: string }) => void;
  'task:completed': (data: { taskId: number; status: string; summary?: string; sessionId?: string; startedAt?: string }) => void;
  'task:failed': (data: { taskId: number; error: string; startedAt?: string }) => void;
  'task:error': (data: { taskId: number; error: string }) => void;
  'task:merge-result': (data: { taskId: number; success: boolean; mergeCommit?: string; conflicts?: string[]; error?: string }) => void;
  'task:worktree-cleaned': (data: { taskId: number; branch: string }) => void;
}

export interface ServerToUserEvents {
  'agent:list': (agents: Agent[]) => void;
  'agent:status': (data: { agentId: string; status: string }) => void;
  'task:output': (data: { taskId: number; text: string }) => void;
  'task:stream': (data: TaskStreamEvent) => void;
  'task:stream_snapshot': (data: TaskStreamSnapshot) => void;
  'task:tool_use': (data: { taskId: number; id: string; name: string; input: unknown }) => void;
  'task:tool_result': (data: { taskId: number; id: string; result: unknown }) => void;
  'task:plan_question': (data: { taskId: number; question: unknown }) => void;
  'task:permission_request': (data: { taskId: number; request: unknown }) => void;
  'task:status': (data: { taskId: number; status: string }) => void;
  'task:completed': (data: { taskId: number }) => void;
  'task:failed': (data: { taskId: number; error: string }) => void;
}

export interface UserToServerEvents {
  'subscribe:task': (data: { taskId: string }) => void;
  'unsubscribe:task': (data: { taskId: string }) => void;
  'task:answer': (data: { taskId: string; answer: string }) => void;
  'task:confirm_plan': (data: { taskId: string }) => void;
  'task:permission_response': (data: { taskId: string; requestId: string; response: 'approve' | 'deny' }) => void;
}

export interface StreamMessage {
  type: string;
  event?: {
    type: string;
    content_block?: {
      type: string;
      id?: string;
      name?: string;
      input?: unknown;
    };
    delta?: {
      type?: string;
      text?: string;
      stop_reason?: string;
    };
  };
}
