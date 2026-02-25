import { useEffect, useState, useCallback } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import type { PlanQuestion, PermissionRequest } from '../types';

interface OutputMessage {
  id: string;
  text: string;
  timestamp: number;
}

interface TaskStreamState {
  output: string;
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
}

export function useTaskStream(taskId: number | null) {
  const { subscribe, unsubscribe, onMessage, sendAnswer, confirmPlan, respondPermission } = useWebSocket();

  const [state, setState] = useState<TaskStreamState>({
    output: '',
    messages: [],
    toolCalls: [],
    status: 'idle',
  });

  useEffect(() => {
    if (!taskId) return;

    subscribe(String(taskId));

    const cleanup = onMessage((msg) => {
      // Check if message is for this task
      const msgTaskId = msg.taskId as number | undefined;
      if (msgTaskId !== undefined && msgTaskId !== taskId) return;

      switch (msg.type) {
        case 'task:output':
          setState((prev) => {
            const text = msg.text as string;
            const newMessage: OutputMessage = {
              id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              text,
              timestamp: Date.now(),
            };
            return {
              ...prev,
              output: prev.output + text,
              messages: [...prev.messages, newMessage],
              status: 'running',
            };
          });
          break;

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

        case 'task:completed':
          setState((prev) => ({
            ...prev,
            status: 'completed',
            planQuestion: undefined,
            permissionRequest: undefined,
          }));
          break;

        case 'task:failed':
          setState((prev) => ({
            ...prev,
            status: 'failed',
            error: msg.error as string,
          }));
          break;

        case 'task:status':
          // Status update from server
          break;
      }
    });

    return () => {
      unsubscribe(String(taskId));
      cleanup();
    };
  }, [taskId, subscribe, unsubscribe, onMessage]);

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
    setState({
      output: '',
      messages: [],
      toolCalls: [],
      status: 'idle',
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
