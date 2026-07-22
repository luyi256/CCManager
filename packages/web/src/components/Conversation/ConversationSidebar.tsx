import { useMemo } from 'react';
import { Plus, MessageSquare, Menu } from 'lucide-react';
import type { Task, TaskStatus } from '../../types';

const statusColors: Record<TaskStatus, string> = {
  pending: 'bg-dark-500',
  running: 'bg-blue-500 animate-pulse',
  waiting: 'bg-amber-500 animate-pulse',
  waiting_permission: 'bg-orange-500 animate-pulse',
  plan_review: 'bg-purple-500 animate-pulse',
  completed: 'bg-green-500',
  completed_with_warnings: 'bg-yellow-500',
  failed: 'bg-red-500',
  cancelled: 'bg-dark-500',
};

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const d = new Date(dateStr).getTime();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function getActivityTime(task: Task): string {
  return task.completedAt || task.startedAt || task.createdAt;
}

function clampTitle(text: string, maxLength = 72): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function promptFallbackTitle(prompt: string): string {
  const cleaned = prompt
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*(please|can you|could you|help me|i need you to)\s+/i, '')
    .trim();

  const sentence = cleaned.match(/^[^.!?\n。！？]+[.!?。！？]?/)?.[0] || cleaned;
  return clampTitle(sentence || 'Empty conversation');
}

function getConversationTitle(task: Task): string {
  return task.summary ? clampTitle(task.summary) : promptFallbackTitle(task.prompt);
}

interface ConversationSidebarProps {
  tasks: Task[];
  selectedTaskId: number | null;
  onSelectTask: (task: Task) => void;
  onNewConversation: () => void;
  isLoading: boolean;
  isMobileOpen?: boolean;
  onMobileToggle?: () => void;
}

export default function ConversationSidebar({
  tasks,
  selectedTaskId,
  onSelectTask,
  onNewConversation,
  isLoading,
  isMobileOpen,
  onMobileToggle,
}: ConversationSidebarProps) {
  const sortedTasks = useMemo(() => {
    const active = tasks.filter(t =>
      ['running', 'waiting', 'waiting_permission', 'plan_review'].includes(t.status)
    );
    const rest = tasks.filter(t =>
      !['running', 'waiting', 'waiting_permission', 'plan_review'].includes(t.status)
    );

    active.sort((a, b) => new Date(getActivityTime(b)).getTime() - new Date(getActivityTime(a)).getTime());
    rest.sort((a, b) => new Date(getActivityTime(b)).getTime() - new Date(getActivityTime(a)).getTime());

    return [...active, ...rest];
  }, [tasks]);

  return (
    <>
      {/* Mobile toggle button */}
      <button
        onClick={onMobileToggle}
        className="md:hidden fixed top-[env(safe-area-inset-top)] left-2 z-50 p-2 mt-2 text-dark-400 hover:text-dark-100"
        style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)' }}
      >
        <Menu size={20} />
      </button>

      {/* Backdrop for mobile */}
      {isMobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-30"
          onClick={onMobileToggle}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
          ${isMobileOpen ? 'translate-x-0' : '-translate-x-full'}
          md:translate-x-0 transition-transform duration-200
          fixed md:relative z-40 md:z-auto
          w-72 md:w-72 lg:w-80
          h-[calc(100vh-3.5rem)] bg-dark-850 border-r border-dark-700
          flex flex-col flex-shrink-0
        `}
      >
        {/* Header */}
        <div className="p-3 border-b border-dark-700 flex-shrink-0">
          <button
            onClick={() => {
              onNewConversation();
              onMobileToggle?.();
            }}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border border-dark-600 hover:border-dark-500 hover:bg-dark-800 transition-colors text-dark-300 hover:text-dark-100"
          >
            <Plus size={18} />
            <span className="text-sm font-medium">New Conversation</span>
          </button>
        </div>

        {/* Task list */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-3 space-y-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-16 bg-dark-800 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : sortedTasks.length === 0 ? (
            <div className="p-6 text-center">
              <MessageSquare size={32} className="mx-auto text-dark-600 mb-2" />
              <p className="text-dark-500 text-sm">No conversations yet</p>
            </div>
          ) : (
            <div className="p-2 space-y-0.5">
              {sortedTasks.map(task => {
                const title = getConversationTitle(task);
                const hasSummary = Boolean(task.summary);

                return (
                  <button
                    key={task.id}
                    onClick={() => {
                      onSelectTask(task);
                      onMobileToggle?.();
                    }}
                    className={`
                      w-full text-left px-3 py-2.5 rounded-lg transition-colors group
                      ${selectedTaskId === task.id
                        ? 'bg-dark-700 text-dark-100 ring-1 ring-inset ring-primary-500/30'
                        : 'hover:bg-dark-800 text-dark-300'
                      }
                    `}
                    title={hasSummary ? task.summary : task.prompt}
                  >
                    <div className="flex items-start gap-2.5">
                      <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${statusColors[task.status]}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate leading-snug">
                          {title}
                        </p>
                        {hasSummary && (
                          <p className="text-xs text-dark-500 truncate mt-0.5">
                            {task.prompt || 'Empty prompt'}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-xs text-dark-500">
                            #{task.id}
                          </span>
                          {task.runner && task.runner !== 'claude' && (
                            <span className="text-xs px-1.5 py-0 rounded bg-dark-700 text-dark-400">
                              {task.runner}
                            </span>
                          )}
                          {task.model && (
                            <span className="text-xs text-dark-500 truncate max-w-[80px]">
                              {task.model.replace(/^claude-/, '')}
                            </span>
                          )}
                          <span className="text-xs text-dark-500 ml-auto flex-shrink-0">
                            {relativeTime(getActivityTime(task))}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
