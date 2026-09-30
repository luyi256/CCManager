import { Server, Socket, Namespace } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { agentPool } from '../services/agentPool.js';
import { getTaskById, saveTask, getProject, appendTaskLog, getTaskLogs, getRunningTasksForAgent, findDeviceByHash, updateDeviceLastUsed, findAgentTokenByHash, updateAgentTokenLastUsed, touchTaskProgress, getTaskEventCursor, setTaskEventCursor } from '../services/storage.js';
import { checkDependentTasks, cancelDependentTasks } from '../services/waitingTasks.js';
import { hasQueued, queueSize } from '../services/followUpQueue.js';
import { drainFollowUps } from '../services/followUpDispatch.js';
import { buildTaskAllowedPaths } from '../services/pathValidation.js';
import { hashToken } from '../services/auth.js';
import { buildTaskStreamSnapshot, taskLogToStreamEvent } from '../services/taskStream.js';
import { getTaskImagesForDispatch } from '../services/taskAttachments.js';
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

interface TaskCompletionReport {
  taskId: number;
  status?: string;
  summary?: string;
  sessionId?: string;
  startedAt?: string;
}

interface TaskFailureReport {
  taskId: number;
  error: string;
  startedAt?: string;
}

type TaskOutcomeReport =
  | ({ outcome: 'completed' } & TaskCompletionReport)
  | ({ outcome: 'failed' } & TaskFailureReport);

interface ReportedRunningTask {
  taskId: number;
  sessionId?: string;
  startedAt?: string;
}

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_warnings', 'failed', 'cancelled']);

// An outcome can arrive twice: once live and once in the next register
// payload when the acknowledgement was lost to a disconnect.
const outcomesInFlight = new Map<string, Promise<void>>();

function applyOutcomeOnce(kind: string, taskId: number, startedAt: string | undefined, apply: () => Promise<void>): Promise<void> {
  const key = `${kind}:${taskId}:${startedAt ?? ''}`;
  const existing = outcomesInFlight.get(key);
  if (existing) return existing;
  const running = apply().finally(() => {
    if (outcomesInFlight.get(key) === running) outcomesInFlight.delete(key);
  });
  outcomesInFlight.set(key, running);
  return running;
}

