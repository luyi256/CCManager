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
  managerUrl: string;
  authToken: string;
  executor: 'local' | 'docker';
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
  worktreeBranch?: string;
  continueSession?: boolean;
  sessionId?: string;
  postTaskHook?: string;
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
  executor: 'local' | 'docker';
  status: 'online' | 'busy';
}
