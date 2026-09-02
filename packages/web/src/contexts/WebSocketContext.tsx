import { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, Socket } from 'socket.io-client';
import type { Agent } from '../types';
import { getApiToken } from '../services/auth';

interface WebSocketMessage {
  type: string;
  taskId?: number;
  [key: string]: unknown;
}

interface WebSocketContextType {
  isConnected: boolean;
  connectionGeneration: number;
  agents: Agent[];
  subscribe: (taskId: string) => void;
  unsubscribe: (taskId: string) => void;
  onMessage: (handler: (msg: WebSocketMessage) => void) => () => void;
  sendAnswer: (taskId: string, answer: string) => void;
  confirmPlan: (taskId: string) => void;
  respondPermission: (taskId: string, requestId: string, response: 'approve' | 'deny') => void;
}

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const [agents, setAgents] = useState<Agent[]>([]);
  const handlersRef = useRef<Set<(msg: WebSocketMessage) => void>>(new Set());

  useEffect(() => {
    // Connect to default namespace for users
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const socketUrl = `${protocol}//${window.location.host}`;

    const token = getApiToken();
    // Derive the socket.io path from the app base (Vite base = '/ccm/') so it matches
    // the nginx reverse-proxy location `/ccm/socket.io/`. Hardcoding '/socket.io' 404s
    // in production behind the proxy (which only forwards the /ccm-prefixed path).
    const appBase = import.meta.env.BASE_URL.replace(/\/$/, '');
    const socket = io(socketUrl, {
      path: `${appBase || ''}/socket.io`,
      auth: { token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      setConnectionGeneration((value) => value + 1);
      console.log('Socket.IO connected');
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      console.log('Socket.IO disconnected');
    });

    socket.on('connect_error', (error) => {
      console.warn('Socket.IO connection error:', error.message);
    });

    // Agent updates
    socket.on('agent:list', (agentList: Agent[]) => {
      console.log('Received agent:list:', agentList);
      setAgents(agentList);
    });

    socket.on('agent:status', (data: { agentId: string; status: string }) => {
      setAgents((prev) =>
        prev.map((agent) =>
          agent.id === data.agentId
            ? { ...agent, status: data.status as Agent['status'] }
            : agent
        )
      );
    });

    // Task events - forward to handlers
    const taskEvents = [
      'task:output',
      'task:stream',
      'task:stream_snapshot',
      'task:tool_use',
      'task:tool_result',
      'task:plan_question',
      'task:permission_request',
      'task:status',
      'task:completed',
      'task:failed',
      'task:followup_queued',
      'task:followup_pending',
    ];

    for (const event of taskEvents) {
      socket.on(event, (data: WebSocketMessage) => {
        const msg: WebSocketMessage = { ...data, type: event };
        if (
          typeof msg.taskId === 'number' &&
          ['task:status', 'task:completed', 'task:failed', 'task:followup_queued', 'task:followup_pending'].includes(event)
        ) {
          queryClient.invalidateQueries({ queryKey: ['task', msg.taskId] });
          queryClient.invalidateQueries({ queryKey: ['tasks'] });
          queryClient.invalidateQueries({ queryKey: ['taskLogs', msg.taskId] });
          queryClient.invalidateQueries({ queryKey: ['taskAttachments', msg.taskId] });
          queryClient.invalidateQueries({ queryKey: ['taskFollowUps', msg.taskId] });
        }
        handlersRef.current.forEach((handler) => handler(msg));
      });
    }

    return () => {
      socket.disconnect();
    };
  }, [queryClient]);

  const subscribe = useCallback((taskId: string) => {
    socketRef.current?.emit('subscribe:task', { taskId });
    console.log(`Subscribed to task ${taskId}`);
  }, []);

  const unsubscribe = useCallback((taskId: string) => {
    socketRef.current?.emit('unsubscribe:task', { taskId });
    console.log(`Unsubscribed from task ${taskId}`);
  }, []);

  const onMessage = useCallback((handler: (msg: WebSocketMessage) => void) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  const sendAnswer = useCallback((taskId: string, answer: string) => {
    socketRef.current?.emit('task:answer', { taskId, answer });
  }, []);

  const confirmPlan = useCallback((taskId: string) => {
    socketRef.current?.emit('task:confirm_plan', { taskId });
  }, []);

  const respondPermission = useCallback((taskId: string, requestId: string, response: 'approve' | 'deny') => {
    socketRef.current?.emit('task:permission_response', { taskId, requestId, response });
  }, []);

  return (
    <WebSocketContext.Provider
      value={{
        isConnected,
        connectionGeneration,
        agents,
        subscribe,
        unsubscribe,
        onMessage,
        sendAnswer,
        confirmPlan,
        respondPermission,
      }}
    >
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
}