function applyTaskCompleted(data: TaskCompletionReport): Promise<void> {
  return applyOutcomeOnce('completed', data.taskId, data.startedAt, async () => {
    // Small delay to ensure session_id save completes first
    await new Promise(resolve => setTimeout(resolve, 100));
    const task = await getTaskById(data.taskId);
    if (task) {
      if (data.startedAt && task.startedAt && data.startedAt !== task.startedAt) {
        console.log(`Ignoring stale completion for task ${data.taskId} run ${data.startedAt}`);
        return;
      }
      if (TERMINAL_STATUSES.has(task.status)) return;
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
  });
}

function applyTaskFailed(data: TaskFailureReport): Promise<void> {
  return applyOutcomeOnce('failed', data.taskId, data.startedAt, async () => {
    const task = await getTaskById(data.taskId);
    if (task) {
      if (data.startedAt && task.startedAt && data.startedAt !== task.startedAt) {
        console.log(`Ignoring stale failure for task ${data.taskId} run ${data.startedAt}`);
        return;
      }
      if (TERMINAL_STATUSES.has(task.status)) return;
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
  });
}

async function applyTaskOutcome(report: TaskOutcomeReport): Promise<void> {
  if (report.outcome === 'completed') {
    await applyTaskCompleted(report);
  } else if (report.outcome === 'failed') {
    await applyTaskFailed(report);
  }
}

function recoveryPromptForFollowUp(message: string): string {
  return [
    'The previous run was interrupted before it finished. If you have not handled the latest user message below yet, handle it now; otherwise continue from where you left off and finish it.',
    '',
    'Latest user message:',
    message,
  ].join('\n');
}

/** Tasks the agent still runs although the user cancelled them while it was unreachable. */
async function findCancelledWhileOffline(reported: ReportedRunningTask[]): Promise<number[]> {
  const cancelled: number[] = [];
  for (const { taskId } of reported) {
    const task = await getTaskById(taskId);
    if (!task || task.status === 'cancelled') cancelled.push(taskId);
  }
  return cancelled;
}

/**
 * Handlers for task events an agent reports. They are reached both as
 * individual Socket.IO events and replayed from `task:events` batches.
 */
const agentTaskEventHandlers: Record<string, (data: any) => Promise<void>> = {
  'task:stream': async (data: TaskStreamEvent) => {
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
  },
  'task:output': async (data: any) => {
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
  },
  'task:tool_use': async (data: any) => {
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
  },
  'task:tool_result': async (data: any) => {
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
  },
  'task:plan_question': async (data: any) => {
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
  },
  'task:permission_request': async (data: any) => {
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
  },
  'task:session_id': async (data: any) => {
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
  },
  'task:completed': (data: TaskCompletionReport) => applyTaskCompleted(data),
  'task:failed': (data: TaskFailureReport) => applyTaskFailed(data),
  'task:error': async (data: any) => {
    const task = await getTaskById(data.taskId);
    if (data.startedAt && task?.startedAt && data.startedAt !== task.startedAt) return;
    broadcastToTask(data.taskId, 'task:stream', liveStreamEvent(data.taskId, {
      kind: 'error',
      error: data.error,
    }));
    broadcastToTask(data.taskId, 'task:failed', { taskId: data.taskId, error: data.error });
  },
};

export function setupWebSocket(server: HttpServer, path = '/socket.io'): Server {
  io = new Server(server, {
    path,
    // Session detail callbacks can contain multi-megabyte coding transcripts.
    // Socket.IO defaults to 1 MB and silently drops the agent connection when
    // a larger acknowledgement arrives, which made large tCodex histories
    // appear to hang and then time out.
    maxHttpBufferSize: 32 * 1024 * 1024,
    // The default Engine.IO timeout is only 20 seconds. Large session payloads
    // and slower cross-region links can legitimately delay a pong, so leave a
    // wider margin before declaring an otherwise healthy agent dead.
    pingTimeout: 120000,
    pingInterval: 25000,
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
      runningTasks?: ReportedRunningTask[];
      finishedTasks?: TaskOutcomeReport[];
    }, ack?: (data: {
      runningTasks: Array<{ taskId: number; sessionId?: string; startedAt?: string }>;
      cancelTaskIds: number[];
    }) => void) => {
      agentPool.register(socket, info);
      // Broadcast updated agent list to users
      broadcastAgentList();

      // Reconcile server state with what the agent actually did while the
      // connection was down. A disconnect alone never interrupts execution:
      // tasks the agent still runs or finished are synced silently, and only
      // tasks the agent no longer knows about (process restart) are recovered.
      try {
        for (const outcome of info.finishedTasks || []) {
          try {
            await applyTaskOutcome(outcome);
          } catch (error) {
            console.error(`Error applying offline outcome for task ${outcome.taskId}:`, error);
          }
        }

        const reported = info.runningTasks || [];
        const cancelTaskIds = await findCancelledWhileOffline(reported);
        const reportedRuns = new Map(
          reported
            .filter((task) => !cancelTaskIds.includes(task.taskId))
            .map((task) => [task.taskId, task])
        );
        agentPool.flushPendingInputs(info.agentId, new Set(reportedRuns.keys()));

        const runningTasks = await getRunningTasksForAgent(info.agentId);
        ack?.({
          runningTasks: runningTasks.map(({ task }) => ({
            taskId: task.id,
            sessionId: task.sessionId,
            startedAt: task.startedAt,
          })),
          cancelTaskIds,
        });

        const orphaned = runningTasks.filter(({ task }) => {
          const run = reportedRuns.get(task.id);
          return !run || Boolean(run.startedAt && task.startedAt && run.startedAt !== task.startedAt);
        });
        if (orphaned.length > 0) {
          console.log(`Recovering ${orphaned.length} orphaned task(s) for agent ${info.agentId}`);
          for (const { task, project } of orphaned) {
            // The agent runs a superseded run of this task; replace it.
            const replacesStaleRun = reportedRuns.has(task.id);
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
            // An interrupted follow-up may never have reached the session, so
            // re-send it (with its images) instead of a bare "continue".
            const resendsUserMessage = !continueSession || Boolean(task.continuePrompt);
            if (continueSession) {
              prompt = task.continuePrompt
                ? recoveryPromptForFollowUp(task.continuePrompt)
                : 'Continue the interrupted task from where you left off and finish it.';
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
              reasoningEffort: task.reasoningEffort,
              skipModelValidation: true,
              executor: project.executor,
              dockerImage: project.dockerImage,
              worktreeBranch: task.worktreeBranch,
              continueSession,
              sessionId,
              postTaskHook: project.postTaskHook,
              extraMounts: project.extraMounts,
              allowedPaths: buildTaskAllowedPaths(project),
              images: getTaskImagesForDispatch(task.id, resendsUserMessage),
              startedAt: task.startedAt,
              attempt: task.attemptCount,
              recovery: true,
              isRetry: replacesStaleRun,
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

    for (const [event, handler] of Object.entries(agentTaskEventHandlers)) {
      socket.on(event, async (data: unknown, ack?: () => void) => {
        try {
          await handler(data);
        } catch (error) {
          console.error(`Error handling ${event}:`, error);
        }
        ack?.();
      });
    }

    // Durable event stream from detached task runners. Batches are resent
    // until acknowledged, so apply each sequence number at most once.
    socket.on('task:events', async (
      batch: { taskId: number; runId?: string; events: Array<{ seq: number; event: string; data: unknown }> },
      ack?: (result: { seq: number }) => void
    ) => {
      const runId = batch.runId ?? '';
      let applied = getTaskEventCursor(batch.taskId, runId);
      for (const record of batch.events || []) {
        if (record.seq <= applied) continue;
        const handler = agentTaskEventHandlers[record.event];
        if (handler) {
          try {
            await handler(record.data);
          } catch (error) {
            console.error(`Error handling ${record.event} from task ${batch.taskId}:`, error);
          }
        }
        applied = record.seq;
        setTaskEventCursor(batch.taskId, runId, applied);
      }
      ack?.({ seq: applied });
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
