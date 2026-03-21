import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  X,
  Play,
  Square,
  RotateCcw,
  GitBranch,
  GitMerge,
  Trash2,
  Clock,
  AlertTriangle,
  ArrowDown,
  Send,
  MessageSquare,
  ChevronRight,
  ChevronDown,
  Paperclip,
  Image,
} from 'lucide-react';
import StatusBadge from '../common/StatusBadge';
import ErrorBoundary from '../common/ErrorBoundary';
import SafeMarkdown from '../common/SafeMarkdown';
import VoiceInput from '../common/VoiceInput';
import { useTaskStream } from '../../hooks/useTaskStream';
import { useCancelTask, useRetryTask, useContinueTask, useTaskLogs, useTask } from '../../hooks/useTasks';
import { mergeTask, cleanupWorktree } from '../../services/api';
import type { Task } from '../../types';

interface PastedImage {
  id: string;
  dataUrl: string;
  name: string;
}

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
  type: 'output' | 'tool_use' | 'tool_result' | 'user_message';
  timestamp: number;
  content: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  toolStatus?: 'pending' | 'running' | 'completed';
}

// Single collapsible tool call
function ToolCallItem({ item, defaultExpanded = false }: { item: TimelineItem; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const inputStr = safeStringify(item.toolInput);
  const resultStr = item.toolResult != null
    ? (typeof item.toolResult === 'string' ? item.toolResult : safeStringify(item.toolResult))
    : null;

  return (
    <div className="flex-1 min-w-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 w-full text-left group"
      >
        {expanded
          ? <ChevronDown size={14} className="text-green-400 flex-shrink-0" />
          : <ChevronRight size={14} className="text-green-400 flex-shrink-0" />
        }
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
        {!expanded && (
          <span className="text-xs text-dark-600 ml-auto truncate max-w-[50%]">
            {inputStr.length > 60 ? inputStr.slice(0, 60) + '...' : inputStr}
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1 ml-5">
          <pre className="text-xs text-dark-400 bg-dark-900 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
            {inputStr}
          </pre>
          {resultStr != null && (
            <div className="mt-2">
              <span className="text-xs text-dark-500">Result:</span>
              <pre className="text-xs text-dark-300 bg-dark-900 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all mt-1">
                {resultStr.length > 500 ? resultStr.slice(0, 500) + '...' : resultStr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Grouped display for consecutive tool calls
function ToolCallGroup({ items }: { items: TimelineItem[] }) {
  const [expanded, setExpanded] = useState(false);

  if (items.length === 1) {
    return <ToolCallItem item={items[0]} />;
  }

  const lastItem = items[items.length - 1];
  const hiddenCount = items.length - 1;

  return (
    <div className="flex-1 min-w-0">
      {expanded && (
        <div className="space-y-2 mb-2">
          {items.slice(0, -1).map((item) => (
            <ToolCallItem key={item.id} item={item} />
          ))}
        </div>
      )}
      <ToolCallItem item={lastItem} defaultExpanded={false} />
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-1 ml-5 text-xs text-dark-500 hover:text-dark-300 transition-colors"
      >
        {expanded ? 'Hide' : `Show ${hiddenCount} more tool call${hiddenCount > 1 ? 's' : ''}`}
      </button>
    </div>
  );
}

// Group consecutive tool_use items in timeline
type GroupedItem =
  | { type: 'single'; item: TimelineItem }
  | { type: 'tool_group'; items: TimelineItem[] };

function groupTimeline(timeline: TimelineItem[]): GroupedItem[] {
  const groups: GroupedItem[] = [];
  let toolBuffer: TimelineItem[] = [];

  const flushTools = () => {
    if (toolBuffer.length === 0) return;
    if (toolBuffer.length === 1) {
      groups.push({ type: 'single', item: toolBuffer[0] });
    } else {
      groups.push({ type: 'tool_group', items: [...toolBuffer] });
    }
    toolBuffer = [];
  };

  for (const item of timeline) {
    if (item.type === 'tool_use' || item.type === 'tool_result') {
      if (item.type === 'tool_use') {
        toolBuffer.push(item);
      }
      // tool_result items are already embedded in tool_use via toolResult, skip standalone
    } else {
      flushTools();
      groups.push({ type: 'single', item });
    }
  }
  flushTools();
  return groups;
}

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
}

export default function TaskDetail({ task: initialTask, onClose }: TaskDetailProps) {
  const [autoScroll, setAutoScroll] = useState(true);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number>(0);
  const [followUpQueue, setFollowUpQueue] = useState<Array<{ prompt: string; images?: string[] }>>([]);
  const [sentMessages, setSentMessages] = useState<Array<{ content: string; timestamp: number }>>([]);

  // Use live task data with refetch, falling back to initial prop
  const { data: liveTask } = useTask(initialTask.id);
  const task = liveTask || initialTask;

  const isActive = ['running', 'waiting', 'waiting_permission', 'plan_review'].includes(
    task.status
  );

  // Track previous status to detect transitions
  const prevStatusRef = useRef(task.status);
  const followUpTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Always load saved logs (for history)
  const { data: savedLogs, refetch: refetchLogs } = useTaskLogs(task.id);
  // Stream for active tasks
  const stream = useTaskStream(isActive ? task.id : null);

  const cancelTask = useCancelTask();
  const retryTask = useRetryTask();
  const continueTask = useContinueTask();
  const [continuePrompt, setContinuePrompt] = useState('');
  const [followUpImages, setFollowUpImages] = useState<PastedImage[]>([]);
  const followUpFileInputRef = useRef<HTMLInputElement>(null);

  const handleFollowUpPaste = useCallback((e: React.ClipboardEvent) => {
    if (e.clipboardData?.items) {
      for (let i = 0; i < e.clipboardData.items.length; i++) {
        const item = e.clipboardData.items[i];
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = (ev) => {
            const dataUrl = ev.target?.result as string;
            if (dataUrl) {
              setFollowUpImages(prev => [
                ...prev,
                {
                  id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  dataUrl,
                  name: file.name || `screenshot-${Date.now()}.png`,
                },
              ]);
            }
          };
          reader.readAsDataURL(file);
        }
      }
    }
  }, []);

  const handleFollowUpFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        if (dataUrl) {
          setFollowUpImages(prev => [
            ...prev,
            {
              id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              dataUrl,
              name: file.name || `image-${Date.now()}.png`,
            },
          ]);
        }
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  }, []);

  const removeFollowUpImage = useCallback((id: string) => {
    setFollowUpImages(prev => prev.filter(img => img.id !== id));
  }, []);

  useEffect(() => {
    const el = followUpTextareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [continuePrompt]);

  const [mergeStatus, setMergeStatus] = useState<'idle' | 'merging' | 'merged' | 'error'>('idle');
  const [mergeError, setMergeError] = useState<string | null>(null);

  // Handle task status transitions
  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = task.status;

    // If transitioning from completed to running (continuation), reset stream
    if (prevStatus === 'completed' && task.status === 'running') {
      stream.reset();
      // Refetch logs to get any newly saved content
      refetchLogs();
    }

    // If transitioning from running to completed/failed, refetch logs to get follow-up output
    const wasActive = ['running', 'waiting', 'waiting_permission', 'plan_review'].includes(prevStatus);
    const isNowDone = ['completed', 'completed_with_warnings', 'failed', 'cancelled'].includes(task.status);
    if (wasActive && isNowDone) {
      // Small delay to ensure server has saved all output logs
      setTimeout(() => refetchLogs(), 300);
    }
  }, [task.status, stream, refetchLogs]);

  // Auto-send queued follow-ups when task completes
  useEffect(() => {
    if (task.status === 'completed' && followUpQueue.length > 0 && !continueTask.isPending) {
      const nextItem = followUpQueue[0];
      setFollowUpQueue(prev => prev.slice(1));
      setSentMessages(prev => [...prev, { content: nextItem.prompt, timestamp: Date.now() }]);
      continueTask.mutate({ taskId: task.id, prompt: nextItem.prompt, images: nextItem.images });
    }
  }, [task.status, followUpQueue, continueTask, task.id]);

  // Clean up optimistic sentMessages once they appear in savedLogs
  useEffect(() => {
    if (savedLogs && sentMessages.length > 0) {
      const savedUserContents = new Set(
        savedLogs.filter(l => l.type === 'user_message').map(l => String(l.content))
      );
      setSentMessages(prev => prev.filter(m => !savedUserContents.has(m.content)));
    }
  }, [savedLogs, sentMessages.length]);

  // Build unified timeline from saved logs and stream
  const timeline = useMemo(() => {
    const items: TimelineItem[] = [];
    // Track saved user_message contents for dedup with optimistic messages
    const savedUserMessages = new Set<string>();

    // Add the initial task prompt as the first message in the timeline
    items.push({
      id: 'initial-prompt',
      type: 'user_message',
      timestamp: new Date(task.createdAt).getTime(),
      content: task.prompt,
    });

    // Add saved logs first
    if (savedLogs && savedLogs.length > 0) {
      savedLogs.forEach((log, index) => {
        // Parse timestamp: SQLite datetime('now') gives 'YYYY-MM-DD HH:MM:SS' (UTC but no Z),
        // while ISO strings have 'T' and 'Z'. Append 'Z' to timezone-less strings to parse as UTC.
        let timestamp: number;
        if (typeof log.timestamp === 'number') {
          timestamp = log.timestamp;
        } else if (log.timestamp) {
          const ts = log.timestamp;
          timestamp = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z').getTime();
        } else {
          timestamp = 0;
        }

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
        } else if (log.type === 'user_message') {
          savedUserMessages.add(String(log.content));
          items.push({
            id: `saved-user-${index}`,
            type: 'user_message',
            timestamp,
            content: String(log.content),
          });
        }
      });
    }

    // Fallback: if task has continuePrompt but no user_message in saved logs,
    // show continuePrompt as a follow-up (for tasks created before user_message logging)
    if (task.continuePrompt && savedUserMessages.size === 0) {
      const fallbackTs = task.startedAt
        ? new Date(task.startedAt).getTime()
        : Date.now();
      items.push({
        id: 'fallback-continue-prompt',
        type: 'user_message',
        timestamp: fallbackTs,
        content: task.continuePrompt,
      });
    }

    // Add optimistic sent messages (dedup against saved logs)
    sentMessages.forEach((msg, index) => {
      if (!savedUserMessages.has(msg.content)) {
        items.push({
          id: `local-user-${index}`,
          type: 'user_message',
          timestamp: msg.timestamp,
          content: msg.content,
        });
      }
    });

    // Add stream messages (show even after completion to prevent flash before logs refetch)
    if (stream.messages.length > 0) {
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
  }, [savedLogs, stream.messages, stream.toolCalls, sentMessages, task.prompt, task.createdAt, task.continuePrompt, task.startedAt]);

  const grouped = useMemo(() => groupTimeline(timeline), [timeline]);

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
                        {grouped.map((group, gi) => {
                          if (group.type === 'tool_group') {
                            return (
                              <div key={`group-${gi}`} className="p-3">
                                <ToolCallGroup items={group.items} />
                              </div>
                            );
                          }
                          const item = group.item;
                          return (
                            <div key={item.id} className="p-3">
                              {item.type === 'output' ? (
                                <div className="flex gap-2">
                                  <MessageSquare size={14} className="text-blue-400 flex-shrink-0 mt-1" />
                                  <div className="flex-1 prose prose-invert prose-sm max-w-none overflow-hidden break-words">
                                    <SafeMarkdown>{item.content}</SafeMarkdown>
                                  </div>
                                </div>
                              ) : item.type === 'user_message' ? (
                                <div className="flex gap-2 bg-primary-500/10 rounded-lg -mx-1 px-1 py-1">
                                  <Send size={14} className="text-primary-400 flex-shrink-0 mt-1" />
                                  <div className="flex-1">
                                    <div className="text-xs font-medium text-primary-400 uppercase mb-1">
                                      {item.id === 'initial-prompt' ? 'Prompt' : 'Follow-up'}
                                    </div>
                                    <p className="text-dark-200 break-words">{item.content}</p>
                                  </div>
                                </div>
                              ) : item.type === 'tool_use' ? (
                                <ToolCallItem item={item} />
                              ) : null}
                            </div>
                          );
                        })}
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
                <pre className="text-red-300 text-sm bg-red-500/10 p-3 rounded overflow-x-auto whitespace-pre-wrap break-words">
                  {task.error}
                </pre>
              </div>
            )}

            {/* Worktree Actions */}
            {task.worktreeBranch && ['completed', 'completed_with_warnings', 'failed'].includes(task.status) && (
              <div className="p-4 border-t border-dark-700 flex-shrink-0">
                <h3 className="text-xs font-medium text-dark-500 uppercase mb-2 flex items-center gap-1">
                  <GitBranch size={14} /> Worktree: {task.worktreeBranch}
                </h3>
                {mergeStatus === 'merged' ? (
                  <div className="text-green-400 text-sm flex items-center gap-1">
                    <GitMerge size={14} /> Merged successfully
                  </div>
                ) : mergeStatus === 'error' ? (
                  <div className="space-y-2">
                    <div className="text-red-400 text-sm">{mergeError}</div>
                    <button
                      onClick={() => { setMergeStatus('idle'); setMergeError(null); }}
                      className="text-xs text-dark-400 hover:text-dark-200"
                    >
                      Dismiss
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        setMergeStatus('merging');
                        try {
                          await mergeTask(task.id, false);
                          setMergeStatus('merged');
                        } catch (err) {
                          setMergeStatus('error');
                          setMergeError(err instanceof Error ? err.message : 'Merge failed');
                        }
                      }}
                      disabled={mergeStatus === 'merging'}
                      className="btn btn-primary text-xs py-1.5 px-3 flex items-center gap-1"
                    >
                      <GitMerge size={14} />
                      {mergeStatus === 'merging' ? 'Merging...' : 'Merge'}
                    </button>
                    <button
                      onClick={async () => {
                        setMergeStatus('merging');
                        try {
                          await mergeTask(task.id, true);
                          setMergeStatus('merged');
                        } catch (err) {
                          setMergeStatus('error');
                          setMergeError(err instanceof Error ? err.message : 'Merge failed');
                        }
                      }}
                      disabled={mergeStatus === 'merging'}
                      className="btn btn-secondary text-xs py-1.5 px-3 flex items-center gap-1"
                    >
                      <GitMerge size={14} />
                      Merge & Delete Branch
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm('Delete worktree and discard all changes?')) return;
                        try {
                          await cleanupWorktree(task.id);
                          setMergeStatus('merged');
                        } catch (err) {
                          setMergeStatus('error');
                          setMergeError(err instanceof Error ? err.message : 'Cleanup failed');
                        }
                      }}
                      disabled={mergeStatus === 'merging'}
                      className="btn btn-secondary text-xs py-1.5 px-3 flex items-center gap-1 text-red-400 hover:text-red-300"
                    >
                      <Trash2 size={14} />
                      Discard
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="p-4 border-t border-dark-700 space-y-2 flex-shrink-0">
            {/* Follow-up input: show for completed (send immediately) or running (queue) */}
            {(task.status === 'completed' || isActive) && (
              <>
                {/* Show queued messages */}
                {followUpQueue.length > 0 && (
                  <div className="mb-2 p-2 bg-dark-800 rounded-lg">
                    <div className="text-xs text-dark-400 mb-1">Queued follow-ups (will send when task completes):</div>
                    {followUpQueue.map((msg, idx) => (
                      <div key={idx} className="flex items-center justify-between text-sm text-dark-300 py-1">
                        <span className="truncate flex-1">
                          {msg.prompt}
                          {msg.images && msg.images.length > 0 && (
                            <span className="ml-1 text-dark-500">({msg.images.length} image{msg.images.length > 1 ? 's' : ''})</span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => setFollowUpQueue(prev => prev.filter((_, i) => i !== idx))}
                          className="ml-2 text-dark-500 hover:text-red-400"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const prompt = continuePrompt.trim();
                    if (!prompt && followUpImages.length === 0) return;
                    const imageBase64s = followUpImages.length > 0 ? followUpImages.map(img => img.dataUrl) : undefined;
                    if (task.status === 'completed') {
                      setSentMessages(prev => [...prev, { content: prompt, timestamp: Date.now() }]);
                      continueTask.mutate({ taskId: task.id, prompt, images: imageBase64s });
                    } else {
                      setFollowUpQueue(prev => [...prev, { prompt, images: imageBase64s }]);
                    }
                    setContinuePrompt('');
                    setFollowUpImages([]);
                    if (followUpTextareaRef.current) followUpTextareaRef.current.style.height = 'auto';
                  }}
                >
                  <div className="relative bg-dark-800 border border-dark-600 rounded-lg focus-within:border-primary-500">
                    <textarea
                      ref={followUpTextareaRef}
                      value={continuePrompt}
                      onChange={(e) => setContinuePrompt(e.target.value)}
                      onPaste={handleFollowUpPaste}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          e.currentTarget.form?.requestSubmit();
                        }
                      }}
                      placeholder={isActive ? "Queue follow-up message..." : "Follow-up message..."}
                      disabled={continueTask.isPending}
                      rows={1}
                      className="w-full bg-transparent px-3 py-1 pr-20 text-sm leading-normal text-dark-200 placeholder-dark-500 focus:outline-none resize-none overflow-hidden max-h-40"
                    />
                    <div className="absolute right-2 bottom-1 flex items-center gap-1">
                      <input
                        ref={followUpFileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={handleFollowUpFileSelect}
                      />
                      <button
                        type="button"
                        onClick={() => followUpFileInputRef.current?.click()}
                        disabled={continueTask.isPending}
                        className="p-1 rounded-md text-dark-400 hover:text-dark-200 disabled:text-dark-600 transition-colors"
                        title="Attach images"
                      >
                        <Paperclip size={14} />
                      </button>
                      <VoiceInput
                        compact
                        onTranscription={(text) => setContinuePrompt((prev) => (prev ? `${prev} ${text}` : text))}
                      />
                      <button
                        type="submit"
                        disabled={continueTask.isPending || (!continuePrompt.trim() && followUpImages.length === 0)}
                        className="p-1.5 rounded-md text-dark-400 hover:text-primary-400 disabled:text-dark-600 disabled:cursor-not-allowed transition-colors"
                      >
                        <Send size={16} />
                      </button>
                    </div>
                  </div>
                  {/* Image previews */}
                  {followUpImages.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {followUpImages.map((img) => (
                        <div
                          key={img.id}
                          className="relative group w-12 h-12 rounded-lg overflow-hidden border border-dark-600 bg-dark-800"
                        >
                          <img
                            src={img.dataUrl}
                            alt={img.name}
                            className="w-full h-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => removeFollowUpImage(img.id)}
                            className="absolute top-0 right-0 p-0.5 bg-dark-900/80 rounded-bl-lg text-dark-400 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <X size={10} />
                          </button>
                        </div>
                      ))}
                      <div className="flex items-center text-dark-500 text-xs gap-1">
                        <Image size={10} />
                        <span>{followUpImages.length}</span>
                      </div>
                    </div>
                  )}
                </form>
              </>
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
