import { useState, useMemo, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  X,
  ArrowLeft,
  Search,
  GitBranch,
  Clock,
  ArrowDown,
  ExternalLink,
} from 'lucide-react';
import { useSessions, useSessionDetail } from '../../hooks/useSessions';
import { groupTimeline, TimelineView } from '../Task/TimelineRenderer';
import type { TimelineItem } from '../Task/TimelineRenderer';

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
}

export default function SessionBrowser({ projectId, onClose, onNavigateToTask }: SessionBrowserProps) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
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
        {selectedSessionId ? (
          <SessionDetailView
            projectId={projectId}
            sessionId={selectedSessionId}
            onBack={() => setSelectedSessionId(null)}
            onClose={onClose}
            onNavigateToTask={onNavigateToTask}
          />
        ) : (
          <SessionListView
            projectId={projectId}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onSelectSession={setSelectedSessionId}
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
  onSelectSession: (id: string) => void;
  onClose: () => void;
  onNavigateToTask?: (taskId: number) => void;
}) {
  const { data: sessions, isLoading } = useSessions(projectId);

  const filtered = useMemo(() => {
    if (!sessions) return [];
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter(s =>
      s.firstPrompt.toLowerCase().includes(q) ||
      s.gitBranch?.toLowerCase().includes(q)
    );
  }, [sessions, searchQuery]);

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-dark-700">
        <h2 className="text-lg font-semibold text-dark-100">CLI Sessions</h2>
        <button onClick={onClose} className="p-1 text-dark-400 hover:text-dark-100">
          <X size={20} />
        </button>
      </div>

      {/* Search */}
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

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 space-y-3">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="animate-pulse bg-dark-800 rounded-lg p-4 space-y-2">
                <div className="h-4 bg-dark-700 rounded w-3/4" />
                <div className="h-3 bg-dark-700 rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-dark-500">
            {sessions?.length === 0
              ? 'No CLI sessions found for this project path'
              : 'No sessions match your search'}
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {filtered.map(session => (
              <button
                key={session.sessionId}
                onClick={() => onSelectSession(session.sessionId)}
                className="w-full text-left p-3 rounded-lg hover:bg-dark-800 transition-colors group"
              >
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
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Footer count */}
      {sessions && sessions.length > 0 && (
        <div className="px-4 py-2 border-t border-dark-700 text-xs text-dark-500">
          {filtered.length} / {sessions.length} sessions
        </div>
      )}
    </>
  );
}

// --- Session Detail View ---

function SessionDetailView({ projectId, sessionId, onBack, onClose, onNavigateToTask }: {
  projectId: string;
  sessionId: string;
  onBack: () => void;
  onClose: () => void;
  onNavigateToTask?: (taskId: number) => void;
}) {
  const { data: detail, isLoading } = useSessionDetail(projectId, sessionId);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(false);

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
    </>
  );
}
