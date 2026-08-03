import type {
  Task,
  TaskStreamEvent,
  TaskStreamPhase,
  TaskStreamSnapshot,
} from '../types/index.js';
import type { StoredTaskLog } from './storage.js';

export function taskStatusToStreamPhase(
  status: Task['status'],
  hasActivity = false
): TaskStreamPhase {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'waiting':
    case 'waiting_permission':
    case 'plan_review':
      return 'waiting';
    case 'completed':
    case 'completed_with_warnings':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'running':
      return hasActivity ? 'thinking' : 'starting';
  }
}

function contentRecord(content: unknown): Record<string, unknown> {
  return content && typeof content === 'object'
    ? content as Record<string, unknown>
    : {};
}

function streamEventId(log: StoredTaskLog, suffix: string): string {
  return `log:${log.id}:${suffix}`;
}

export function taskLogToStreamEvent(
  taskId: number,
  log: StoredTaskLog,
  runId?: string,
  replay = false
): TaskStreamEvent | null {
  const base = {
    version: 1 as const,
    taskId,
    timestamp: log.timestamp,
    logId: log.id,
    runId,
    replay,
  };

  if (log.type === 'output') {
    const text = String(log.content ?? '');
    return {
      ...base,
      eventId: streamEventId(log, `text:${text.length}`),
      kind: 'text',
      blockId: `output:${log.id}`,
      mode: 'snapshot',
      offset: 0,
      text,
    };
  }

  if (log.type === 'stream_phase') {
    const content = contentRecord(log.content);
    const phase = content.phase;
    if (
      typeof phase !== 'string' ||
      !['connecting', 'queued', 'starting', 'thinking', 'tool', 'waiting', 'completed', 'failed', 'cancelled'].includes(phase)
    ) return null;
    return {
      ...base,
      eventId: streamEventId(log, `phase:${phase}`),
      kind: 'phase',
      runId: typeof content.runId === 'string' ? content.runId : runId,
      phase: phase as TaskStreamPhase,
    };
  }

  if (log.type === 'tool_use') {
    const content = contentRecord(log.content);
    const id = typeof content.id === 'string' ? content.id : `tool-log-${log.id}`;
    return {
      ...base,
      eventId: streamEventId(log, 'tool:running'),
      kind: 'tool',
      tool: {
        id,
        name: typeof content.name === 'string' ? content.name : 'tool',
        input: content.input,
        status: 'running',
      },
    };
  }

  if (log.type === 'tool_result') {
    const content = contentRecord(log.content);
    const id = typeof content.id === 'string' ? content.id : `tool-log-${log.id}`;
    return {
      ...base,
      eventId: streamEventId(log, 'tool:completed'),
      kind: 'tool',
      tool: {
        id,
        name: typeof content.name === 'string' ? content.name : 'tool',
        result: content.result,
        status: content.error ? 'failed' : 'completed',
      },
    };
  }

  if (log.type === 'plan_question' || log.type === 'permission_request') {
    const content = contentRecord(log.content);
    const interactionType = log.type === 'plan_question'
      ? 'plan_question'
      : 'permission_request';
    const data = interactionType === 'plan_question'
      ? (content.question ?? log.content)
      : (content.request ?? log.content);
    return {
      ...base,
      eventId: streamEventId(log, interactionType),
      kind: 'interaction',
      interaction: {
        type: interactionType,
        data,
      },
    };
  }

  return null;
}

export function buildTaskStreamSnapshot(
  task: Task,
  logs: StoredTaskLog[],
  generatedAt = new Date().toISOString()
): TaskStreamSnapshot {
  const runId = task.startedAt;
  const events = logs
    .map((log) => taskLogToStreamEvent(task.id, log, runId, true))
    .filter((event): event is TaskStreamEvent => event !== null);
  const lastPhase = [...events]
    .reverse()
    .find((event) => event.kind === 'phase' && event.phase)?.phase;
  const lastActivity = [...events]
    .reverse()
    .find((event) =>
      event.kind === 'text' ||
      event.kind === 'tool' ||
      event.kind === 'interaction'
    );
  const hasActivity = Boolean(lastActivity);
  const taskPhase = taskStatusToStreamPhase(task.status, hasActivity);
  let phase = taskPhase;
  if (!['completed', 'failed', 'cancelled'].includes(taskPhase)) {
    if (lastPhase) {
      phase = lastPhase;
    } else if (lastActivity?.kind === 'tool' && lastActivity.tool?.status === 'running') {
      phase = 'tool';
    } else if (lastActivity?.kind === 'interaction') {
      phase = 'waiting';
    } else if (lastActivity) {
      phase = 'thinking';
    }
  }

  return {
    version: 1,
    taskId: task.id,
    cursor: logs.reduce((max, log) => Math.max(max, log.id), 0),
    phase,
    runId,
    generatedAt,
    events,
  };
}
