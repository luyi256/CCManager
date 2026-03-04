import { io, Socket } from 'socket.io-client';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ClaudeExecutor } from './executor.js';
import { DockerExecutor } from './docker.js';
import { validatePath } from './security.js';
import type { AgentConfig, TaskRequest, AgentInfo } from './types.js';

const execAsync = promisify(exec);

export class AgentConnection {
  private socket: Socket | null = null;
  private executors: Map<number, ClaudeExecutor | DockerExecutor> = new Map();
  private config: AgentConfig;
  private currentUrl: string;
  private reconnectAttempts = 0;
  private consecutiveErrors = 0;
  private maxReconnectAttempts = Infinity;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(config: AgentConfig) {
    this.config = config;
    this.currentUrl = config.managerUrl;
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

      if (this.config.managerUrlSource && this.consecutiveErrors >= 3) {
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
  }

  private register(): void {
    const info: AgentInfo = {
      agentId: this.config.agentId,
      agentName: this.config.agentName,
      capabilities: this.config.capabilities || [],
      executor: this.config.executor,
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

    // Skip if this task is already running (prevents duplicate execution on reconnect)
    if (this.executors.has(task.taskId)) {
      console.log(`Task ${task.taskId}: Already running, skipping duplicate dispatch`);
      return;
    }

    let executor: ClaudeExecutor | DockerExecutor;

    try {
      // Validate path
      console.log(`Task ${task.taskId}: Validating path...`);
      validatePath(task.projectPath, this.config);
      console.log(`Task ${task.taskId}: Path validated, creating executor...`);

      // Create executor based on config
      if (this.config.executor === 'docker' && this.config.dockerConfig) {
        executor = new DockerExecutor(this.config.dockerConfig);
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

      // Execute task
      console.log(`Task ${task.taskId}: Starting execution...`);
      await executor.execute(task, task.projectPath);
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
            cwd: task.projectPath,
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Task ${task.taskId} failed:`, message);
      this.socket?.emit('task:failed', {
        taskId: task.taskId,
        error: message,
      });
    } finally {
      this.executors.delete(task.taskId);
      this.socket?.emit('status', {
        status: 'online',
        runningTasks: Array.from(this.executors.keys()),
        taskCount: this.executors.size
      });
    }
  }

  private async discoverUrl(): Promise<string | null> {
    if (!this.config.managerUrlSource) return null;
    try {
      const res = await fetch(this.config.managerUrlSource);
      if (!res.ok) {
        console.error(`URL discovery HTTP ${res.status}`);
        return null;
      }
      const text = (await res.text()).trim();
      // Validate it looks like a URL
      new URL(text);
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
