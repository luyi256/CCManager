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
  postTaskHook?: string;
  extraMounts?: ExtraMount[];
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
  selectedOptions?: number[];
}

export interface TaskLogEntry {
  timestamp: string;
  type: 'assistant' | 'tool_use' | 'tool_result' | 'user' | 'system';
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
  agentAuthToken?: string;
}
