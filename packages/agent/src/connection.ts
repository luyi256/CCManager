import { io, Socket } from 'socket.io-client';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { ClaudeExecutor } from './executor.js';
import { CodexExecutor } from './codexExecutor.js';
import { DockerExecutor } from './docker.js';
import { validatePath } from './security.js';
import { WorktreeManager } from './worktree.js';
import type { AgentConfig, TaskRequest, AgentInfo } from './types.js';
import { listSessions, listActiveSessions, getSessionDetail, searchSessions } from './sessions.js';

const execAsync = promisify(exec);

type Executor = ClaudeExecutor | CodexExecutor | DockerExecutor;

export class AgentConnection {
  private socket: Socket | null = null;
  private executors: Map<number, Executor> = new Map();
  private config: AgentConfig;
  private currentUrl: string;
  private reconnectAttempts = 0;
  private consecutiveErrors = 0;
  private maxReconnectAttempts = Infinity;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private worktreeManager = new WorktreeManager();
  // Monotonic sequence per task to detect superseded follow-ups
  private followUpSeq: Map<number, number> = new Map();

  constructor(config: AgentConfig) {
    this.config = config;
    this.currentUrl = config.managerUrl!;
  }

  connect(): void {
    console.log(`Connecting to manager: ${this.currentUrl}`);

    this.socket = io(`${this.currentUrl}/agent`, {
      auth: {
        token: this.config.authToken,
        agentId: this.config.agentId,
      },
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
    });

    this.socket.on('connect', () => {
      console.log('Connected to manager');
      this.reconnectAttempts = 0;
      this.consecutiveErrors = 0;
      this.register();
    });

    this.socket.on('disconnect', (reason) => {
      console.log(`Disconnected from manager: ${reason}`);
    });

    this.socket.on('connect_error', (error) => {
      console.error(`Connection error: ${error.message}`);
      this.reconnectAttempts++;
      this.consecutiveErrors++;

      if (this.consecutiveErrors >= 3) {
        this.reconnectWithDiscovery().catch((e) => {
          console.error('URL discovery failed:', e instanceof Error ? e.message : e);
        });
      }
    });

    this.socket.on('task:execute', (task: TaskRequest) => {
      this.handleTask(task).catch((error) => {
        console.error(`Task ${task.taskId} execution error:`, error);
      });
    });

    this.socket.on('task:input', (data: { taskId: number; input: string }) => {
      const executor = this.executors.get(data.taskId);
      if (executor) {
        executor.sendInput(data.input);
      }
    });

    this.socket.on('task:cancel', (data: { taskId: number }) => {
      const executor = this.executors.get(data.taskId);
      if (executor) {
        executor.cancel();
        this.executors.delete(data.taskId);
      }
    });

    this.socket.on('task:merge', async (data: { taskId: number; projectPath: string; branch: string; deleteBranch?: boolean }) => {
      try {
        console.log(`Merging worktree branch ${data.branch} for task ${data.taskId}`);
        const result = await this.worktreeManager.merge(data.projectPath, data.branch, data.deleteBranch || false);
        this.socket?.emit('task:merge-result', {
          taskId: data.taskId,
          ...result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.socket?.emit('task:merge-result', {
          taskId: data.taskId,
          success: false,
          error: message,
        });
      }
    });

    this.socket.on('task:cleanup-worktree', async (data: { taskId: number; projectPath: string; branch: string }) => {
      try {
        console.log(`Cleaning up worktree branch ${data.branch} for task ${data.taskId}`);
        await this.worktreeManager.cleanup(data.projectPath, data.branch);
        await this.worktreeManager.deleteBranch(data.projectPath, data.branch);
        this.socket?.emit('task:worktree-cleaned', {
          taskId: data.taskId,
          branch: data.branch,
        });
      } catch (error) {
        console.error(`Failed to cleanup worktree for task ${data.taskId}:`, error);
      }
    });

    // Session browsing — server requests session data via callback
    this.socket.on('sessions:list', async (data: { projectPath: string }, callback: (result: unknown) => void) => {
      try {
        console.log(`[sessions] list requested for projectPath: ${data.projectPath}`);
        const sessions = await listSessions(data.projectPath);
        console.log(`[sessions] list result: ${sessions.length} sessions found`);
        callback({ ok: true, sessions });
      } catch (error) {
        console.error(`[sessions] list error:`, error);
        callback({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    this.socket.on('sessions:active', async (data: { projectPath: string }, callback: (result: unknown) => void) => {
      try {
        console.log(`[sessions] active requested for projectPath: ${data.projectPath}`);
        const sessions = await listActiveSessions(data.projectPath);
        console.log(`[sessions] active result: ${sessions.length} sessions found`);
        callback({ ok: true, sessions });
      } catch (error) {
        console.error(`[sessions] active error:`, error);
        callback({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    this.socket.on('sessions:detail', async (data: { projectPath: string; sessionId: string }, callback: (result: unknown) => void) => {
      try {
        const entries = await getSessionDetail(data.projectPath, data.sessionId);
        callback({ ok: true, entries });
      } catch (error) {
        callback({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    this.socket.on('sessions:search', async (data: { projectPath: string; query: string }, callback: (result: unknown) => void) => {
      try {
        console.log(`[sessions] search requested for projectPath: ${data.projectPath}, query: "${data.query}"`);
        const results = await searchSessions(data.projectPath, data.query);
        console.log(`[sessions] search result: ${results.length} sessions matched`);
        callback({ ok: true, results });
      } catch (error) {
        console.error(`[sessions] search error:`, error);
        callback({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  private register(): void {
    const info: AgentInfo = {
      agentId: this.config.agentId,
      agentName: this.config.agentName,
      capabilities: this.config.capabilities || [],
      status: 'online',
    };

    this.socket?.emit('register', info);
    console.log(`Registered as: ${this.config.agentName}`);

    // Start heartbeat
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Send heartbeat every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      const socket = this.socket;
      if (socket?.connected) {
        const runningTasks = Array.from(this.executors.keys());
        socket.emit('status', {
          status: 'online',
          runningTasks,
          taskCount: runningTasks.length
        });
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private async handleTask(task: TaskRequest): Promise<void> {
    console.log(`Received task ${task.taskId}: ${task.prompt.substring(0, 50)}...`);
    console.log(`Task ${task.taskId} projectPath: ${task.projectPath}`);

    // If this task is already running, handle based on context
    if (this.executors.has(task.taskId)) {
      if (task.continueSession || task.isRetry) {
        // Follow-up or retry: kill current executor and start fresh
        console.log(`Task ${task.taskId}: ${task.isRetry ? 'Retry' : 'Follow-up'} received while running, replacing current executor`);
        const oldExecutor = this.executors.get(task.taskId)!;
        oldExecutor.cancel();
        this.executors.delete(task.taskId);
        // Wait for process to die before starting new one
        await new Promise<void>((resolve) => setTimeout(resolve, 3000));
      } else {
        // Duplicate dispatch (e.g. reconnect recovery) — skip
        console.log(`Task ${task.taskId}: Already running, skipping duplicate dispatch`);
        return;
      }
    } else if (task.continueSession) {
      // Continue/retry with session resume but no active executor in map.
      // This means the previous executor was removed (by cancel handler or completion).
      // The old process might still be dying (SIGTERM sent, not yet exited).
      // Wait to avoid session file conflicts with --resume.
      console.log(`Task ${task.taskId}: Session resume without active executor, waiting for old process cleanup`);
      await new Promise<void>((resolve) => setTimeout(resolve, 3000));
    }

    let executor: ClaudeExecutor | DockerExecutor | undefined;
    let executionPath = task.projectPath;

    try {
      // Validate path (use project-level allowedPaths if provided)
      console.log(`Task ${task.taskId}: Validating path...`);
      const effectiveConfig = task.allowedPaths?.length
        ? { ...this.config, allowedPaths: [...this.config.allowedPaths, ...task.allowedPaths] }
        : this.config;
      validatePath(task.projectPath, effectiveConfig);
      console.log(`Task ${task.taskId}: Path validated, creating executor...`);

      // Create worktree if branch is specified
      if (task.worktreeBranch) {
        try {
          executionPath = await this.worktreeManager.create(task.projectPath, task.worktreeBranch);
          console.log(`Task ${task.taskId}: Using worktree at ${executionPath}`);
        } catch (wtError) {
          console.warn(`Task ${task.taskId}: Worktree creation failed, falling back to direct execution:`, wtError);
          // Fall back to direct execution
          executionPath = task.projectPath;
        }
      }

      // Create executor based on task's executor setting (per-project)
      const taskExecutor = task.executor ?? this.config.executor ?? 'local';
      if (taskExecutor === 'docker' && this.config.dockerConfig) {
        const dockerConfig = task.dockerImage
          ? { ...this.config.dockerConfig, image: task.dockerImage }
          : this.config.dockerConfig;
        executor = new DockerExecutor(dockerConfig);
      } else {
        executor = new ClaudeExecutor();
      }

      // Store executor for this task
      this.executors.set(task.taskId, executor);

      // Notify running tasks count
      this.socket?.emit('status', {
        status: 'online',
        runningTasks: Array.from(this.executors.keys()),
        taskCount: this.executors.size
      });

      // Set up event handlers
      executor.on('output', (text: string) => {
        this.socket?.emit('task:output', { taskId: task.taskId, text });
      });

      executor.on('tool_use', (data) => {
        this.socket?.emit('task:tool_use', { taskId: task.taskId, ...data });
      });

      executor.on('tool_result', (data) => {
        this.socket?.emit('task:tool_result', { taskId: task.taskId, ...data });
      });

      executor.on('plan_question', (data) => {
        this.socket?.emit('task:plan_question', { taskId: task.taskId, question: data });
      });

      executor.on('permission_request', (data) => {
        this.socket?.emit('task:permission_request', { taskId: task.taskId, request: data });
      });

      executor.on('error', (error: Error) => {
        this.socket?.emit('task:error', { taskId: task.taskId, error: error.message });
      });

      executor.on('session_id', (sessionId: string) => {
        this.socket?.emit('task:session_id', { taskId: task.taskId, sessionId });
      });

      // Execute task (use worktree path if available)
      console.log(`Task ${task.taskId}: Starting execution in ${executionPath}...`);
      await executor.execute(task, executionPath);

      // Check if this execution was superseded by a newer follow-up.
      // If another handleTask call cancelled our executor and replaced it,
      // we must NOT emit task:completed (the newer execution owns the lifecycle).
      if (this.executors.get(task.taskId) !== executor) {
        console.log(`Task ${task.taskId}: Execution superseded by follow-up, skipping completion`);
        return;
      }

      console.log(`Task ${task.taskId}: Execution completed`);

      // Run post-task hook if configured
      if (task.postTaskHook) {
        console.log(`Task ${task.taskId}: Running post-task hook...`);
        this.socket?.emit('task:output', {
          taskId: task.taskId,
          text: `\n[Post-Task Hook] Running: ${task.postTaskHook}\n`,
        });
        try {
          const { stdout, stderr } = await execAsync(task.postTaskHook, {
            cwd: executionPath,
            timeout: 30000,
          });
          if (stdout) {
            this.socket?.emit('task:output', { taskId: task.taskId, text: `[Post-Task Hook] ${stdout}` });
          }
          if (stderr) {
            this.socket?.emit('task:output', { taskId: task.taskId, text: `[Post-Task Hook] ${stderr}` });
          }
          console.log(`Task ${task.taskId}: Post-task hook completed`);
        } catch (hookError) {
          const msg = hookError instanceof Error ? hookError.message : String(hookError);
          console.error(`Task ${task.taskId}: Post-task hook failed:`, msg);
          this.socket?.emit('task:output', {
            taskId: task.taskId,
            text: `[Post-Task Hook] Failed: ${msg}\n`,
          });
        }
      }

      // Task completed - include sessionId so server can preserve it
      const sessionId = 'getSessionId' in executor ? executor.getSessionId() : undefined;
      this.socket?.emit('task:completed', {
        taskId: task.taskId,
        status: 'completed',
        sessionId,
        startedAt: task.startedAt,
      });
    } catch (error) {
      // Don't report failure if this execution was superseded
      if (executor && this.executors.get(task.taskId) !== executor) {
        console.log(`Task ${task.taskId}: Superseded execution errored (ignored)`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Task ${task.taskId} failed:`, message);
      this.socket?.emit('task:failed', {
        taskId: task.taskId,
        error: message,
        startedAt: task.startedAt,
      });
    } finally {
      // Only clean up if this is still the current executor for this task
      if (executor && this.executors.get(task.taskId) === executor) {
        this.executors.delete(task.taskId);
        this.socket?.emit('status', {
          status: 'online',
          runningTasks: Array.from(this.executors.keys()),
          taskCount: this.executors.size
        });
      }
    }
  }

  private async discoverUrl(): Promise<string | null> {
    const dataPath = this.config.dataPath;
    try {
      let text: string;
      if (dataPath.startsWith('http://') || dataPath.startsWith('https://')) {
        const url = `${dataPath.replace(/\/$/, '')}/server-url.txt`;
        const res = await fetch(url);
        if (!res.ok) {
          console.error(`URL discovery HTTP ${res.status}`);
          return null;
        }
        text = (await res.text()).trim();
      } else {
        // Local dataPath: try localhost first
        const localhostUrl = 'http://localhost:3001';
        try {
          const res = await fetch(`${localhostUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) return localhostUrl;
        } catch { /* not reachable */ }

        // git pull to get latest tunnel URL
        try {
          const { existsSync: gitExists } = await import('fs');
          const { join: gitJoin } = await import('path');
          if (gitExists(gitJoin(dataPath, '.git'))) {
            execSync('git pull --ff-only', { cwd: dataPath, timeout: 15000, stdio: 'pipe' });
            console.log('URL discovery: git pull updated dataPath');
          }
        } catch (e) {
          console.warn('URL discovery: git pull failed (non-fatal):', e instanceof Error ? e.message : e);
        }

        // Fall back to server-url.txt (tunnel URL)
        const { readFileSync, existsSync } = await import('fs');
        const { join } = await import('path');
        const filePath = join(dataPath, 'server-url.txt');
        if (!existsSync(filePath)) return null;
        text = readFileSync(filePath, 'utf-8').trim();
      }
      new URL(text); // Validate
      return text;
    } catch (e) {
      console.error('URL discovery error:', e instanceof Error ? e.message : e);
      return null;
    }
  }

  private async reconnectWithDiscovery(): Promise<void> {
    this.consecutiveErrors = 0; // Reset to avoid re-triggering while discovering
    const newUrl = await this.discoverUrl();
    if (!newUrl || newUrl === this.currentUrl) {
      console.log('URL discovery: no change, continuing default reconnect');
      return;
    }
    console.log(`URL discovery: new URL found: ${newUrl}`);
    this.currentUrl = newUrl;
    // Tear down old socket and reconnect with new URL
    this.stopHeartbeat();
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.connect();
  }

  disconnect(): void {
    this.stopHeartbeat();
    // Cancel all running tasks
    for (const executor of this.executors.values()) {
      executor.cancel();
    }
    this.executors.clear();
    this.socket?.disconnect();
    this.socket = null;
  }

  get isConnected(): boolean {
    return this.socket?.connected || false;
  }
}
