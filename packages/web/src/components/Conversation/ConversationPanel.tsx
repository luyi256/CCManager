import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
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
  Paperclip,
  X,
  Image,
  ArrowLeft,
  ChevronDown,
} from 'lucide-react';
import StatusBadge from '../common/StatusBadge';
import ErrorBoundary from '../common/ErrorBoundary';
import VoiceInput from '../common/VoiceInput';
import ModelSwitcher from './ModelSwitcher';
import { useTaskStream } from '../../hooks/useTaskStream';
import { useCancelTask, useRetryTask, useContinueTask, useTaskLogs, useTask } from '../../hooks/useTasks';
import { mergeTask, cleanupWorktree } from '../../services/api';
import type { Runner, Task } from '../../types';
import {
  type TimelineItem,
  groupTimeline,
  StreamPhaseIndicator,
  TimelineView,
} from '../Task/TimelineRenderer';
import { canSendFollowUpForTask, isTaskActive } from '../../utils/taskResume';
import { getTimestamp } from '../../utils/dateTime';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { readImageFiles, type PendingImage } from '../../utils/images';

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

function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

interface ConversationPanelProps {
  task: Task;
  agentId?: string;
  onBack?: () => void;
}

export default function ConversationPanel({ task: initialTask, agentId, onBack }: ConversationPanelProps) {
  const [autoScroll, setAutoScroll] = useState(true);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number>(0);
  const [sentMessages, setSentMessages] = useState<Array<{ content: string; timestamp: number }>>([]);
  const [showMeta, setShowMeta] = useState(false);

  // Live task data
  const { data: liveTask } = useTask(initialTask.id);
  const task = liveTask || initialTask;

  const isActive = isTaskActive(task.status);
  const canSendFollowUp = canSendFollowUpForTask(task);

  const prevStatusRef = useRef(task.status);
  const followUpTextareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: savedLogs, isLoading: logsLoading, refetch: refetchLogs } = useTaskLogs(task.id);
  const stream = useTaskStream(isActive ? task.id : null);
  const { isConnected } = useWebSocket();
  const streamReset = stream.reset;

  const cancelTask = useCancelTask();
  const retryTask = useRetryTask();
  const continueTask = useContinueTask();
  const [continuePrompt, setContinuePrompt] = useState('');
  const [followUpImages, setFollowUpImages] = useState<PendingImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [isReadingImages, setIsReadingImages] = useState(false);
  const followUpFileInputRef = useRef<HTMLInputElement>(null);

  // Model switching state for follow-up
  const [followUpRunner, setFollowUpRunner] = useState<Runner>(
    task.runner || 'claude'
  );
  const [followUpModel, setFollowUpModel] = useState(task.model || '');
  const sessionRunner = useMemo<Runner | undefined>(() => {
    if (task.sessionId) return task.sessionRunner || task.runner || 'claude';
    if (!task.gitInfo) return undefined;
    try {
      const metadata = JSON.parse(task.gitInfo) as { sessionId?: unknown; sessionRunner?: unknown };
      if (!metadata.sessionId) return undefined;
      return typeof metadata.sessionRunner === 'string'
        ? metadata.sessionRunner as Runner
        : task.runner || 'claude';
    } catch {
      return undefined;
    }
  }, [task.gitInfo, task.runner, task.sessionId, task.sessionRunner]);
  const runnerLocked = Boolean(
    sessionRunner &&
    ['completed', 'completed_with_warnings', 'failed', 'cancelled'].includes(task.status)
  );

  useEffect(() => {
    setFollowUpRunner(runnerLocked && sessionRunner ? sessionRunner : task.runner || 'claude');
    setFollowUpModel(task.model || '');
  }, [task.id, task.runner, task.model, sessionRunner, runnerLocked]);

  const handleFollowUpPaste = useCallback(async (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    if (isReadingImages) return;
    setIsReadingImages(true);
    try {
      const result = await readImageFiles(files, followUpImages);
      setFollowUpImages(result.images);
      setImageError(result.error || null);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'Could not read image');
    } finally {
      setIsReadingImages(false);
    }
  }, [followUpImages, isReadingImages]);

  const handleFollowUpFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    if (isReadingImages) return;
    setIsReadingImages(true);
    try {
      const result = await readImageFiles(files, followUpImages);
      setFollowUpImages(result.images);
      setImageError(result.error || null);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'Could not read image');
    } finally {
      setIsReadingImages(false);
      e.target.value = '';
    }
  }, [followUpImages, isReadingImages]);

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

    if (['completed', 'completed_with_warnings', 'cancelled', 'failed'].includes(prevStatus) && task.status === 'running') {
      streamReset();
      refetchLogs();
    }

    const wasActive = ['running', 'waiting', 'waiting_permission', 'plan_review'].includes(prevStatus);
    const isNowDone = ['completed', 'completed_with_warnings', 'failed', 'cancelled'].includes(task.status);
    if (wasActive && isNowDone) {
      setTimeout(() => refetchLogs(), 300);
    }
  }, [task.status, streamReset, refetchLogs]);

  // Clean up optimistic sentMessages
  useEffect(() => {
    if (savedLogs && sentMessages.length > 0) {
      const savedUserContents = new Set(
        savedLogs.filter(l => l.type === 'user_message').map(l => String(l.content))
      );
      setSentMessages(prev => prev.filter(m => !savedUserContents.has(m.content)));
    }
  }, [savedLogs, sentMessages.length]);

  // Build unified timeline
  const timeline = useMemo(() => {
    const items: TimelineItem[] = [];
    const savedUserMessages = new Set<string>();

    items.push({
      id: 'initial-prompt',
      type: 'user_message',
      timestamp: new Date(task.createdAt).getTime(),
      content: task.prompt,
    });

    if (savedLogs && savedLogs.length > 0) {
      savedLogs.forEach((log, index) => {
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
          const content = String(log.content);
          items.push({ id: `saved-output-${log.id}`, type: 'output', timestamp, content, logId: log.id });
        } else if (log.type === 'tool_use') {
          const data = log.content as { id: string; name: string; input: unknown };
          items.push({
            id: `saved-tool-${data.id || index}`,
            type: 'tool_use',
            timestamp,
            content: '',
            toolCallId: data.id,
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
            toolCallId: data.id,
            toolResult: data.result,
          });
        } else if (log.type === 'user_message') {
          savedUserMessages.add(String(log.content));
          items.push({ id: `saved-user-${index}`, type: 'user_message', timestamp, content: String(log.content) });
        }
      });
    }

    if (task.continuePrompt && savedUserMessages.size === 0 && sentMessages.length === 0) {
      const fallbackTs = task.startedAt ? new Date(task.startedAt).getTime() : Date.now();
      items.push({ id: 'fallback-continue-prompt', type: 'user_message', timestamp: fallbackTs, content: task.continuePrompt });
    }

    sentMessages.forEach((msg, index) => {
      if (!savedUserMessages.has(msg.content)) {
        items.push({ id: `local-user-${index}`, type: 'user_message', timestamp: msg.timestamp, content: msg.content });
      }
    });

    if (stream.messages.length > 0 || stream.toolCalls.length > 0) {
      stream.messages.forEach((msg) => {
        const persistedIndex = msg.logId === undefined
          ? -1
          : items.findIndex((item) => item.type === 'output' && item.logId === msg.logId);
        const streamItem: TimelineItem = {
          id: `stream-${msg.id}`,
          type: 'output',
          timestamp: msg.timestamp,
          content: msg.text,
          logId: msg.logId,
        };
        if (persistedIndex >= 0) items[persistedIndex] = streamItem;
        else items.push(streamItem);
      });
      stream.toolCalls.forEach((tc) => {
        const existingTool = items.find(i =>
          i.type === 'tool_use' && (i.toolCallId === tc.id || i.id.includes(tc.id))
        );
        if (existingTool) {
          existingTool.toolStatus = tc.status;
          if (tc.result !== undefined) existingTool.toolResult = tc.result;
        }
        if (!existingTool) {
          items.push({
            id: `stream-tool-${tc.id}`,
            type: 'tool_use',
            timestamp: tc.timestamp,
            content: '',
            toolCallId: tc.id,
            toolName: tc.name,
            toolInput: tc.input,
            toolResult: tc.result,
            toolStatus: tc.status,
          });
        }
      });
    }

    items.sort((a, b) => a.timestamp - b.timestamp);
    return items;
  }, [savedLogs, stream.messages, stream.toolCalls, sentMessages, task.prompt, task.createdAt, task.continuePrompt, task.startedAt]);

  const grouped = useMemo(() => groupTimeline(timeline), [timeline]);
  const hasContent = timeline.length > 0 || isActive;
  const hasAssistantActivity = timeline.some((item) => item.type === 'output' || item.type === 'tool_use');
  const waitingForFirstActivity = isActive && !logsLoading && !hasAssistantActivity && !stream.planQuestion && !stream.permissionRequest;
  const firstActivityStartedAt = getTimestamp(task.startedAt || task.createdAt);
  const [waitingSeconds, setWaitingSeconds] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!waitingForFirstActivity) {
      setWaitingSeconds(0);
      return;
    }
    const update = () => setWaitingSeconds(
      firstActivityStartedAt ? Math.max(0, Math.floor((Date.now() - firstActivityStartedAt) / 1000)) : 0
    );
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [waitingForFirstActivity, firstActivityStartedAt]);

  useEffect(() => {
    if (!isActive || !firstActivityStartedAt) {
      setElapsedSeconds(0);
      return;
    }
    const update = () => setElapsedSeconds(
      Math.max(0, Math.floor((Date.now() - firstActivityStartedAt) / 1000))
    );
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [isActive, firstActivityStartedAt]);

  useEffect(() => {
    if (isConnected) refetchLogs();
  }, [isConnected, refetchLogs]);

  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= 80;
    setAutoScroll(isAtBottom);
  }, []);

  useEffect(() => {
    if (!autoScroll) return;
    cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      const container = messagesContainerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }, [autoScroll, timeline.length, stream.messages, stream.toolCalls]);

  useEffect(() => {
    return () => cancelAnimationFrame(scrollRafRef.current);
  }, []);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container && timeline.length > 0) {
      container.scrollTop = container.scrollHeight;
    }
  }, [task.id]);

  // Reset follow-up model when task changes
  useEffect(() => {
    setFollowUpRunner(task.runner || 'claude');
    setFollowUpModel(task.model || '');
  }, [task.id, task.runner, task.model]);

  return (
    <div className="flex-1 min-h-0 flex flex-col min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-dark-700 flex-shrink-0 bg-dark-850">
        {onBack && (
          <button onClick={onBack} className="md:hidden p-1 text-dark-400 hover:text-dark-100" aria-label="Open conversations">
            <ArrowLeft size={20} />
          </button>
        )}
        <span className="text-dark-500 font-mono text-sm">#{task.id}</span>
        <StatusBadge status={task.status} />
        {isActive && <StreamPhaseIndicator phase={stream.phase} />}
        {isActive && (
          <span className="text-xs text-dark-500 tabular-nums hidden sm:inline">
            {formatElapsed(elapsedSeconds)}
          </span>
        )}
        {(task.recoveryCount || 0) > 0 && (
          <span
            className="px-2 py-0.5 rounded text-xs bg-amber-500/15 text-amber-300"
            title={task.lastRecoveryAt ? `Last recovery: ${formatDate(task.lastRecoveryAt)}` : undefined}
          >
            Recovered {task.recoveryCount}×
          </span>
        )}
        {task.isPlanMode && (
          <span className="px-2 py-0.5 bg-purple-500/20 text-purple-400 rounded text-xs">Plan</span>
        )}
        {task.model && (
          <span className="text-xs text-dark-400 hidden sm:inline">
            {task.model.replace(/^claude-/, '')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {task.worktreeBranch && (
            <span className="text-xs text-dark-400 flex items-center gap-1 mr-2">
              <GitBranch size={12} /> {task.worktreeBranch}
            </span>
          )}
          <button
            onClick={() => setShowMeta(!showMeta)}
            className="p-1 text-dark-400 hover:text-dark-200"
            aria-label={showMeta ? 'Hide conversation details' : 'Show conversation details'}
            aria-expanded={showMeta}
          >
            <ChevronDown size={16} className={`transition-transform ${showMeta ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      {/* Collapsible meta info */}
      {showMeta && (
        <div className="px-4 py-3 border-b border-dark-700 grid grid-cols-2 gap-3 text-sm flex-shrink-0 bg-dark-850/50">
          {task.createdAt && (
            <div>
              <span className="text-dark-500 flex items-center gap-1"><Clock size={14} /> Created</span>
              <span className="text-dark-300 mt-0.5 block text-xs">{formatDate(task.createdAt)}</span>
            </div>
          )}
          {task.startedAt && (
            <div>
              <span className="text-dark-500 flex items-center gap-1"><Clock size={14} /> Started</span>
              <span className="text-dark-300 mt-0.5 block text-xs">{formatDate(task.startedAt)}</span>
            </div>
          )}
          {(task.attemptCount || 0) > 0 && (
            <div>
              <span className="text-dark-500">Attempt</span>
              <span className="text-dark-300 mt-0.5 block text-xs">
                {task.attemptCount}
                {(task.recoveryCount || 0) > 0 ? ` (${task.recoveryCount} automatic recoveries)` : ''}
              </span>
            </div>
          )}
          {task.lastProgressAt && (
            <div>
              <span className="text-dark-500">Last progress</span>
              <span className="text-dark-300 mt-0.5 block text-xs">{formatDate(task.lastProgressAt)}</span>
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
      )}

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <ErrorBoundary>
          {/* Timeline content */}
          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          {hasContent && (
            <div className="flex-1 relative min-h-0">
              <div
                ref={messagesContainerRef}
                onScroll={handleScroll}
                className="h-full overflow-y-auto px-2 sm:px-4"
              >
                <div className="max-w-3xl mx-auto py-4">
                  {timeline.length === 0 ? (
                    <div className="p-6 text-dark-500 text-sm text-center">
                      {logsLoading ? (
                        <div className="flex items-center justify-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-dark-500 animate-pulse" />
                          Loading conversation history…
                        </div>
                      ) : isActive ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-center gap-2 text-dark-300">
                            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                            <StreamPhaseIndicator phase={stream.phase} />
                          </div>
                          <p className="text-xs text-dark-500">
                            {isConnected
                              ? `${waitingSeconds < 30 ? 'Runner is preparing' : 'Model is reasoning'} • ${formatElapsed(waitingSeconds)}`
                              : 'Reconnecting to live updates…'}
                          </p>
                        </div>
                      ) : 'No output recorded'}
                    </div>
                  ) : (
                    <TimelineView grouped={grouped} />
                  )}
                </div>
              </div>
              {/* Scroll-to-bottom */}
              {!autoScroll && timeline.length > 0 && (
                <button
                  onClick={() => {
                    const container = messagesContainerRef.current;
                    if (container) container.scrollTop = container.scrollHeight;
                    setAutoScroll(true);
                  }}
                  className="absolute bottom-4 right-4 p-2 bg-primary-600 hover:bg-primary-500 text-white rounded-full shadow-lg transition-colors"
                  title="Scroll to bottom"
                  aria-label="Scroll to bottom"
                >
                  <ArrowDown size={16} />
                </button>
              )}
            </div>
          )}

          {/* Plan Question */}
          {stream.planQuestion && (
            <div className="p-4 border-t border-dark-700 flex-shrink-0">
              <h3 className="text-xs font-medium text-purple-400 uppercase mb-2">Question from agent</h3>
              <p className="text-dark-200 mb-3">{stream.planQuestion.question}</p>
              <div className="space-y-2">
                {stream.planQuestion.options.map((opt, idx) => (
                  <button
                    key={idx}
                    onClick={() => stream.answerQuestion(opt.label)}
                    className="w-full text-left card p-3 hover:border-primary-500 transition-colors"
                  >
                    <div className="font-medium text-dark-200">{opt.label}</div>
                    {opt.description && <div className="text-sm text-dark-400 mt-1">{opt.description}</div>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Permission Request */}
          {stream.permissionRequest && (
            <div className="p-4 border-t border-dark-700 flex-shrink-0">
              <h3 className="text-xs font-medium text-orange-400 uppercase mb-2">Permission Request</h3>
              <div className="bg-dark-900 rounded-lg p-3 mb-3">
                <div className="text-dark-300 mb-1">{stream.permissionRequest.action}</div>
                <code className="text-xs text-dark-400 block bg-dark-800 p-2 rounded mt-2">
                  {stream.permissionRequest.target}
                </code>
              </div>
              <div className="flex gap-2">
                <button onClick={() => stream.handlePermission('deny')} className="btn btn-secondary flex-1">Deny</button>
                <button onClick={() => stream.handlePermission('approve')} className="btn btn-primary flex-1">Approve</button>
              </div>
            </div>
          )}

          {/* Summary */}
          {task.summary && (
            <div className="p-4 border-t border-dark-700 flex-shrink-0">
              <h3 className="text-xs font-medium text-dark-500 uppercase mb-2">Summary</h3>
              <p className="text-dark-300 text-sm">{task.summary}</p>
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
                  <button onClick={() => { setMergeStatus('idle'); setMergeError(null); }} className="text-xs text-dark-400 hover:text-dark-200">Dismiss</button>
                </div>
              ) : (
                <div className="flex gap-2 flex-wrap">
                  <button
                    onClick={async () => {
                      setMergeStatus('merging');
                      try { await mergeTask(task.id, false); setMergeStatus('merged'); }
                      catch (err) { setMergeStatus('error'); setMergeError(err instanceof Error ? err.message : 'Merge failed'); }
                    }}
                    disabled={mergeStatus === 'merging'}
                    className="btn btn-primary text-xs py-1.5 px-3 flex items-center gap-1"
                  >
                    <GitMerge size={14} /> {mergeStatus === 'merging' ? 'Merging...' : 'Merge'}
                  </button>
                  <button
                    onClick={async () => {
                      setMergeStatus('merging');
                      try { await mergeTask(task.id, true); setMergeStatus('merged'); }
                      catch (err) { setMergeStatus('error'); setMergeError(err instanceof Error ? err.message : 'Merge failed'); }
                    }}
                    disabled={mergeStatus === 'merging'}
                    className="btn btn-secondary text-xs py-1.5 px-3 flex items-center gap-1"
                  >
                    <GitMerge size={14} /> Merge & Delete Branch
                  </button>
                  <button
                    onClick={async () => {
                      if (!confirm('Delete worktree and discard all changes?')) return;
                      try { await cleanupWorktree(task.id); setMergeStatus('merged'); }
                      catch (err) { setMergeStatus('error'); setMergeError(err instanceof Error ? err.message : 'Cleanup failed'); }
                    }}
                    disabled={mergeStatus === 'merging'}
                    className="btn btn-secondary text-xs py-1.5 px-3 flex items-center gap-1 text-red-400 hover:text-red-300"
                  >
                    <Trash2 size={14} /> Discard
                  </button>
                </div>
              )}
            </div>
          )}
          </div>

          {/* Bottom actions + input */}
          <div className="border-t border-dark-700 flex-shrink-0 bg-dark-850">
          {/* Follow-up input */}
          {canSendFollowUp && (
            <div className="p-3">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const prompt = continuePrompt.trim();
                  if ((!prompt && followUpImages.length === 0) || isReadingImages) return;
                  const effectivePrompt = prompt ||
                    `Please analyze the ${followUpImages.length} attached image${followUpImages.length === 1 ? '' : 's'}.`;
                  const imageBase64s = followUpImages.length > 0 ? followUpImages.map(img => img.dataUrl) : undefined;
                  const optimistic = { content: effectivePrompt, timestamp: Date.now() };
                  setSentMessages(prev => [...prev, optimistic]);
                  continueTask.mutate({
                    taskId: task.id,
                    prompt: effectivePrompt,
                    images: imageBase64s,
                    runner: followUpRunner,
                    model: followUpModel,
                  }, {
                    onSuccess: () => {
                      setContinuePrompt('');
                      setFollowUpImages([]);
                      if (followUpTextareaRef.current) followUpTextareaRef.current.style.height = 'auto';
                    },
                    onError: () => {
                      setSentMessages((prev) => prev.filter((message) => message !== optimistic));
                    },
                  });
                }}
              >
                {stream.followUpQueueSize > 0 && (
                  <div className="text-xs text-amber-400/80 mb-1.5 px-1">
                    {stream.followUpQueueSize} message{stream.followUpQueueSize > 1 ? 's' : ''} queued
                  </div>
                )}
                <div className="relative bg-dark-800 border border-dark-600 rounded-lg focus-within:border-primary-500">
                  <textarea
                    ref={followUpTextareaRef}
                    value={continuePrompt}
                    onChange={(e) => setContinuePrompt(e.target.value)}
                    onPaste={handleFollowUpPaste}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder={stream.followUpQueueSize > 0 ? "Add another message..." : "Follow-up message..."}
                    disabled={continueTask.isPending || isReadingImages}
                    rows={1}
                    className="w-full bg-transparent px-3 py-2 pr-28 text-sm leading-normal text-dark-200 placeholder-dark-500 focus:outline-none resize-none overflow-hidden max-h-40"
                  />
                  <div className="absolute right-2 bottom-1.5 flex items-center gap-1">
                    <ModelSwitcher
                      selectedRunner={followUpRunner}
                      selectedModel={followUpModel}
                      onRunnerChange={setFollowUpRunner}
                      onModelChange={setFollowUpModel}
                      agentId={agentId}
                      compact
                      lockRunner={runnerLocked}
                    />
                    <input ref={followUpFileInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple className="hidden" onChange={handleFollowUpFileSelect} />
                    <button
                      type="button"
                      onClick={() => followUpFileInputRef.current?.click()}
                      disabled={continueTask.isPending || isReadingImages}
                      className="p-1 rounded-md text-dark-400 hover:text-dark-200 disabled:text-dark-600 transition-colors"
                      title="Attach images"
                    >
                      <Paperclip size={14} />
                    </button>
                    <VoiceInput compact onTranscription={(text) => setContinuePrompt((prev) => (prev ? `${prev} ${text}` : text))} />
                    <button
                      type="submit"
                      disabled={continueTask.isPending || isReadingImages || (!continuePrompt.trim() && followUpImages.length === 0)}
                      className="p-1.5 rounded-md text-dark-400 hover:text-primary-400 disabled:text-dark-600 disabled:cursor-not-allowed transition-colors"
                    >
                      <Send size={16} />
                    </button>
                  </div>
                </div>
                {followUpImages.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {followUpImages.map((img) => (
                      <div key={img.id} className="relative group w-12 h-12 rounded-lg overflow-hidden border border-dark-600 bg-dark-800">
                        <img src={img.dataUrl} alt={img.name} className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={() => removeFollowUpImage(img.id)}
                          className="absolute top-0 right-0 p-0.5 bg-dark-900/80 rounded-bl-lg text-dark-300 hover:text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 transition-opacity"
                          aria-label={`Remove ${img.name}`}
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                    <div className="flex items-center text-dark-500 text-xs gap-1">
                      <Image size={10} /><span>{followUpImages.length}</span>
                    </div>
                  </div>
                )}
                {imageError && <p className="text-red-400 text-xs mt-2" role="alert">{imageError}</p>}
                {isReadingImages && <p className="text-dark-500 text-xs mt-2">Preparing images…</p>}
              </form>
              {continueTask.isError && (
                <p className="text-red-400 text-xs mt-2" role="alert">
                  {continueTask.error instanceof Error ? continueTask.error.message : 'Failed to send follow-up'}
                </p>
              )}
            </div>
          )}

          {/* Action buttons */}
          {(isActive || task.status === 'failed' || task.status === 'cancelled' || task.status === 'plan_review') && (
            <div className="px-3 pb-3 flex gap-2">
              {isActive && task.status !== 'plan_review' && (
                <button
                  onClick={() => cancelTask.mutate(task.id)}
                  disabled={cancelTask.isPending}
                  className="btn btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
                >
                  <Square size={14} /> Cancel
                </button>
              )}
              {(task.status === 'failed' || task.status === 'cancelled') && (
                <button
                  onClick={() => retryTask.mutate(task.id)}
                  disabled={retryTask.isPending}
                  className="btn btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
                >
                  <RotateCcw size={14} /> Retry
                </button>
              )}
              {task.status === 'plan_review' && (
                <button
                  onClick={stream.confirm}
                  className="btn btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
                >
                  <Play size={14} /> Confirm Plan
                </button>
              )}
            </div>
          )}
          </div>
        </ErrorBoundary>
      </div>
    </div>
  );
}
