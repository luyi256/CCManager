export interface Agent {
  id: string;
  name: string;
  capabilities: string[];
  executor: 'local' | 'docker';
  status: 'online' | 'offline' | 'busy';
  lastSeen?: string;
}

export interface Project {
  id: string;
  name: string;
  agentId: string;
  projectPath: string;
  securityMode: 'auto' | 'safe';
  authType?: 'oauth' | 'apikey';
  postTaskHook?: string;
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
  timestamp: string;
  type: 'assistant' | 'tool_use' | 'tool_result' | 'user' | 'system';
  content: unknown;
}

export interface GlobalConfig {
  defaultAuthType: 'oauth' | 'apikey';
  defaultSecurityMode: 'auto' | 'safe';
  oauthToken?: string;
  anthropicApiKey?: string;
  agentAuthToken?: string;
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
    worktreeBranch?: string;
    postTaskHook?: string;
  }) => void;
  'task:input': (data: { taskId: number; input: string }) => void;
  'task:cancel': (data: { taskId: number }) => void;
}

export interface AgentToServerEvents {
  register: (info: {
    agentId: string;
    agentName: string;
    capabilities: string[];
    executor: 'local' | 'docker';
  }) => void;
  status: (data: { status: 'online' | 'busy'; taskId?: number }) => void;
  'task:output': (data: { taskId: number; text: string }) => void;
  'task:tool_use': (data: { taskId: number; id: string; name: string; input: unknown }) => void;
  'task:tool_result': (data: { taskId: number; id: string; result: unknown }) => void;
  'task:plan_question': (data: { taskId: number; question: unknown }) => void;
  'task:permission_request': (data: { taskId: number; request: unknown }) => void;
  'task:completed': (data: { taskId: number; status: string; summary?: string }) => void;
  'task:failed': (data: { taskId: number; error: string }) => void;
  'task:error': (data: { taskId: number; error: string }) => void;
}

export interface ServerToUserEvents {
  'agent:list': (agents: Agent[]) => void;
  'agent:status': (data: { agentId: string; status: string }) => void;
  'task:output': (data: { taskId: number; text: string }) => void;
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
