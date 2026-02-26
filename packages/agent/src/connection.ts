import { io, Socket } from 'socket.io-client';
import { ClaudeExecutor } from './executor.js';
import { DockerExecutor } from './docker.js';
import { validatePath } from './security.js';
import type { AgentConfig, TaskRequest, AgentInfo } from './types.js';

export class AgentConnection {
  private socket: Socket | null = null;
  private executors: Map<number, ClaudeExecutor | DockerExecutor> = new Map();
  private config: AgentConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = Infinity;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  connect(): void {
    console.log(`Connecting to manager: ${this.config.managerUrl}`);

    this.socket = io(`${this.config.managerUrl}/agent`, {
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
      this.register();
    });

    this.socket.on('disconnect', (reason) => {
      console.log(`Disconnected from manager: ${reason}`);
    });

    this.socket.on('connect_error', (error) => {
      console.error(`Connection error: ${error.message}`);
      this.reconnectAttempts++;
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
        console.log(`Task ${task.taskId}: Emitting session_id to server:`, sessionId);
        this.socket?.emit('task:session_id', { taskId: task.taskId, sessionId });
      });

      // Execute task
      console.log(`Task ${task.taskId}: Starting execution...`);
      await executor.execute(task, task.projectPath);
      console.log(`Task ${task.taskId}: Execution completed`);

      // Task completed - include sessionId so server can preserve it
      this.socket?.emit('task:completed', {
        taskId: task.taskId,
        status: 'completed',
        sessionId: executor.getSessionId(),
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
