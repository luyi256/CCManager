import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Play,
  Square,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  GitBranch,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import StatusBadge from '../common/StatusBadge';
import ErrorBoundary from '../common/ErrorBoundary';
import SafeMarkdown from '../common/SafeMarkdown';
import { useTaskStream } from '../../hooks/useTaskStream';
import { useCancelTask, useRetryTask, useTaskLogs } from '../../hooks/useTasks';
import type { Task } from '../../types';

// Safe JSON stringify that handles circular references
function safeStringify(obj: unknown, indent = 2): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(
      obj,
      (_key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) {
            return '[Circular]';
          }
          seen.add(value);
        }
        return value;
      },
      indent
    );
  } catch {
    return String(obj);
  }
}

// Safe date formatting
function formatDate(date: unknown): string {
  if (!date) return 'Unknown';
  try {
    const d = new Date(date as string | number);
    if (isNaN(d.getTime())) return 'Invalid date';
    return d.toLocaleString();
  } catch {
    return 'Invalid date';
  }
}

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
}

const MAX_RENDERED_MESSAGES = 200;

export default function TaskDetail({ task, onClose }: TaskDetailProps) {
  const [showToolCalls, setShowToolCalls] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  const isActive = ['running', 'waiting', 'waiting_permission', 'plan_review'].includes(
    task.status
  );

  const stream = useTaskStream(isActive ? task.id : null);
  const { data: savedLogs } = useTaskLogs(!isActive ? task.id : null);
  const cancelTask = useCancelTask();
  const retryTask = useRetryTask();

  // Combine streamed messages with saved logs for display
  const displayMessages = useMemo(() => {
    // For active tasks, use stream messages
    if (isActive && stream.messages.length > 0) {
      return stream.messages.map(msg => ({
        id: msg.id,
        content: msg.text,
        timestamp: msg.timestamp,
      }));
    }
    // For completed tasks, use saved logs
    if (savedLogs && savedLogs.length > 0) {
      return savedLogs
        .filter(log => log.type === 'output')
        .map((log, index) => ({
          id: `log-${index}`,
          content: String(log.content),
          timestamp: typeof log.timestamp === 'number' ? log.timestamp : new Date(log.timestamp || 0).getTime(),
        }));
    }
    // Keep showing stream messages during transition
    if (stream.messages.length > 0) {
      return stream.messages.map(msg => ({
        id: msg.id,
        content: msg.text,
        timestamp: msg.timestamp,
      }));
    }
    return [];
  }, [isActive, stream.messages, savedLogs]);

  const hasMessages = displayMessages.length > 0 || isActive;

  const displayToolCalls = useMemo(() => {
    if (isActive) {
      return stream.toolCalls;
    }
    if (savedLogs) {
      return savedLogs
        .filter(log => log.type === 'tool_use')
        .map(log => {
          const data = log.content as { id: string; name: string; input: unknown };
          return {
            id: data.id,
            name: data.name,
            input: data.input,
            status: 'completed' as const,
          };
        });
    }
    return [];
  }, [isActive, stream.toolCalls, savedLogs]);

  return (
    <>
      {/* Backdrop - click to close */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 top-14 bg-black/30 z-30 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Panel */}
      <motion.div
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="fixed right-0 top-14 bottom-0 w-full max-w-xl bg-dark-900 border-l border-dark-700 overflow-hidden flex flex-col z-40 shadow-2xl"
      >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-dark-700">
        <div className="flex items-center gap-3">
          <span className="text-dark-500 font-mono">#{task.id}</span>
          <StatusBadge status={task.status} />
          {task.isPlanMode && (
            <span className="px-2 py-0.5 bg-purple-500/20 text-purple-400 rounded text-xs">
              Plan Mode
            </span>
          )}
        </div>
        <button onClick={onClose} className="p-1 text-dark-400 hover:text-dark-100">
          <X size={20} />
        </button>
      </div>

      <ErrorBoundary onReset={onClose}>
      {/* Content */}
      <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
        {/* Prompt */}
        <div className="p-4 border-b border-dark-700">
          <h3 className="text-xs font-medium text-dark-500 uppercase mb-2">Task</h3>
          <p className="text-dark-200">{task.prompt}</p>
        </div>

        {/* Meta info */}
        <div className="p-4 border-b border-dark-700 grid grid-cols-2 gap-4 text-sm">
          {task.worktreeBranch && (
            <div>
              <span className="text-dark-500 flex items-center gap-1">
                <GitBranch size={14} /> Branch
              </span>
              <span className="text-dark-300 font-mono text-xs mt-1 block">
                {task.worktreeBranch}
              </span>
            </div>
          )}
          {task.createdAt && (
            <div>
              <span className="text-dark-500 flex items-center gap-1">
                <Clock size={14} /> Created
              </span>
              <span className="text-dark-300 mt-1 block">
                {formatDate(task.createdAt)}
              </span>
            </div>
          )}
          {task.waitReason && (
            <div className="col-span-2">
              <span className="text-amber-500 flex items-center gap-1">
                <Clock size={14} /> Waiting: {task.waitReason}
              </span>
            </div>
          )}
          {task.securityWarnings && task.securityWarnings.length > 0 && (
            <div className="col-span-2">
              <span className="text-yellow-500 flex items-center gap-1">
                <AlertTriangle size={14} /> {task.securityWarnings.length} security warning(s)
              </span>
            </div>
          )}
        </div>

        {/* Output Messages */}
        {hasMessages && (
          <div className="p-4 border-b border-dark-700 flex flex-col min-h-[300px] max-h-[60vh]">
            <h3 className="text-xs font-medium text-dark-500 uppercase mb-2">
              Output ({displayMessages.length} messages)
            </h3>
            <div className="bg-dark-900 rounded-lg flex-1 overflow-y-auto">
              {displayMessages.length === 0 ? (
                <div className="p-3 text-dark-500 text-sm">
                  {isActive ? 'Waiting for output...' : 'Loading logs...'}
                </div>
              ) : (
                <div className="divide-y divide-dark-800">
                  {displayMessages.map((msg) => (
                    <div key={msg.id} className="p-3 prose prose-invert prose-sm max-w-none">
                      <SafeMarkdown>{msg.content}</SafeMarkdown>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tool Calls */}
        {displayToolCalls.length > 0 && (
          <div className="p-4 border-b border-dark-700">
            <button
              onClick={() => setShowToolCalls(!showToolCalls)}
              className="flex items-center justify-between w-full text-left"
            >
              <h3 className="text-xs font-medium text-dark-500 uppercase">
                Tool Calls ({displayToolCalls.length})
              </h3>
              {showToolCalls ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            <AnimatePresence>
              {showToolCalls && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="mt-2 space-y-2 overflow-hidden"
                >
                  {displayToolCalls.map((tc) => (
                    <div key={tc.id} className="bg-dark-900 rounded p-2 text-xs">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-medium text-primary-400">{tc.name}</span>
                        <span
                          className={
                            tc.status === 'completed'
                              ? 'text-green-400'
                              : tc.status === 'running'
                              ? 'text-blue-400'
                              : 'text-dark-500'
                          }
                        >
                          {tc.status}
                        </span>
                      </div>
                      <pre className="text-dark-400 overflow-x-auto">
                        {safeStringify(tc.input)}
                      </pre>
                    </div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Plan Question */}
        {stream.planQuestion && (
          <div className="p-4 border-b border-dark-700">
            <h3 className="text-xs font-medium text-purple-400 uppercase mb-2">
              Question from Claude
            </h3>
            <p className="text-dark-200 mb-3">{stream.planQuestion.question}</p>
            <div className="space-y-2">
              {stream.planQuestion.options.map((opt, idx) => (
                <button
                  key={idx}
                  onClick={() => stream.answerQuestion(opt.label)}
                  className="w-full text-left card p-3 hover:border-primary-500 transition-colors"
                >
                  <div className="font-medium text-dark-200">{opt.label}</div>
                  {opt.description && (
                    <div className="text-sm text-dark-400 mt-1">{opt.description}</div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Permission Request */}
        {stream.permissionRequest && (
          <div className="p-4 border-b border-dark-700">
            <h3 className="text-xs font-medium text-orange-400 uppercase mb-2">
              Permission Request
            </h3>
            <div className="bg-dark-900 rounded-lg p-3 mb-3">
              <div className="text-dark-300 mb-1">{stream.permissionRequest.action}</div>
              <code className="text-xs text-dark-400 block bg-dark-800 p-2 rounded mt-2">
                {stream.permissionRequest.target}
              </code>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => stream.handlePermission('deny')}
                className="btn btn-secondary flex-1"
              >
                Deny
              </button>
              <button
                onClick={() => stream.handlePermission('approve')}
                className="btn btn-primary flex-1"
              >
                Approve
              </button>
            </div>
          </div>
        )}

        {/* Summary */}
        {task.summary && (
          <div className="p-4 border-b border-dark-700">
            <h3 className="text-xs font-medium text-dark-500 uppercase mb-2">Summary</h3>
            <p className="text-dark-300">{task.summary}</p>
          </div>
        )}

        {/* Error */}
        {task.error && (
          <div className="p-4 border-b border-dark-700">
            <h3 className="text-xs font-medium text-red-400 uppercase mb-2">Error</h3>
            <pre className="text-red-300 text-sm bg-red-500/10 p-3 rounded overflow-x-auto">
              {task.error}
            </pre>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-dark-700 flex gap-2">
        {isActive && (
          <button
            onClick={() => cancelTask.mutate(task.id)}
            disabled={cancelTask.isPending}
            className="btn btn-secondary flex-1 flex items-center justify-center gap-2"
          >
            <Square size={16} />
            Cancel
          </button>
        )}
        {(task.status === 'failed' || task.status === 'cancelled') && (
          <button
            onClick={() => retryTask.mutate(task.id)}
            disabled={retryTask.isPending}
            className="btn btn-primary flex-1 flex items-center justify-center gap-2"
          >
            <RotateCcw size={16} />
            Retry
          </button>
        )}
        {task.status === 'plan_review' && (
          <button
            onClick={stream.confirm}
            className="btn btn-primary flex-1 flex items-center justify-center gap-2"
          >
            <Play size={16} />
            Confirm Plan
          </button>
        )}
      </div>
      </ErrorBoundary>
    </motion.div>
    </>
  );
}
