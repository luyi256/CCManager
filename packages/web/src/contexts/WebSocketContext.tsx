import { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';
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
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const handlersRef = useRef<Set<(msg: WebSocketMessage) => void>>(new Set());

  useEffect(() => {
    // Connect to default namespace for users
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const socketUrl = `${protocol}//${window.location.host}`;

    const token = getApiToken();
    const socket = io(socketUrl, {
      auth: { token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      console.log('Socket.IO connected');
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      console.log('Socket.IO disconnected');
    });

    socket.on('connect_error', (error) => {
      console.error('Socket.IO connection error:', error);
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
      'task:tool_use',
      'task:tool_result',
      'task:plan_question',
      'task:permission_request',
      'task:status',
      'task:completed',
      'task:failed',
    ];

    for (const event of taskEvents) {
      socket.on(event, (data: WebSocketMessage) => {
        const msg: WebSocketMessage = { ...data, type: event };
        handlersRef.current.forEach((handler) => handler(msg));
      });
    }

    return () => {
      socket.disconnect();
    };
  }, []);

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
