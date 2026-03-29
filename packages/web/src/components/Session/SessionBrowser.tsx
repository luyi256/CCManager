import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  X,
  ArrowLeft,
  Search,
  GitBranch,
  Clock,
  ArrowDown,
  ExternalLink,
  Send,
  ChevronDown,
} from 'lucide-react';
import { useSessions, useActiveSessions, useSessionDetail } from '../../hooks/useSessions';
import { continueSession } from '../../services/api';
import { groupTimeline, TimelineView } from '../Task/TimelineRenderer';
import type { TimelineItem } from '../Task/TimelineRenderer';
import type { Task } from '../../types';

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface SessionBrowserProps {
  projectId: string;
  onClose: () => void;
  onNavigateToTask?: (taskId: number) => void;
  onTaskCreated?: (task: Task) => void;
}

export default function SessionBrowser({ projectId, onClose, onNavigateToTask, onTaskCreated }: SessionBrowserProps) {
  const [selectedSession, setSelectedSession] = useState<{ id: string; relatedIds?: string[] } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <>
      {/* Backdrop */}
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
        {selectedSession ? (
          <SessionDetailView
            projectId={projectId}
            sessionId={selectedSession.id}
            relatedSessionIds={selectedSession.relatedIds}
            onBack={() => setSelectedSession(null)}
            onClose={onClose}
            onNavigateToTask={onNavigateToTask}
            onTaskCreated={onTaskCreated}
          />
        ) : (
          <SessionListView
            projectId={projectId}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onSelectSession={(id, relatedIds) => setSelectedSession({ id, relatedIds })}
            onClose={onClose}
            onNavigateToTask={onNavigateToTask}
          />
        )}
      </motion.div>
    </>
  );
}

// --- Session List View ---

