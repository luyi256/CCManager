import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import type {
  PlanQuestion,
  PermissionRequest,
  TaskStreamEvent,
  TaskStreamPhase,
  TaskStreamSnapshot,
} from '../types';
import {
  applyTaskStreamEvent,
  applyTaskStreamSnapshot,
  createTaskStreamModel,
  phaseForTaskStatus,
  type TaskStreamModel,
} from '../utils/taskStream';

type StreamAction =
  | { type: 'event'; event: TaskStreamEvent }
  | { type: 'snapshot'; snapshot: TaskStreamSnapshot }
  | { type: 'legacy_output'; text: string; timestamp: string; eventId: string }
  | { type: 'legacy_tool_use'; id: string; name: string; input: unknown; timestamp: string }
  | { type: 'legacy_tool_result'; id: string; result: unknown; timestamp: string }
  | { type: 'plan_question'; question: PlanQuestion }
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'status'; status: string; error?: string }
  | { type: 'connection'; connected: boolean }
  | { type: 'followup_queue'; size: number }
  | { type: 'clear_plan' }
  | { type: 'clear_permission' }
  | { type: 'reset'; taskId: number | null };

function streamReducer(state: TaskStreamModel, action: StreamAction): TaskStreamModel {
  switch (action.type) {
    case 'event':
      return applyTaskStreamEvent(state, action.event);
    case 'snapshot':
      return applyTaskStreamSnapshot(state, action.snapshot);
    case 'legacy_output':
      return applyTaskStreamEvent(state, {
        version: 1,
        taskId: state.taskId || 0,
        eventId: action.eventId,
        kind: 'text',
        timestamp: action.timestamp,
        blockId: `legacy:${action.eventId}`,
        mode: 'delta',
        text: action.text,
      });
    case 'legacy_tool_use':
      return applyTaskStreamEvent(state, {
        version: 1,
        taskId: state.taskId || 0,
        eventId: `legacy-tool-use:${action.id}`,
        kind: 'tool',
        timestamp: action.timestamp,
        tool: {
          id: action.id,
          name: action.name,
          input: action.input,
          status: 'running',
        },
      });
    case 'legacy_tool_result': {
      const existing = state.toolCalls.find((tool) => tool.id === action.id);
      return applyTaskStreamEvent(state, {
        version: 1,
        taskId: state.taskId || 0,
        eventId: `legacy-tool-result:${action.id}`,
        kind: 'tool',
        timestamp: action.timestamp,
        tool: {
          id: action.id,
          name: existing?.name || 'tool',
          result: action.result,
          status: 'completed',
        },
      });
    }
    case 'plan_question':
      return {
        ...state,
        phase: 'waiting',
        planQuestion: action.question,
      };
    case 'permission_request':
      return {
        ...state,
        phase: 'waiting',
        permissionRequest: action.request,
      };
    case 'status': {
      const phase = phaseForTaskStatus(action.status);
      const preserveLivePhase =
        action.status === 'running' &&
        (state.phase === 'recovering' || state.phase === 'thinking' || state.phase === 'tool');
      return {
        ...state,
        phase: preserveLivePhase ? state.phase : phase || state.phase,
        error: action.error || (phase === 'failed' ? state.error : undefined),
        planQuestion: phase === 'completed' ? undefined : state.planQuestion,
        permissionRequest: phase === 'completed' ? undefined : state.permissionRequest,
        followUpQueueSize: phase === 'completed' ? 0 : state.followUpQueueSize,
      };
    }
    case 'connection':
      return action.connected
        ? state
        : { ...state, phase: 'connecting' };
    case 'followup_queue':
      return { ...state, followUpQueueSize: action.size };
    case 'clear_plan':
      return { ...state, planQuestion: undefined };
    case 'clear_permission':
      return { ...state, permissionRequest: undefined };
    case 'reset':
      return createTaskStreamModel(action.taskId);
  }
}

