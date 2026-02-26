import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Play,
  Square,
  RotateCcw,
  GitBranch,
  Clock,
  AlertTriangle,
  ArrowDown,
  Send,
  Terminal,
  MessageSquare,
} from 'lucide-react';
import StatusBadge from '../common/StatusBadge';
import ErrorBoundary from '../common/ErrorBoundary';
import SafeMarkdown from '../common/SafeMarkdown';
import { useTaskStream } from '../../hooks/useTaskStream';
import { useCancelTask, useRetryTask, useContinueTask, useTaskLogs } from '../../hooks/useTasks';
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

// Timeline item types
interface TimelineItem {
  id: string;
  type: 'output' | 'tool_use' | 'tool_result';
  timestamp: number;
  content: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  toolStatus?: 'pending' | 'running' | 'completed';
}

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
}

export default function TaskDetail({ task, onClose }: TaskDetailProps) {
  const [autoScroll, setAutoScroll] = useState(true);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number>(0);

  const isActive = ['running', 'waiting', 'waiting_permission', 'plan_review'].includes(
    task.status
  );

  // Always load saved logs (for history)
  const { data: savedLogs } = useTaskLogs(task.id);
  // Stream for active tasks
  const stream = useTaskStream(isActive ? task.id : null);

  const cancelTask = useCancelTask();
  const retryTask = useRetryTask();
  const continueTask = useContinueTask();
  const [continuePrompt, setContinuePrompt] = useState('');

  // Build unified timeline from saved logs and stream
  const timeline = useMemo(() => {
    const items: TimelineItem[] = [];

    // Add saved logs first
    if (savedLogs && savedLogs.length > 0) {
      savedLogs.forEach((log, index) => {
        const timestamp = typeof log.timestamp === 'number'
          ? log.timestamp
          : new Date(log.timestamp || 0).getTime();

        if (log.type === 'output') {
          items.push({
            id: `saved-output-${index}`,
            type: 'output',
            timestamp,
            content: String(log.content),
          });
        } else if (log.type === 'tool_use') {
          const data = log.content as { id: string; name: string; input: unknown };
          items.push({
            id: `saved-tool-${data.id || index}`,
            type: 'tool_use',
            timestamp,
            content: '',
            toolName: data.name,
            toolInput: data.input,
            toolStatus: 'completed',
          });
        } else if (log.type === 'tool_result') {
          const data = log.content as { id: string; result: unknown };
          items.push({
            id: `saved-result-${data.id || index}`,
            type: 'tool_result',
            timestamp,
            content: '',
            toolResult: data.result,
          });
        }
      });
    }

    // For active tasks, add stream messages (they may duplicate saved logs briefly)
    if (isActive && stream.messages.length > 0) {
      // Find the latest saved log timestamp to avoid duplicates
      const lastSavedTimestamp = items.length > 0
        ? Math.max(...items.map(i => i.timestamp))
        : 0;

      stream.messages.forEach((msg) => {
        // Only add if newer than saved logs
        if (msg.timestamp > lastSavedTimestamp) {
          items.push({
            id: `stream-${msg.id}`,
            type: 'output',
            timestamp: msg.timestamp,
            content: msg.text,
          });
        }
      });

      // Add active tool calls
      stream.toolCalls.forEach((tc) => {
        const existingTool = items.find(i => i.id.includes(tc.id));
        if (!existingTool) {
          items.push({
            id: `stream-tool-${tc.id}`,
            type: 'tool_use',
            timestamp: Date.now(),
            content: '',
            toolName: tc.name,
            toolInput: tc.input,
            toolResult: tc.result,
            toolStatus: tc.status,
          });
        }
      });
    }

    // Sort by timestamp
    items.sort((a, b) => a.timestamp - b.timestamp);

    return items;
  }, [savedLogs, isActive, stream.messages, stream.toolCalls]);

  const hasContent = timeline.length > 0 || isActive;

  // Track if user has scrolled up
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= 80;
    setAutoScroll(isAtBottom);
  }, []);

  // Auto-scroll to bottom when new content arrives
  useEffect(() => {
    if (!autoScroll) return;
    cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      const container = messagesContainerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }, [autoScroll, timeline.length]);

  // Cleanup rAF on unmount
  useEffect(() => {
    return () => cancelAnimationFrame(scrollRafRef.current);
  }, []);

  // Scroll to bottom on initial load
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container && timeline.length > 0) {
      container.scrollTop = container.scrollHeight;
    }
  }, [task.id]); // Only on task change

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
          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            {/* Prompt */}
            <div className="p-4 border-b border-dark-700 flex-shrink-0">
              <h3 className="text-xs font-medium text-dark-500 uppercase mb-2">Task</h3>
              <p className="text-dark-200">{task.prompt}</p>
            </div>

            {/* Meta info */}
            <div className="p-4 border-b border-dark-700 grid grid-cols-2 gap-4 text-sm flex-shrink-0">
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

            {/* Timeline - Messages and Tool Calls unified */}
            {hasContent && (
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                <div className="px-4 pt-4 pb-2 flex-shrink-0">
                  <h3 className="text-xs font-medium text-dark-500 uppercase">
                    Output ({timeline.length} items)
                  </h3>
                </div>
                <div className="relative flex-1 min-h-0 px-4 pb-4">
                  <div
                    ref={messagesContainerRef}
                    onScroll={handleScroll}
                    className="bg-dark-800 rounded-lg h-full overflow-y-auto"
                  >
                    {timeline.length === 0 ? (
                      <div className="p-3 text-dark-500 text-sm">
                        {isActive ? 'Waiting for output...' : 'No output recorded'}
                      </div>
                    ) : (
                      <div className="divide-y divide-dark-700">
                        {timeline.map((item) => (
                          <div key={item.id} className="p-3">
                            {item.type === 'output' ? (
                              <div className="flex gap-2">
                                <MessageSquare size={14} className="text-blue-400 flex-shrink-0 mt-1" />
                                <div className="flex-1 prose prose-invert prose-sm max-w-none">
                                  <SafeMarkdown>{item.content}</SafeMarkdown>
                                </div>
                              </div>
                            ) : item.type === 'tool_use' ? (
                              <div className="flex gap-2">
                                <Terminal size={14} className="text-green-400 flex-shrink-0 mt-1" />
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="font-medium text-green-400 text-sm">
                                      {item.toolName}
                                    </span>
                                    {item.toolStatus && (
                                      <span className={`text-xs ${
                                        item.toolStatus === 'completed' ? 'text-green-500' :
                                        item.toolStatus === 'running' ? 'text-blue-400 animate-pulse' :
                                        'text-dark-500'
                                      }`}>
                                        {item.toolStatus}
                                      </span>
                                    )}
                                  </div>
                                  <pre className="text-xs text-dark-400 bg-dark-900 p-2 rounded overflow-x-auto">
                                    {safeStringify(item.toolInput)}
                                  </pre>
                                  {item.toolResult && (
                                    <div className="mt-2">
                                      <span className="text-xs text-dark-500">Result:</span>
                                      <pre className="text-xs text-dark-300 bg-dark-900 p-2 rounded overflow-x-auto mt-1">
                                        {typeof item.toolResult === 'string'
                                          ? item.toolResult.slice(0, 500) + (item.toolResult.length > 500 ? '...' : '')
                                          : safeStringify(item.toolResult)}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Scroll-to-bottom button */}
                  {!autoScroll && timeline.length > 0 && (
                    <button
                      onClick={() => {
                        const container = messagesContainerRef.current;
                        if (container) {
                          container.scrollTop = container.scrollHeight;
                        }
                        setAutoScroll(true);
                      }}
                      className="absolute bottom-6 right-6 p-2 bg-primary-600 hover:bg-primary-500 text-white rounded-full shadow-lg transition-colors"
                      title="Scroll to bottom"
                    >
                      <ArrowDown size={16} />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Plan Question */}
            {stream.planQuestion && (
              <div className="p-4 border-t border-dark-700 flex-shrink-0">
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
              <div className="p-4 border-t border-dark-700 flex-shrink-0">
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
              <div className="p-4 border-t border-dark-700 flex-shrink-0">
                <h3 className="text-xs font-medium text-dark-500 uppercase mb-2">Summary</h3>
                <p className="text-dark-300">{task.summary}</p>
              </div>
            )}

            {/* Error */}
            {task.error && (
              <div className="p-4 border-t border-dark-700 flex-shrink-0">
                <h3 className="text-xs font-medium text-red-400 uppercase mb-2">Error</h3>
                <pre className="text-red-300 text-sm bg-red-500/10 p-3 rounded overflow-x-auto">
                  {task.error}
                </pre>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="p-4 border-t border-dark-700 space-y-2 flex-shrink-0">
            {task.status === 'completed' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const prompt = continuePrompt.trim();
                  if (!prompt) return;
                  continueTask.mutate({ taskId: task.id, prompt });
                  setContinuePrompt('');
                }}
                className="flex gap-2"
              >
                <input
                  type="text"
                  value={continuePrompt}
                  onChange={(e) => setContinuePrompt(e.target.value)}
                  placeholder="Follow-up message..."
                  disabled={continueTask.isPending}
                  className="flex-1 bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-dark-200 placeholder-dark-500 focus:outline-none focus:border-primary-500"
                />
                <button
                  type="submit"
                  disabled={continueTask.isPending || !continuePrompt.trim()}
                  className="btn btn-primary flex items-center justify-center gap-2 px-4"
                >
                  <Send size={16} />
                  Send
                </button>
              </form>
            )}
            <div className="flex gap-2">
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
          </div>
        </ErrorBoundary>
      </motion.div>
    </>
  );
}
