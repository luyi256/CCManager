import { Server, Socket, Namespace } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { agentPool } from '../services/agentPool.js';
import { getTaskById, saveTask, getProject, appendTaskLog, getRunningTasksForAgent, findDeviceByHash, updateDeviceLastUsed, findAgentTokenByHash, updateAgentTokenLastUsed } from '../services/storage.js';
import { checkDependentTasks } from '../services/waitingTasks.js';
import { hashToken } from '../services/auth.js';
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
      origin: false,
    },
  });

  // Agent namespace with authentication
  agentNamespace = io.of('/agent');

  agentNamespace.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    const agentId = socket.handshake.auth.agentId;

    // Validate agentId is provided
    if (!agentId || typeof agentId !== 'string' || agentId.trim().length === 0) {
      return next(new Error('Agent ID is required'));
    }

    // Validate agentId format (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      return next(new Error('Invalid agent ID format'));
    }

    if (!token || typeof token !== 'string') {
      console.warn(`Agent auth rejected: no token provided (agentId: ${agentId})`);
      return next(new Error('Auth token is required'));
    }

    // Look up per-agent token by hash
    const tokenHash = hashToken(token);
    const agentToken = findAgentTokenByHash(tokenHash);

    if (!agentToken) {
      console.warn(`Agent auth rejected: invalid token (agentId: ${agentId})`);
      return next(new Error('Invalid agent auth token'));
    }

    // Verify the token belongs to the connecting agent
    if (agentToken.agentId !== agentId) {
      console.warn(`Agent auth rejected: token belongs to ${agentToken.agentId}, not ${agentId}`);
      return next(new Error('Token does not match agent ID'));
    }

    updateAgentTokenLastUsed(tokenHash);
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
            // Use continuePrompt if available (task was in follow-up mode)
            const prompt = task.continuePrompt || task.prompt;
            // If task has a session ID and continuePrompt, resume the session
            let sessionId: string | undefined;
            let continueSession = false;
            if (task.continuePrompt && task.gitInfo) {
              try {
                const gitInfo = JSON.parse(task.gitInfo);
                sessionId = gitInfo.sessionId;
                continueSession = !!sessionId;
              } catch { /* ignore */ }
            }
            const dispatched = agentPool.dispatchTask(info.agentId, {
              taskId: task.id,
              projectId: project.id,
              projectPath: project.projectPath,
              prompt,
              isPlanMode: task.isPlanMode,
              executor: project.executor,
              worktreeBranch: task.worktreeBranch,
              continueSession,
              sessionId,
              postTaskHook: project.postTaskHook,
              extraMounts: project.extraMounts,
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
        // Small delay to ensure session_id save completes first
        await new Promise(resolve => setTimeout(resolve, 100));
        const task = await getTaskById(data.taskId);
        if (task) {
          task.status = 'completed';
          task.completedAt = new Date().toISOString();
          if (data.summary) task.summary = data.summary;
          // Preserve session_id if it exists
          if (data.sessionId && !task.gitInfo) {
            task.gitInfo = JSON.stringify({ sessionId: data.sessionId });
          }
          await saveTask(task.projectId, task);
        }
        // Bug #14 fix: Only broadcast task:status with full info, remove duplicate event
        broadcastToTask(data.taskId, 'task:status', {
          taskId: data.taskId,
          status: 'completed',
          summary: data.summary,
        });

        // Start any pending tasks that depend on this completed task
        await checkDependentTasks(data.taskId);
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

    socket.on('task:merge-result', async (data) => {
      try {
        const task = await getTaskById(data.taskId);
        if (task && data.success) {
          // Update git info with merge details
          const gitInfo = task.gitInfo ? JSON.parse(task.gitInfo) : {};
          gitInfo.mergedTo = 'main';
          gitInfo.mergedAt = new Date().toISOString();
          if (data.mergeCommit) gitInfo.mergeCommit = data.mergeCommit;
          task.gitInfo = JSON.stringify(gitInfo);
          await saveTask(task.projectId, task);
        }
        broadcastToTask(data.taskId, 'task:merge-result', data);
      } catch (error) {
        console.error('Error handling task:merge-result:', error);
      }
    });

    socket.on('task:worktree-cleaned', async (data) => {
      try {
        const task = await getTaskById(data.taskId);
        if (task) {
          // Clear the worktree branch since it's been cleaned up
          task.worktreeBranch = undefined;
          await saveTask(task.projectId, task);
        }
        broadcastToTask(data.taskId, 'task:worktree-cleaned', data);
      } catch (error) {
        console.error('Error handling task:worktree-cleaned:', error);
      }
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

  // User namespace (default) with authentication
  userNamespace = io.of('/');

  userNamespace.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token || typeof token !== 'string') {
      return next(new Error('Authentication required'));
    }
    const tokenHash = hashToken(token);
    const device = findDeviceByHash(tokenHash);
    if (!device) {
      return next(new Error('Invalid token'));
    }
    updateDeviceLastUsed(tokenHash);
    return next();
  });

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