function SessionListView({ projectId, searchQuery, onSearchChange, onSelectSession, onClose, onNavigateToTask }: {
  projectId: string;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSelectSession: (id: string, relatedIds?: string[]) => void;
  onClose: () => void;
  onNavigateToTask?: (taskId: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const { data: activeSessions, isLoading: activeLoading } = useActiveSessions(projectId);
  const { data: allSessions, isLoading: allLoading } = useSessions(projectId, showAll);

  const activeCount = activeSessions?.length ?? 0;

  // Determine which sessions to display
  const displaySessions = useMemo(() => {
    if (showAll && allSessions) {
      const activeIds = new Set(activeSessions?.map(s => s.sessionId) ?? []);
      return allSessions.map(s => ({
        ...s,
        isActive: activeIds.has(s.sessionId) || s.isActive,
      }));
    }
    return activeSessions ?? [];
  }, [showAll, allSessions, activeSessions]);

  const filtered = useMemo(() => {
    if (!displaySessions.length) return [];
    if (!searchQuery.trim()) return displaySessions;
    const q = searchQuery.toLowerCase();
    return displaySessions.filter(s =>
      s.firstPrompt.toLowerCase().includes(q) ||
      s.gitBranch?.toLowerCase().includes(q)
    );
  }, [displaySessions, searchQuery]);

  const isLoading = showAll ? allLoading : activeLoading;

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-dark-700">
        <h2 className="text-lg font-semibold text-dark-100">CLI Sessions</h2>
        <button onClick={onClose} className="p-1 text-dark-400 hover:text-dark-100">
          <X size={20} />
        </button>
      </div>

      {/* Search (only when showAll or has active sessions) */}
      {(showAll || activeCount > 0) && (
        <div className="px-4 py-2 border-b border-dark-700">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search sessions..."
              className="w-full pl-9 pr-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-dark-200 text-sm placeholder-dark-500 focus:outline-none focus:border-primary-500"
            />
          </div>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="animate-pulse bg-dark-800 rounded-lg p-4 space-y-2">
                <div className="h-4 bg-dark-700 rounded w-3/4" />
                <div className="h-3 bg-dark-700 rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : !showAll && activeCount === 0 ? (
          <div className="p-6">
            <div className="text-center text-dark-500 py-4">
              No active sessions
            </div>
            <button
              onClick={() => setShowAll(true)}
              className="w-full mt-2 py-2.5 px-4 rounded-lg border border-dark-700 text-dark-400 hover:text-dark-200 hover:border-dark-600 transition-colors text-sm flex items-center justify-center gap-2"
            >
              <ChevronDown size={16} />
              Show all sessions
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-dark-500">
            No sessions match your search
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {filtered.map(session => (
              <button
                key={session.sessionId}
                onClick={() => onSelectSession(session.sessionId, session.relatedSessionIds)}
                className="w-full text-left p-3 rounded-lg hover:bg-dark-800 transition-colors group"
              >
                <div className="flex items-start gap-2">
                  {session.isActive && (
                    <span className="mt-1.5 shrink-0 relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-dark-200 text-sm line-clamp-2 mb-2">
                      {session.firstPrompt}
                    </p>
                    <div className="flex items-center gap-3 text-xs text-dark-500">
                      <span className="flex items-center gap-1">
                        <Clock size={12} />
                        {formatRelativeTime(session.lastModified)}
                      </span>
                      {session.gitBranch && (
                        <span className="flex items-center gap-1">
                          <GitBranch size={12} />
                          {session.gitBranch}
                        </span>
                      )}
                      <span>{formatFileSize(session.fileSize)}</span>
                      {session.relatedSessionIds && session.relatedSessionIds.length > 1 && (
                        <span className="text-dark-400">
                          {session.relatedSessionIds.length} sessions
                        </span>
                      )}
                      {session.linkedTaskId && (
                        <span
                          className="flex items-center gap-1 text-primary-400 hover:text-primary-300"
                          onClick={(e) => {
                            e.stopPropagation();
                            onNavigateToTask?.(session.linkedTaskId!);
                          }}
                        >
                          <ExternalLink size={12} />
                          Task #{session.linkedTaskId}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            ))}

            {/* Show All button when viewing active only */}
            {!showAll && (
              <button
                onClick={() => setShowAll(true)}
                className="w-full mt-2 py-2.5 px-4 rounded-lg border border-dark-700 text-dark-400 hover:text-dark-200 hover:border-dark-600 transition-colors text-sm flex items-center justify-center gap-2"
              >
                <ChevronDown size={16} />
                Show all sessions
              </button>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-dark-700 text-xs text-dark-500 flex items-center justify-between">
        <span>
          {showAll
            ? `${filtered.length} / ${allSessions?.length ?? 0} sessions`
            : `${activeCount} active`
          }
        </span>
        {showAll && (
          <button
            onClick={() => setShowAll(false)}
            className="text-primary-400 hover:text-primary-300"
          >
            Show active only
          </button>
        )}
      </div>
    </>
  );
}

// --- Session Detail View ---

function SessionDetailView({ projectId, sessionId, relatedSessionIds, onBack, onClose, onNavigateToTask, onTaskCreated }: {
  projectId: string;
  sessionId: string;
  relatedSessionIds?: string[];
  onBack: () => void;
  onClose: () => void;
  onNavigateToTask?: (taskId: number) => void;
  onTaskCreated?: (task: Task) => void;
}) {
  const { data: detail, isLoading } = useSessionDetail(projectId, sessionId, relatedSessionIds);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [autoScroll, setAutoScroll] = useState(false);
  const [followUpPrompt, setFollowUpPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timeline: TimelineItem[] = useMemo(() => {
    if (!detail) return [];
    return detail.entries.map(e => ({
      ...e,
      toolStatus: e.type === 'tool_use' ? 'completed' as const : undefined,
    }));
  }, [detail]);

  const grouped = useMemo(() => groupTimeline(timeline), [timeline]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= 80;
    setAutoScroll(!isAtBottom && scrollTop > 0);
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [followUpPrompt]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = followUpPrompt.trim();
    if (!prompt || sending) return;

    setSending(true);
    setError(null);
    try {
      const task = await continueSession(projectId, sessionId, prompt);
      // Close session browser and open the new task
      onClose();
      onTaskCreated?.(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to continue session');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-dark-700">
        <div className="flex items-center gap-2 min-w-0">
          <button onClick={onBack} className="p-1 text-dark-400 hover:text-dark-100 shrink-0">
            <ArrowLeft size={18} />
          </button>
          <span className="text-dark-500 font-mono text-xs truncate">
            {sessionId.slice(0, 8)}...
          </span>
          {detail?.linkedTaskId && (
            <button
              onClick={() => {
                onClose();
                onNavigateToTask?.(detail.linkedTaskId!);
              }}
              className="px-2 py-0.5 bg-primary-500/20 text-primary-400 rounded text-xs hover:bg-primary-500/30 shrink-0"
            >
              Task #{detail.linkedTaskId}
            </button>
          )}
        </div>
        <button onClick={onClose} className="p-1 text-dark-400 hover:text-dark-100">
          <X size={20} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {isLoading ? (
          <div className="p-4 space-y-3 flex-1">
            {[1, 2, 3].map(i => (
              <div key={i} className="animate-pulse bg-dark-800 rounded-lg p-4 space-y-2">
                <div className="h-4 bg-dark-700 rounded w-3/4" />
                <div className="h-3 bg-dark-700 rounded w-full" />
                <div className="h-3 bg-dark-700 rounded w-2/3" />
              </div>
            ))}
          </div>
        ) : timeline.length === 0 ? (
          <div className="p-8 text-center text-dark-500">
            No conversation content found
          </div>
        ) : (
          <>
            <div className="px-4 pt-4 pb-2 flex-shrink-0">
              <h3 className="text-xs font-medium text-dark-500 uppercase">
                Conversation ({timeline.length} items)
              </h3>
            </div>
            <div className="relative flex-1 min-h-0 px-4 pb-4">
              <div
                ref={containerRef}
                onScroll={handleScroll}
                className="bg-dark-800 rounded-lg h-full overflow-y-auto"
              >
                <TimelineView
                  grouped={grouped}
                  userMessageLabel={() => 'Prompt'}
                />
              </div>
              {/* Scroll-to-bottom button */}
              {autoScroll && (
                <button
                  onClick={() => {
                    const container = containerRef.current;
                    if (container) {
                      container.scrollTop = container.scrollHeight;
                    }
                    setAutoScroll(false);
                  }}
                  className="absolute bottom-6 right-6 p-2 bg-primary-600 hover:bg-primary-500 text-white rounded-full shadow-lg transition-colors"
                  title="Scroll to bottom"
                >
                  <ArrowDown size={16} />
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* Follow-up input */}
      {!isLoading && timeline.length > 0 && (
        <div className="p-4 border-t border-dark-700 flex-shrink-0">
          {error && (
            <div className="text-red-400 text-xs mb-2">{error}</div>
          )}
          <form onSubmit={handleSubmit}>
            <div className="flex gap-2">
              <textarea
                ref={textareaRef}
                value={followUpPrompt}
                onChange={(e) => setFollowUpPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleSubmit(e);
                  }
                }}
                placeholder="Continue this session..."
                rows={1}
                className="flex-1 px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-dark-200 text-sm placeholder-dark-500 focus:outline-none focus:border-primary-500 resize-none max-h-32 overflow-y-auto"
              />
              <button
                type="submit"
                disabled={!followUpPrompt.trim() || sending}
                className="btn btn-primary p-2 shrink-0 disabled:opacity-50"
                title="Send follow-up (creates a new task)"
              >
                <Send size={18} />
              </button>
            </div>
            <p className="text-xs text-dark-600 mt-1">
              Creates a new task that resumes this session
            </p>
          </form>
        </div>
      )}
    </>
  );
}
