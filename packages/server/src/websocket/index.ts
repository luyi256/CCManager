import { Server, Socket, Namespace } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { agentPool } from '../services/agentPool.js';
import { getConfig, getTaskById, saveTask, getProject, appendTaskLog, getRunningTasksForAgent } from '../services/storage.js';
import type {
  ServerToAgentEvents,
  AgentToServerEvents,
  ServerToUserEvents,
  UserToServerEvents,
} from '../types/index.js';

let io: Server;
let agentNamespace: Namespace;
let userNamespace: Namespace;

// Track user subscriptions
const userSubscriptions = new Map<string, Set<number>>();

export function setupWebSocket(server: HttpServer): Server {
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // Agent namespace with authentication
  agentNamespace = io.of('/agent');

  agentNamespace.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    const agentId = socket.handshake.auth.agentId;
    const config = await getConfig();

    // Validate agentId is provided
    if (!agentId || typeof agentId !== 'string' || agentId.trim().length === 0) {
      return next(new Error('Agent ID is required'));
    }

    // Validate agentId format (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      return next(new Error('Invalid agent ID format'));
    }

    if (!config.agentAuthToken) {
      // No token configured - log warning but allow for development
      console.warn('WARNING: No agent auth token configured. Set agentAuthToken in settings for production use.');
      return next();
    }

    // Constant-time comparison to prevent timing attacks (Bug #19 fix)
    if (!token || typeof token !== 'string') {
      return next(new Error('Auth token is required'));
    }

    const expectedToken = config.agentAuthToken;
    if (token.length !== expectedToken.length) {
      return next(new Error('Invalid agent auth token'));
    }

    let mismatch = 0;
    for (let i = 0; i < token.length; i++) {
      mismatch |= token.charCodeAt(i) ^ expectedToken.charCodeAt(i);
    }

    if (mismatch !== 0) {
      return next(new Error('Invalid agent auth token'));
    }

    return next();
  });

  agentNamespace.on('connection', (socket: Socket) => {
    console.log('Agent connected:', socket.id);

    socket.on('register', async (info) => {
      agentPool.register(socket, info);
      // Broadcast updated agent list to users
      broadcastAgentList();

      // Recover orphaned running tasks for this agent
      try {
        const runningTasks = await getRunningTasksForAgent(info.agentId);
        if (runningTasks.length > 0) {
          console.log(`Recovering ${runningTasks.length} orphaned task(s) for agent ${info.agentId}`);
          for (const { task, project } of runningTasks) {
            const dispatched = agentPool.dispatchTask(info.agentId, {
              taskId: task.id,
              projectId: project.id,
              projectPath: project.projectPath,
              prompt: task.prompt,
              isPlanMode: task.isPlanMode,
              worktreeBranch: task.worktreeBranch,
            });
            if (dispatched) {
              console.log(`  - Task ${task.id} re-dispatched`);
            } else {
              console.log(`  - Task ${task.id} failed to dispatch`);
            }
          }
        }
      } catch (error) {
        console.error('Error recovering orphaned tasks:', error);
      }
    });

    socket.on('status', (data) => {
      const agentId = socket.handshake.auth.agentId;
      if (agentId) {
        agentPool.updateStatus(agentId, data.status, data.runningTasks);
        broadcastAgentStatus(agentId, data.status, data.runningTasks?.length || 0);
      }
    });

    socket.on('task:output', async (data) => {
      try {
        const task = await getTaskById(data.taskId);
        if (task) {
          await appendTaskLog(task.projectId, data.taskId, { type: 'output', content: data.text });
        }
        broadcastToTask(data.taskId, 'task:output', { taskId: data.taskId, text: data.text });
      } catch (error) {
        console.error('Error handling task:output:', error);
      }
    });

    socket.on('task:tool_use', async (data) => {
      try {
        const task = await getTaskById(data.taskId);
        if (task) {
          await appendTaskLog(task.projectId, data.taskId, { type: 'tool_use', content: data });
        }
        broadcastToTask(data.taskId, 'task:tool_use', data);
      } catch (error) {
        console.error('Error handling task:tool_use:', error);
      }
    });

    socket.on('task:tool_result', async (data) => {
      try {
        const task = await getTaskById(data.taskId);
        if (task) {
          await appendTaskLog(task.projectId, data.taskId, { type: 'tool_result', content: data });
        }
        broadcastToTask(data.taskId, 'task:tool_result', data);
      } catch (error) {
        console.error('Error handling task:tool_result:', error);
      }
    });

    socket.on('task:plan_question', async (data) => {
      try {
        const task = await getTaskById(data.taskId);
        if (task) {
          await appendTaskLog(task.projectId, data.taskId, { type: 'plan_question', content: data });
        }
        broadcastToTask(data.taskId, 'task:plan_question', data);
      } catch (error) {
        console.error('Error handling task:plan_question:', error);
      }
    });

    socket.on('task:permission_request', async (data) => {
      try {
        const task = await getTaskById(data.taskId);
        if (task) {
          await appendTaskLog(task.projectId, data.taskId, { type: 'permission_request', content: data });
        }
        broadcastToTask(data.taskId, 'task:permission_request', data);
      } catch (error) {
        console.error('Error handling task:permission_request:', error);
      }
    });

    socket.on('task:session_id', async (data) => {
      try {
        const task = await getTaskById(data.taskId);
        if (task) {
          // Store session_id in gitInfo field (reusing existing field)
          const gitInfo = task.gitInfo ? JSON.parse(task.gitInfo) : {};
          gitInfo.sessionId = data.sessionId;
          task.gitInfo = JSON.stringify(gitInfo);
          await saveTask(task.projectId, task);
        }
      } catch (error) {
        console.error('Error handling task:session_id:', error);
      }
    });

    socket.on('task:completed', async (data) => {
      try {
        const task = await getTaskById(data.taskId);
        if (task) {
          task.status = 'completed';
          task.completedAt = new Date().toISOString();
          if (data.summary) task.summary = data.summary;
          await saveTask(task.projectId, task);
        }
        // Bug #14 fix: Only broadcast task:status with full info, remove duplicate event
        broadcastToTask(data.taskId, 'task:status', {
          taskId: data.taskId,
          status: 'completed',
          summary: data.summary,
        });
      } catch (error) {
        console.error('Error handling task:completed:', error);
      }
    });

    socket.on('task:failed', async (data) => {
      try {
        const task = await getTaskById(data.taskId);
        if (task) {
          task.status = 'failed';
          task.error = data.error;
          task.completedAt = new Date().toISOString();
          await saveTask(task.projectId, task);
        }
        // Bug #14 fix: Only broadcast task:status with full info, remove duplicate event
        broadcastToTask(data.taskId, 'task:status', {
          taskId: data.taskId,
          status: 'failed',
          error: data.error,
        });
      } catch (error) {
        console.error('Error handling task:failed:', error);
      }
    });

    socket.on('task:error', (data) => {
      broadcastToTask(data.taskId, 'task:failed', { taskId: data.taskId, error: data.error });
    });

    socket.on('disconnect', () => {
      const agentId = socket.handshake.auth.agentId;
      if (agentId) {
        agentPool.unregister(agentId);
        broadcastAgentList();
      }
      console.log('Agent disconnected:', socket.id);
    });
  });

  // Set namespace for agent pool
  agentPool.setNamespace(agentNamespace);

  // User namespace (default)
  userNamespace = io.of('/');

  userNamespace.on('connection', (socket: Socket) => {
    console.log('User connected:', socket.id);
    userSubscriptions.set(socket.id, new Set());

    // Send current agent list
    const agents = agentPool.getAllAgents();
    console.log('Sending agent:list to user:', socket.id, 'agents:', JSON.stringify(agents));
    socket.emit('agent:list', agents);

    socket.on('subscribe:task', (data) => {
      const taskId = Number(data.taskId);
      if (!isNaN(taskId)) {
        userSubscriptions.get(socket.id)?.add(taskId);
        console.log(`User ${socket.id} subscribed to task ${taskId}`);
      }
    });

    socket.on('unsubscribe:task', (data) => {
      const taskId = Number(data.taskId);
      if (!isNaN(taskId)) {
        userSubscriptions.get(socket.id)?.delete(taskId);
        console.log(`User ${socket.id} unsubscribed from task ${taskId}`);
      }
    });

    socket.on('task:answer', async (data) => {
      const taskId = Number(data.taskId);
      const task = await getTaskById(taskId);
      if (task) {
        const project = await getProject(task.projectId);
        if (project) {
          agentPool.sendInput(project.agentId, taskId, data.answer);
        }
      }
    });

    socket.on('task:confirm_plan', async (data) => {
      const taskId = Number(data.taskId);
      const task = await getTaskById(taskId);
      if (task) {
        const project = await getProject(task.projectId);
        if (project) {
          agentPool.sendInput(project.agentId, taskId, 'y');
        }
      }
    });

    socket.on('task:permission_response', async (data) => {
      const taskId = Number(data.taskId);
      const task = await getTaskById(taskId);
      if (task) {
        const project = await getProject(task.projectId);
        if (project) {
          agentPool.sendInput(project.agentId, taskId, data.response === 'approve' ? 'y' : 'n');
        }
      }
    });

    socket.on('disconnect', () => {
      userSubscriptions.delete(socket.id);
      console.log('User disconnected:', socket.id);
    });
  });

  return io;
}

function broadcastToTask(taskId: number, event: string, data: unknown): void {
  for (const [socketId, subscriptions] of userSubscriptions.entries()) {
    if (subscriptions.has(taskId)) {
      const socket = userNamespace.sockets.get(socketId);
      if (socket?.connected) {
        socket.emit(event, data);
      } else {
        // Clean up stale subscriptions (Bug #8 fix)
        userSubscriptions.delete(socketId);
      }
    }
  }
}

function broadcastAgentList(): void {
  const agents = agentPool.getAllAgents();
  console.log('Broadcasting agent:list to all users:', JSON.stringify(agents));
  userNamespace.emit('agent:list', agents);
}

function broadcastAgentStatus(agentId: string, status: string, taskCount?: number): void {
  userNamespace.emit('agent:status', { agentId, status, taskCount });
}

// Export for use in routes
export function broadcast(taskId: number, message: { type: string; [key: string]: unknown }): void {
  broadcastToTask(taskId, message.type, message);
}

export function broadcastAll(message: unknown): void {
  userNamespace.emit('broadcast', message);
}

export function getAgentNamespace(): Namespace {
  return agentNamespace;
}

export function getUserNamespace(): Namespace {
  return userNamespace;
}
