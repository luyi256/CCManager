import type {
  PlanQuestion,
  PermissionRequest,
  TaskStreamEvent,
  TaskStreamPhase,
  TaskStreamSnapshot,
} from '../types';

export interface StreamTextBlock {
  id: string;
  text: string;
  timestamp: number;
  logId?: number;
}

export interface StreamToolCall {
  id: string;
  name: string;
  input?: unknown;
  result?: unknown;
  status: 'pending' | 'running' | 'completed' | 'failed';
  timestamp: number;
  logId?: number;
}

export interface TaskStreamModel {
  taskId: number | null;
  messages: StreamTextBlock[];
  toolCalls: StreamToolCall[];
  phase: TaskStreamPhase;
  planQuestion?: PlanQuestion;
  permissionRequest?: PermissionRequest;
  error?: string;
  cursor: number;
  runId?: string;
  hydrated: boolean;
  followUpQueueSize: number;
  appliedEventIds: string[];
}

export function createTaskStreamModel(taskId: number | null): TaskStreamModel {
  return {
    taskId,
    messages: [],
    toolCalls: [],
    phase: 'connecting',
    cursor: 0,
    hydrated: false,
    followUpQueueSize: 0,
    appliedEventIds: [],
  };
}

export function parseStreamTimestamp(timestamp: string | number | undefined): number {
  if (typeof timestamp === 'number') return timestamp;
  if (!timestamp) return Date.now();
  const normalized = timestamp.includes('T')
    ? timestamp
    : `${timestamp.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function mergeDelta(current: string, incoming: string, offset?: number): string {
  if (offset === undefined) return current + incoming;
  if (offset < 0) return current;
  if (offset < current.length) {
    const overlap = current.slice(offset, offset + incoming.length);
    if (overlap === incoming) return current;
    return current.slice(0, offset) + incoming;
  }
  if (offset > current.length) return current + incoming;
  return current + incoming;
}

function applyTextEvent(model: TaskStreamModel, event: TaskStreamEvent): TaskStreamModel {
  const blockId = event.blockId || (event.runId ? `assistant:${event.runId}` : event.eventId);
  const index = model.messages.findIndex((message) =>
    message.id === blockId ||
    (event.logId !== undefined && message.logId === event.logId)
  );
  const previous = index >= 0 ? model.messages[index] : undefined;
  const incoming = event.text || '';
  const text = event.mode === 'snapshot'
    ? incoming
    : mergeDelta(previous?.text || '', incoming, event.offset);
  const phase = event.replay
    ? model.phase
    : model.phase === 'tool'
      ? model.phase
      : 'thinking';
  const nextMessage: StreamTextBlock = {
    id: blockId,
    text,
    timestamp: parseStreamTimestamp(event.timestamp),
    logId: event.logId,
  };
  const messages = index >= 0
    ? model.messages.map((message, messageIndex) =>
        messageIndex === index ? nextMessage : message
      )
    : [...model.messages, nextMessage];

  return {
    ...model,
    messages,
    phase,
  };
}

function applyToolEvent(model: TaskStreamModel, event: TaskStreamEvent): TaskStreamModel {
  if (!event.tool) return model;
  const index = model.toolCalls.findIndex((tool) => tool.id === event.tool!.id);
  const previous = index >= 0 ? model.toolCalls[index] : undefined;
  const nextTool: StreamToolCall = {
    id: event.tool.id,
    name: event.tool.name === 'tool' && previous?.name
      ? previous.name
      : event.tool.name || previous?.name || 'tool',
    input: event.tool.input !== undefined ? event.tool.input : previous?.input,
    result: event.tool.result !== undefined ? event.tool.result : previous?.result,
    status: event.tool.status,
    timestamp: parseStreamTimestamp(event.timestamp),
    logId: event.logId ?? previous?.logId,
  };
  const toolCalls = index >= 0
    ? model.toolCalls.map((tool, toolIndex) => toolIndex === index ? nextTool : tool)
    : [...model.toolCalls, nextTool];

  return {
    ...model,
    toolCalls,
    phase: event.replay
      ? model.phase
      : event.tool.status === 'running'
        ? 'tool'
        : 'thinking',
  };
}

export function applyTaskStreamEvent(
  model: TaskStreamModel,
  event: TaskStreamEvent
): TaskStreamModel {
  if (model.taskId !== null && event.taskId !== model.taskId) return model;
  if (model.appliedEventIds.includes(event.eventId)) return model;
  const appliedEventIds = [...model.appliedEventIds, event.eventId].slice(-2000);
  const cursor = event.logId !== undefined ? Math.max(model.cursor, event.logId) : model.cursor;
  const base = {
    ...model,
    taskId: event.taskId,
    cursor,
    runId: event.runId || model.runId,
    hydrated: true,
    appliedEventIds,
  };

  switch (event.kind) {
    case 'text':
      return applyTextEvent(base, event);
    case 'tool':
      return applyToolEvent(base, event);
    case 'phase':
      return {
        ...base,
        phase: event.phase || base.phase,
        error: event.phase === 'failed' ? base.error : undefined,
      };
    case 'interaction':
      if (event.interaction?.type === 'plan_question') {
        return {
          ...base,
          phase: 'waiting',
          planQuestion: event.interaction.data as PlanQuestion,
        };
      }
      if (event.interaction?.type === 'permission_request') {
        return {
          ...base,
          phase: 'waiting',
          permissionRequest: event.interaction.data as PermissionRequest,
        };
      }
      return base;
    case 'error':
      return {
        ...base,
        phase: 'failed',
        error: event.error,
      };
  }
}

export function applyTaskStreamSnapshot(
  model: TaskStreamModel,
  snapshot: TaskStreamSnapshot
): TaskStreamModel {
  if (model.taskId !== null && snapshot.taskId !== model.taskId) return model;
  const previousRunId = model.runId;
  let next = createTaskStreamModel(snapshot.taskId);
  next = {
    ...next,
    phase: snapshot.phase,
    cursor: snapshot.cursor,
    runId: snapshot.runId,
    hydrated: true,
    followUpQueueSize: model.followUpQueueSize,
    appliedEventIds: [],
  };
  for (const event of snapshot.events) {
    next = applyTaskStreamEvent(next, event);
  }
  const sameRun = !previousRunId || previousRunId === snapshot.runId;
  if (!sameRun) {
    return {
      ...next,
      phase: snapshot.phase,
      cursor: Math.max(next.cursor, snapshot.cursor),
      hydrated: true,
    };
  }
  let hasNewerLocalState = false;
  for (const message of model.messages) {
    const index = next.messages.findIndex((candidate) =>
      candidate.id === message.id ||
      (message.logId !== undefined && candidate.logId === message.logId)
    );
    if (index < 0) {
      next.messages.push(message);
      hasNewerLocalState = true;
      continue;
    }
    const snapshotMessage = next.messages[index];
    if (
      message.text.length > snapshotMessage.text.length &&
      message.text.startsWith(snapshotMessage.text)
    ) {
      next.messages[index] = message;
      hasNewerLocalState = true;
    }
  }
  const toolStatusRank = { pending: 0, running: 1, completed: 2, failed: 2 };
  for (const tool of model.toolCalls) {
    const index = next.toolCalls.findIndex((candidate) => candidate.id === tool.id);
    if (index < 0) {
      next.toolCalls.push(tool);
      hasNewerLocalState = true;
      continue;
    }
    const snapshotTool = next.toolCalls[index];
    if (
      tool.timestamp > snapshotTool.timestamp ||
      toolStatusRank[tool.status] > toolStatusRank[snapshotTool.status]
    ) {
      next.toolCalls[index] = tool;
      hasNewerLocalState = true;
    }
  }
  return {
    ...next,
    phase: hasNewerLocalState ? model.phase : snapshot.phase,
    cursor: Math.max(next.cursor, snapshot.cursor),
    hydrated: true,
  };
}

export function phaseForTaskStatus(status: string): TaskStreamPhase | null {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'starting';
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
    default:
      return null;
  }
}
