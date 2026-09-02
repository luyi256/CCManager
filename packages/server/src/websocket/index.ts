import { Server, Socket, Namespace } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { agentPool } from '../services/agentPool.js';
import { getTaskById, saveTask, getProject, appendTaskLog, getTaskLogs, getRunningTasksForAgent, findDeviceByHash, updateDeviceLastUsed, findAgentTokenByHash, updateAgentTokenLastUsed, touchTaskProgress } from '../services/storage.js';
import { checkDependentTasks, cancelDependentTasks } from '../services/waitingTasks.js';
import { hasQueued, queueSize } from '../services/followUpQueue.js';
import { drainFollowUps } from '../services/followUpDispatch.js';
import { buildTaskAllowedPaths } from '../services/pathValidation.js';
import { hashToken } from '../services/auth.js';
import { buildTaskStreamSnapshot, taskLogToStreamEvent } from '../services/taskStream.js';
import { getTaskImages } from '../services/taskAttachments.js';
import type {
  ServerToAgentEvents,
  AgentToServerEvents,
  ServerToUserEvents,
  TaskStreamEvent,
  TaskStreamPhase,
  UserToServerEvents,
} from '../types/index.js';

let io: Server;
let agentNamespace: Namespace;
let userNamespace: Namespace;

// Track user subscriptions
const userSubscriptions = new Map<string, Set<number>>();
const taskStreamSequences = new Map<number, number>();

function nextTaskStreamSequence(taskId: number): number {
  const next = (taskStreamSequences.get(taskId) || 0) + 1;
  taskStreamSequences.set(taskId, next);
  return next;
}

function liveStreamEvent(
  taskId: number,
  event: Omit<TaskStreamEvent, 'version' | 'taskId' | 'eventId' | 'timestamp'> & {
    eventId?: string;
    timestamp?: string;
  }
): TaskStreamEvent {
  const sequence = nextTaskStreamSequence(taskId);
  return {
    version: 1,
    taskId,
    eventId: event.eventId || `live:${taskId}:${sequence}`,
    timestamp: event.timestamp || new Date().toISOString(),
    ...event,
  };
}

async function persistAndBroadcastPhase(
  taskId: number,
  phase: TaskStreamPhase,
  runId?: string
): Promise<void> {
  const task = await getTaskById(taskId);
  if (!task) return;
  const log = await appendTaskLog(task.projectId, taskId, {
    type: 'stream_phase',
    content: { phase, runId },
  });
  const event = taskLogToStreamEvent(taskId, log, runId);
  if (event) broadcastToTask(taskId, 'task:stream', event);
}

