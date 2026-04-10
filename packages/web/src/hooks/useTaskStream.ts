import { useEffect, useState, useCallback, useRef } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import type { PlanQuestion, PermissionRequest } from '../types';

interface OutputMessage {
  id: string;
  text: string;
  timestamp: number;
}

interface TaskStreamState {
  messages: OutputMessage[];
  toolCalls: Array<{
    id: string;
    name: string;
    input: unknown;
    result?: unknown;
    status: 'pending' | 'running' | 'completed';
  }>;
  planQuestion?: PlanQuestion;
  permissionRequest?: PermissionRequest;
  status: 'idle' | 'running' | 'completed' | 'failed';
  error?: string;
  followUpQueueSize: number;
}

// Batch interval for output messages (ms)
const MESSAGE_BATCH_INTERVAL = 150;
// Max messages kept in state to prevent unbounded memory growth
const MAX_STREAM_MESSAGES = 500;

export function useTaskStream(taskId: number | null) {
  const { subscribe, unsubscribe, onMessage, sendAnswer, confirmPlan, respondPermission } = useWebSocket();

  const [state, setState] = useState<TaskStreamState>({
    messages: [],
    toolCalls: [],
    status: 'idle',
    followUpQueueSize: 0,
  });

  // Buffer for batching rapid output messages
  const pendingMessages = useRef<OutputMessage[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track total messages seen (including trimmed ones)
  const totalMessageCount = useRef(0);

  // Flush buffered messages into state
  const flushMessages = useCallback(() => {
    flushTimer.current = null;
    if (pendingMessages.current.length === 0) return;
    const batch = pendingMessages.current;
    pendingMessages.current = [];
    setState((prev) => {
      const merged = [...prev.messages, ...batch];
      // Cap to prevent unbounded growth
      const trimmed = merged.length > MAX_STREAM_MESSAGES
        ? merged.slice(-MAX_STREAM_MESSAGES)
        : merged;
      return {
        ...prev,
        messages: trimmed,
        status: 'running',
      };
    });
  }, []);

  useEffect(() => {
    if (!taskId) return;

    subscribe(String(taskId));

    const cleanup = onMessage((msg) => {
      // Check if message is for this task
      const msgTaskId = msg.taskId as number | undefined;
      if (msgTaskId !== undefined && msgTaskId !== taskId) return;

      switch (msg.type) {
        case 'task:output': {
          const text = msg.text as string;
          const newMessage: OutputMessage = {
            id: `msg-${totalMessageCount.current}`,
            text,
            timestamp: Date.now(),
          };
          pendingMessages.current.push(newMessage);
          totalMessageCount.current++;
          // Schedule a flush if not already pending
          if (!flushTimer.current) {
            flushTimer.current = setTimeout(flushMessages, MESSAGE_BATCH_INTERVAL);
          }
          break;
        }

        case 'task:tool_use':
          setState((prev) => ({
            ...prev,
            toolCalls: [
              ...prev.toolCalls,
              {
                id: msg.id as string,
                name: msg.name as string,
                input: msg.input,
                status: 'running',
              },
            ],
          }));
          break;

        case 'task:tool_result':
          setState((prev) => ({
            ...prev,
            toolCalls: prev.toolCalls.map((tc) =>
              tc.id === msg.id
                ? { ...tc, result: msg.result, status: 'completed' as const }
                : tc
            ),
          }));
          break;

        case 'task:plan_question':
          setState((prev) => ({
            ...prev,
            planQuestion: msg.question as PlanQuestion,
          }));
          break;

        case 'task:permission_request':
          setState((prev) => ({
            ...prev,
            permissionRequest: msg.request as PermissionRequest,
          }));
          break;

        case 'task:completed': {
          // Flush any remaining buffered messages before marking completed
          if (flushTimer.current) clearTimeout(flushTimer.current);
          const completeBatch = pendingMessages.current;
          pendingMessages.current = [];
          setState((prev) => {
            const merged = completeBatch.length > 0
              ? [...prev.messages, ...completeBatch]
              : prev.messages;
            const trimmed = merged.length > MAX_STREAM_MESSAGES
              ? merged.slice(-MAX_STREAM_MESSAGES)
              : merged;
            return {
              ...prev,
              messages: trimmed,
              status: 'completed',
              planQuestion: undefined,
              permissionRequest: undefined,
              followUpQueueSize: 0,
            };
          });
          break;
        }

        case 'task:failed':
          // Flush remaining messages on failure too
          if (flushTimer.current) clearTimeout(flushTimer.current);
          pendingMessages.current = [];
          setState((prev) => ({
            ...prev,
            status: 'failed',
            error: msg.error as string,
          }));
          break;

        case 'task:followup_queued':
          setState((prev) => ({
            ...prev,
            followUpQueueSize: (msg.queueSize as number) || 0,
          }));
          break;

        case 'task:status':
          // Status update from server
          break;
      }
    });

    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      pendingMessages.current = [];
      unsubscribe(String(taskId));
      cleanup();
    };
  }, [taskId, subscribe, unsubscribe, onMessage, flushMessages]);

  const answerQuestion = useCallback(
    (answer: string) => {
      if (taskId) {
        sendAnswer(String(taskId), answer);
        setState((prev) => ({ ...prev, planQuestion: undefined }));
      }
    },
    [taskId, sendAnswer]
  );

  const confirm = useCallback(() => {
    if (taskId) {
      confirmPlan(String(taskId));
    }
  }, [taskId, confirmPlan]);

  const handlePermission = useCallback(
    (response: 'approve' | 'deny') => {
      if (taskId && state.permissionRequest) {
        respondPermission(String(taskId), state.permissionRequest.id, response);
        setState((prev) => ({ ...prev, permissionRequest: undefined }));
      }
    },
    [taskId, state.permissionRequest, respondPermission]
  );

  const reset = useCallback(() => {
    totalMessageCount.current = 0;
    setState({
      messages: [],
      toolCalls: [],
      status: 'idle',
      followUpQueueSize: 0,
    });
  }, []);

  return {
    ...state,
    answerQuestion,
    confirm,
    handlePermission,
    reset,
  };
}