export function useTaskStream(taskId: number | null) {
  const {
    isConnected,
    connectionGeneration,
    subscribe,
    unsubscribe,
    onMessage,
    sendAnswer,
    confirmPlan,
    respondPermission,
  } = useWebSocket();
  const [state, dispatch] = useReducer(streamReducer, taskId, createTaskStreamModel);
  const taskIdRef = useRef(taskId);
  const legacySequence = useRef(0);
  const snapshotSeen = useRef(false);

  useEffect(() => {
    taskIdRef.current = taskId;
    snapshotSeen.current = false;
    legacySequence.current = 0;
    dispatch({ type: 'reset', taskId });
  }, [taskId]);

  useEffect(() => {
    if (taskId) dispatch({ type: 'connection', connected: isConnected });
  }, [taskId, isConnected]);

  useEffect(() => onMessage((msg) => {
    const currentTaskId = taskIdRef.current;
    if (!currentTaskId) return;
    const msgTaskId = msg.taskId as number | undefined;
    if (msgTaskId !== undefined && msgTaskId !== currentTaskId) return;

    switch (msg.type) {
      case 'task:stream_snapshot':
        snapshotSeen.current = true;
        dispatch({ type: 'snapshot', snapshot: msg as unknown as TaskStreamSnapshot });
        break;
      case 'task:stream':
        dispatch({ type: 'event', event: msg as unknown as TaskStreamEvent });
        break;
      case 'task:output':
        if (!snapshotSeen.current) {
          const sequence = legacySequence.current++;
          dispatch({
            type: 'legacy_output',
            text: String(msg.text || ''),
            timestamp: new Date().toISOString(),
            eventId: `legacy-output:${currentTaskId}:${sequence}`,
          });
        }
        break;
      case 'task:tool_use':
        if (!snapshotSeen.current) {
          dispatch({
            type: 'legacy_tool_use',
            id: String(msg.id),
            name: String(msg.name || 'tool'),
            input: msg.input,
            timestamp: new Date().toISOString(),
          });
        }
        break;
      case 'task:tool_result':
        if (!snapshotSeen.current) {
          dispatch({
            type: 'legacy_tool_result',
            id: String(msg.id),
            result: msg.result,
            timestamp: new Date().toISOString(),
          });
        }
        break;
      case 'task:plan_question':
        if (!snapshotSeen.current) {
          dispatch({ type: 'plan_question', question: msg.question as PlanQuestion });
        }
        break;
      case 'task:permission_request':
        if (!snapshotSeen.current) {
          dispatch({ type: 'permission_request', request: msg.request as PermissionRequest });
        }
        break;
      case 'task:completed':
        dispatch({ type: 'status', status: 'completed' });
        break;
      case 'task:failed':
        dispatch({ type: 'status', status: 'failed', error: String(msg.error || '') });
        break;
      case 'task:status':
        dispatch({
          type: 'status',
          status: String(msg.status || ''),
          error: typeof msg.error === 'string' ? msg.error : undefined,
        });
        break;
      case 'task:followup_queued':
        dispatch({ type: 'followup_queue', size: Number(msg.queueSize) || 0 });
        break;
    }
  }), [onMessage]);

  // Register the local message handler before subscribing because the server
  // immediately replies to subscribe:task with a stream snapshot.
  useEffect(() => {
    if (!taskId || connectionGeneration === 0) return;
    subscribe(String(taskId));
    return () => unsubscribe(String(taskId));
  }, [taskId, connectionGeneration, subscribe, unsubscribe]);

  const answerQuestion = useCallback((answer: string) => {
    if (!taskId) return;
    sendAnswer(String(taskId), answer);
    dispatch({ type: 'clear_plan' });
  }, [taskId, sendAnswer]);

  const confirm = useCallback(() => {
    if (taskId) confirmPlan(String(taskId));
  }, [taskId, confirmPlan]);

  const handlePermission = useCallback((response: 'approve' | 'deny') => {
    if (!taskId || !state.permissionRequest) return;
    respondPermission(String(taskId), state.permissionRequest.id, response);
    dispatch({ type: 'clear_permission' });
  }, [taskId, state.permissionRequest, respondPermission]);

  const reset = useCallback(() => {
    snapshotSeen.current = false;
    legacySequence.current = 0;
    dispatch({ type: 'reset', taskId: taskIdRef.current });
  }, []);

  const status = useMemo<'idle' | 'running' | 'completed' | 'failed'>(() => {
    if (state.phase === 'completed' || state.phase === 'cancelled') return 'completed';
    if (state.phase === 'failed') return 'failed';
    if (state.phase === 'connecting' && !taskId) return 'idle';
    return 'running';
  }, [state.phase, taskId]);

  return {
    ...state,
    status,
    answerQuestion,
    confirm,
    handlePermission,
    reset,
  };
}

export type { TaskStreamPhase };