export function setupWebSocket(server: HttpServer, path = '/socket.io'): Server {
  io = new Server(server, {
    path,
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

    socket.on('register', async (info: {
      agentId: string;
      agentName: string;
      capabilities: string[];
      executor?: 'local' | 'docker';
      runningTasks?: Array<{ taskId: number; sessionId?: string }>;
    }, ack?: (data: {
      runningTasks: Array<{ taskId: number; sessionId?: string; startedAt?: string }>;
    }) => void) => {
      agentPool.register(socket, info);
      // Broadcast updated agent list to users
      broadcastAgentList();

      // Recover orphaned running tasks for this agent
      try {
        const runningTasks = await getRunningTasksForAgent(info.agentId);
        const reportedRunning = new Set((info.runningTasks || []).map((task) => task.taskId));
        ack?.({
          runningTasks: runningTasks.map(({ task }) => ({
            taskId: task.id,
            sessionId: task.sessionId,
            startedAt: task.startedAt,
          })),
        });
        if (runningTasks.length > 0) {
          console.log(`Recovering ${runningTasks.length} orphaned task(s) for agent ${info.agentId}`);
          for (const { task, project } of runningTasks) {
            if (reportedRunning.has(task.id)) {
              console.log(`  - Task ${task.id} is still active on the reconnected agent; skipping recovery`);
              continue;
            }
            // Use continuePrompt if available (task was in follow-up mode)
            let prompt = task.continuePrompt || task.prompt;
            // Resume any running task whose CLI session ID was persisted. Initial
            // tasks are resumable too; restricting resume to follow-ups loses all
            // progress whenever an agent process restarts.
            let sessionId: string | undefined;
            let continueSession = false;
            sessionId = task.sessionId;
            continueSession = Boolean(sessionId);
            if (!sessionId && task.gitInfo) {
              try {
                const gitInfo = JSON.parse(task.gitInfo);
                sessionId = gitInfo.sessionId;
                continueSession = !!sessionId;
              } catch { /* ignore */ }
            }
            if (continueSession) {
              prompt = 'Continue the interrupted task from where you left off and finish it.';
            }
            const recoveredAt = new Date().toISOString();
            task.attemptCount = (task.attemptCount || 0) + 1;
            task.recoveryCount = (task.recoveryCount || 0) + 1;
            task.startedAt = recoveredAt;
            task.lastRecoveryAt = recoveredAt;
            task.lastProgressAt = task.lastRecoveryAt;
            await saveTask(task.projectId, task);
            await persistAndBroadcastPhase(task.id, 'recovering', task.startedAt);
            const dispatched = agentPool.dispatchTask(info.agentId, {
              taskId: task.id,
              projectId: project.id,
              projectPath: project.projectPath,
              prompt,
              isPlanMode: task.isPlanMode,
              runner: task.runner,
              model: task.model,
              skipModelValidation: true,
              executor: project.executor,
              dockerImage: project.dockerImage,
              worktreeBranch: task.worktreeBranch,
              continueSession,
              sessionId,
              postTaskHook: project.postTaskHook,
              extraMounts: project.extraMounts,
              allowedPaths: buildTaskAllowedPaths(project),
              images: getTaskImages(task.id),
              startedAt: task.startedAt,
              attempt: task.attemptCount,
              recovery: true,
            });
            if (dispatched) {
              console.log(`  - Task ${task.id} re-dispatched`);
            } else {
              console.log(`  - Task ${task.id} failed to dispatch`);
              task.status = 'failed';
              task.error = 'Failed to recover task after agent reconnect';
              task.completedAt = new Date().toISOString();
              await saveTask(task.projectId, task);
              await persistAndBroadcastPhase(task.id, 'failed', task.startedAt);
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

    socket.on('task:stream', async (data: TaskStreamEvent) => {
      try {
        const task = await getTaskById(data.taskId);
        if (!task) return;
        if (data.runId && task.startedAt && data.runId !== task.startedAt) return;
        touchTaskProgress(data.taskId, data.timestamp || new Date().toISOString());

        if (data.kind === 'text' && data.text) {
          const log = await appendTaskLog(task.projectId, data.taskId, {
            type: 'output',
            content: data.text,
          });
          const event = taskLogToStreamEvent(data.taskId, log, data.runId || task.startedAt);
          if (event) broadcastToTask(data.taskId, 'task:stream', event);
          return;
        }

        if (data.kind === 'phase' && data.phase) {
          if (data.heartbeat) {
            broadcastToTask(data.taskId, 'task:stream', liveStreamEvent(data.taskId, data));
            return;
          }
          await persistAndBroadcastPhase(data.taskId, data.phase, data.runId || task.startedAt);
          return;
        }

        if (data.kind === 'tool' && data.tool) {
          const type = data.tool.status === 'running' ? 'tool_use' : 'tool_result';
          const content = data.tool.status === 'running'
            ? {
                taskId: data.taskId,
                id: data.tool.id,
                name: data.tool.name,
                input: data.tool.input,
              }
            : {
                taskId: data.taskId,
                id: data.tool.id,
                name: data.tool.name,
                result: data.tool.result,
                error: data.tool.status === 'failed',
              };
          const log = await appendTaskLog(task.projectId, data.taskId, { type, content });
          const event = taskLogToStreamEvent(data.taskId, log, data.runId || task.startedAt);
          if (event) broadcastToTask(data.taskId, 'task:stream', event);
          return;
        }

        if (data.kind === 'interaction' && data.interaction) {
          const type = data.interaction.type;
          const content = type === 'plan_question'
            ? { taskId: data.taskId, question: data.interaction.data }
            : { taskId: data.taskId, request: data.interaction.data };
          const log = await appendTaskLog(task.projectId, data.taskId, { type, content });
          const event = taskLogToStreamEvent(data.taskId, log, data.runId || task.startedAt);
          if (event) broadcastToTask(data.taskId, 'task:stream', event);
          return;
        }

        broadcastToTask(data.taskId, 'task:stream', liveStreamEvent(data.taskId, {
          kind: data.kind,
          runId: data.runId || task.startedAt,
          blockId: data.blockId,
          mode: data.mode,
          offset: data.offset,
          text: data.text,
          tool: data.tool,
          interaction: data.interaction,
          error: data.error,
          eventId: data.eventId,
          timestamp: data.timestamp,
        }));
      } catch (error) {
        console.error('Error handling task:stream:', error);
      }
    });

    socket.on('task:output', async (data) => {
      try {
        const task = await getTaskById(data.taskId);
        if (task) {
          if (data.startedAt && task.startedAt && data.startedAt !== task.startedAt) return;
          touchTaskProgress(data.taskId);
          const log = await appendTaskLog(task.projectId, data.taskId, { type: 'output', content: data.text });
          const event = taskLogToStreamEvent(data.taskId, log, task.startedAt);
          if (event) broadcastToTask(data.taskId, 'task:stream', event);
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
          if (data.startedAt && task.startedAt && data.startedAt !== task.startedAt) return;
          touchTaskProgress(data.taskId);
          const log = await appendTaskLog(task.projectId, data.taskId, { type: 'tool_use', content: data });
          const event = taskLogToStreamEvent(data.taskId, log, task.startedAt);
          if (event) broadcastToTask(data.taskId, 'task:stream', event);
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
          if (data.startedAt && task.startedAt && data.startedAt !== task.startedAt) return;
          touchTaskProgress(data.taskId);
          const log = await appendTaskLog(task.projectId, data.taskId, { type: 'tool_result', content: data });
          const event = taskLogToStreamEvent(data.taskId, log, task.startedAt);
          if (event) broadcastToTask(data.taskId, 'task:stream', event);
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
          if (data.startedAt && task.startedAt && data.startedAt !== task.startedAt) return;
          touchTaskProgress(data.taskId);
          const log = await appendTaskLog(task.projectId, data.taskId, { type: 'plan_question', content: data });
          const event = taskLogToStreamEvent(data.taskId, log, task.startedAt);
          if (event) broadcastToTask(data.taskId, 'task:stream', event);
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
          if (data.startedAt && task.startedAt && data.startedAt !== task.startedAt) return;
          touchTaskProgress(data.taskId);
          const log = await appendTaskLog(task.projectId, data.taskId, { type: 'permission_request', content: data });
          const event = taskLogToStreamEvent(data.taskId, log, task.startedAt);
          if (event) broadcastToTask(data.taskId, 'task:stream', event);
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
          if (data.startedAt && task.startedAt && data.startedAt !== task.startedAt) return;
          // Store session_id in gitInfo field (reusing existing field)
          const gitInfo = task.gitInfo ? JSON.parse(task.gitInfo) : {};
          gitInfo.sessionId = data.sessionId;
          gitInfo.sessionRunner = data.runner ?? task.runner ?? 'claude';
          task.gitInfo = JSON.stringify(gitInfo);
          task.sessionId = data.sessionId;
          task.sessionRunner = data.runner ?? task.runner ?? 'claude';
          task.lastProgressAt = new Date().toISOString();
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
          if (data.startedAt && task.startedAt && data.startedAt !== task.startedAt) {
            console.log(`Ignoring stale completion for task ${data.taskId} run ${data.startedAt}`);
            return;
          }
          task.status = 'completed';
          task.completedAt = new Date().toISOString();
          if (data.summary) task.summary = data.summary;
          // Preserve session_id if it exists
          if (data.sessionId) {
            const gitInfo = task.gitInfo ? JSON.parse(task.gitInfo) : {};
            gitInfo.sessionId = data.sessionId;
            gitInfo.sessionRunner = task.runner ?? 'claude';
            task.gitInfo = JSON.stringify(gitInfo);
            task.sessionId = data.sessionId;
            task.sessionRunner = task.runner ?? 'claude';
          }
          await saveTask(task.projectId, task);
        }

        // Drain queued follow-up messages: merge all pending into one and resume
        // session. Queue rows survive a blocked drain so nothing is lost.
        if (task && hasQueued(data.taskId)) {
          const result = await drainFollowUps(data.taskId);
          if (result.status === 'dispatched') {
            await persistAndBroadcastPhase(data.taskId, 'starting', result.startedAt);
            broadcastToTask(data.taskId, 'task:status', {
              taskId: data.taskId,
              status: 'running',
            });
            return; // Skip the completed broadcast since we're continuing
          }
          if (result.status === 'blocked') {
            console.warn(
              `Task ${data.taskId}: ${result.count} queued follow-up(s) held (${result.reason})`
            );
            broadcastToTask(data.taskId, 'task:followup_pending', {
              taskId: data.taskId,
              queueSize: result.count,
              reason: result.reason,
            });
          }
        }

        if (task) {
          await persistAndBroadcastPhase(data.taskId, 'completed', task.startedAt);
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
          if (data.startedAt && task.startedAt && data.startedAt !== task.startedAt) {
            console.log(`Ignoring stale failure for task ${data.taskId} run ${data.startedAt}`);
            return;
          }
          task.status = 'failed';
          task.error = data.error;
          task.completedAt = new Date().toISOString();
          await saveTask(task.projectId, task);
          await persistAndBroadcastPhase(data.taskId, 'failed', task.startedAt);
        }

        // Keep queued follow-ups on failure. Discarding them silently lost the
        // user's images; surface them instead so they can resend or discard.
        if (hasQueued(data.taskId)) {
          broadcastToTask(data.taskId, 'task:followup_pending', {
            taskId: data.taskId,
            queueSize: queueSize(data.taskId),
            reason: 'task_failed',
          });
        }

        // Bug #14 fix: Only broadcast task:status with full info, remove duplicate event
        broadcastToTask(data.taskId, 'task:status', {
          taskId: data.taskId,
          status: 'failed',
          error: data.error,
        });

        // Cascade cancel any pending tasks that depend on this failed task
        await cancelDependentTasks(data.taskId);
      } catch (error) {
        console.error('Error handling task:failed:', error);
      }
    });

    socket.on('task:error', async (data) => {
      const task = await getTaskById(data.taskId);
      if (data.startedAt && task?.startedAt && data.startedAt !== task.startedAt) return;
      broadcastToTask(data.taskId, 'task:stream', liveStreamEvent(data.taskId, {
        kind: 'error',
        error: data.error,
      }));
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
        agentPool.unregister(agentId, socket);
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

    socket.on('subscribe:task', async (data) => {
      const taskId = Number(data.taskId);
      if (!isNaN(taskId)) {
        userSubscriptions.get(socket.id)?.add(taskId);
        console.log(`User ${socket.id} subscribed to task ${taskId}`);
        try {
          const task = await getTaskById(taskId);
          if (!task || !socket.connected) return;
          const logs = await getTaskLogs(task.projectId, taskId);
          socket.emit('task:stream_snapshot', buildTaskStreamSnapshot(task, logs));
        } catch (error) {
          console.error(`Failed to send task ${taskId} stream snapshot:`, error);
        }
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
