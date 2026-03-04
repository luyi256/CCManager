export interface DockerConfig {
  image: string;
  memory?: string;
  cpus?: string;
  network?: string;
  timeout?: number; // Task execution timeout in milliseconds
  sessionsDir?: string; // Host directory for session persistence, default ~/.ccm-sessions
  extraMounts?: Array<{
    source: string;
    target: string;
    readonly?: boolean;
  }>;
}

export interface AgentConfig {
  agentId: string;
  agentName: string;
  dataPath: string; // Path to CCManagerData (local path or GitHub raw URL base)
  managerUrl?: string; // Resolved at runtime from dataPath/server-url.txt
  authToken?: string;
  executor?: 'local' | 'docker'; // Legacy: now per-project, kept for backward compat
  dockerConfig?: DockerConfig;
  allowedPaths: string[];
  blockedPaths?: string[];
  capabilities?: string[];
}

export interface TaskRequest {
  taskId: number;
  projectId: string;
  projectPath: string;
  prompt: string;
  isPlanMode: boolean;
  executor?: 'local' | 'docker';
  dockerImage?: string;
  worktreeBranch?: string;
  continueSession?: boolean;
  sessionId?: string;
  postTaskHook?: string;
  extraMounts?: Array<{
    source: string;
    target: string;
    readonly?: boolean;
  }>;
  images?: string[]; // base64 data URLs for screenshots
}

export interface TaskOutput {
  taskId: number;
  type: 'output' | 'tool_use' | 'tool_result' | 'plan_question' | 'permission_request' | 'error';
  data: unknown;
}

export interface TaskResult {
  taskId: number;
  status: 'completed' | 'failed' | 'cancelled';
  error?: string;
  summary?: string;
}

export interface AgentInfo {
  agentId: string;
  agentName: string;
  capabilities: string[];
  executor?: 'local' | 'docker';
  status: 'online' | 'busy';
}

export interface MergeResult {
  success: boolean;
  mergeCommit?: string;
  conflicts?: string[];
  error?: string;
}
