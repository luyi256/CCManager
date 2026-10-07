import { useState, useMemo, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { Settings, RefreshCw, History, ArrowLeft, FolderTree } from 'lucide-react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import TaskInput from '../components/Task/TaskInput';
import SessionBrowser from '../components/Session/SessionBrowser';
import FileExplorer from '../components/Files/FileExplorer';
import ProjectSettingsModal from '../components/Project/ProjectSettingsModal';
import ConversationSidebar from '../components/Conversation/ConversationSidebar';
import ConversationPanel from '../components/Conversation/ConversationPanel';
import { useProject } from '../hooks/useProjects';
import { useTasks, useCreateTask } from '../hooks/useTasks';
import { useActiveSessions } from '../hooks/useSessions';
import type { Runner } from '../types';

const FILES_OPEN_KEY = 'ccm_files_panel_open';

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [isComposing, setIsComposing] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionBrowserOpen, setSessionBrowserOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(() => localStorage.getItem(FILES_OPEN_KEY) === '1');
  useEffect(() => {
    localStorage.setItem(FILES_OPEN_KEY, filesOpen ? '1' : '0');
  }, [filesOpen]);
  const [initialSession, setInitialSession] = useState<{
    id: string;
    runner: Runner;
    model?: string;
    relatedIds?: string[];
  } | null>(null);

  const {
    data: project,
    isLoading: projectLoading,
    isError: projectError,
    refetch: refetchProject,
  } = useProject(projectId!);
  const {
    data: tasks = [],
    isLoading: tasksLoading,
    isError: tasksError,
    refetch,
  } = useTasks(projectId!);
  const createTask = useCreateTask(projectId!);
  const { data: activeSessions } = useActiveSessions(projectId!);

  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null;
    return tasks.find((task) => task.id === selectedTaskId) ?? null;
  }, [selectedTaskId, tasks]);

  const lastTaskSelection = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const aTime = new Date(a.startedAt || a.createdAt).getTime();
      const bTime = new Date(b.startedAt || b.createdAt).getTime();
      return bTime - aTime;
    })[0];
  }, [tasks]);

  // Filter out active sessions that are linked to any CCManager task
  const allTaskIds = useMemo(() => {
    return new Set(tasks.map(t => t.id));
  }, [tasks]);

  const externalSessions = useMemo(() => {
    if (!activeSessions) return [];
    return activeSessions.filter(s => !s.linkedTaskId || !allTaskIds.has(s.linkedTaskId));
  }, [activeSessions, allTaskIds]);

  const handleCreateTask = async (data: {
    prompt: string;
    isPlanMode: boolean;
    runner?: Runner;
    model?: string;
    reasoningEffort?: string;
    dependsOn?: number;
    images?: string[];
  }) => {
    const task = await createTask.mutateAsync(data);
    setSelectedTaskId(task.id);
    setIsComposing(false);
  };

  if (projectLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="animate-pulse">
          <div className="h-8 bg-dark-800 rounded w-1/3 mb-4" />
          <div className="h-4 bg-dark-800 rounded w-1/2" />
        </div>
      </div>
    );
  }

  if (projectError || !project) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="card p-8 text-center">
          <h2 className="text-xl font-semibold text-dark-200 mb-2">
            {projectError ? 'Could not load project' : 'Project not found'}
          </h2>
          <p className="text-dark-400">
            {projectError
              ? 'The project request failed. Check the connection and try again.'
              : "The project you're looking for doesn't exist or has been deleted."}
          </p>
          <div className="mt-5 flex items-center justify-center gap-3">
            <Link to="/" className="btn btn-secondary inline-flex items-center gap-2">
              <ArrowLeft size={16} /> Projects
            </Link>
            {projectError && (
              <button onClick={() => refetchProject()} className="btn btn-primary">
                Try again
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-3.5rem)] flex overflow-hidden bg-dark-900">
      <ConversationSidebar
        tasks={tasks}
        selectedTaskId={isComposing ? null : selectedTaskId}
        onSelectTask={(task) => {
          setSelectedTaskId(task.id);
          setIsComposing(false);
        }}
        onNewConversation={() => {
          setSelectedTaskId(null);
          setIsComposing(true);
        }}
        isLoading={tasksLoading}
        error={tasksError ? 'Could not load conversations' : undefined}
        onRetry={() => refetch()}
        isMobileOpen={mobileSidebarOpen}
        onMobileToggle={() => setMobileSidebarOpen((value) => !value)}
      />

      <main className="flex-1 min-w-0 min-h-0 flex flex-col">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-dark-700 bg-dark-850">
          <div className="min-w-0 pl-8 md:pl-0">
            <h1 className="text-sm font-semibold text-dark-100 truncate">{project.name}</h1>
            <p className="text-xs text-dark-500 truncate">
              Agent: {project.agentId} • {project.projectPath}
              {externalSessions.length > 0 ? ` • ${externalSessions.length} external session${externalSessions.length > 1 ? 's' : ''}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setFilesOpen((value) => !value)}
              className={clsx('btn btn-ghost p-2', filesOpen && 'bg-dark-700 text-dark-50')}
              title="Files"
              aria-label={filesOpen ? 'Hide project files' : 'Show project files'}
              aria-pressed={filesOpen}
            >
              <FolderTree size={18} />
            </button>
            <button
              onClick={() => setSessionBrowserOpen(true)}
              className="btn btn-ghost p-2"
              title="CLI Sessions"
              aria-label="Open CLI sessions"
            >
              <History size={18} />
            </button>
            <button
              onClick={() => refetch()}
              className="btn btn-ghost p-2"
              title="Refresh"
              aria-label="Refresh conversations"
            >
              <RefreshCw size={18} />
            </button>
            <button onClick={() => setSettingsOpen(true)} className="btn btn-ghost p-2" title="Settings" aria-label="Project settings">
              <Settings size={18} />
            </button>
          </div>
        </div>

        {selectedTask && !isComposing ? (
          <ConversationPanel
            task={selectedTask}
            agentId={project.agentId}
            onBack={() => setMobileSidebarOpen(true)}
          />
        ) : (
          <div className="flex-1 overflow-y-auto px-4 py-6">
            <div className="max-w-3xl mx-auto min-h-full flex flex-col justify-center">
              <div className="mb-4">
                <h2 className="text-xl font-semibold text-dark-100">New conversation</h2>
                <p className="text-sm text-dark-500 mt-1">
                  Start a coding session in this project.
                </p>
              </div>
              <TaskInput
                onSubmit={handleCreateTask}
                isSubmitting={createTask.isPending}
                tasks={tasks}
                lastModel={lastTaskSelection?.model}
                lastReasoningEffort={lastTaskSelection?.reasoningEffort}
                lastRunner={lastTaskSelection?.runner}
                agentId={project.agentId}
              />
            </div>
          </div>
        )}
      </main>

      {filesOpen && (
        <FileExplorer
          key={project.id}
          projectId={project.id}
          projectPath={project.projectPath}
          onClose={() => setFilesOpen(false)}
        />
      )}

      {/* Session Browser Drawer */}
      <AnimatePresence>
        {sessionBrowserOpen && (
          <SessionBrowser
            projectId={projectId!}
            initialSession={initialSession ?? undefined}
            onClose={() => { setSessionBrowserOpen(false); setInitialSession(null); }}
            onNavigateToTask={(taskId) => {
              setSessionBrowserOpen(false);
              setInitialSession(null);
              const task = tasks.find(t => t.id === taskId);
              if (task) {
                setSelectedTaskId(task.id);
                setIsComposing(false);
              }
            }}
            onTaskCreated={(task) => {
              refetch();
              setSelectedTaskId(task.id);
              setIsComposing(false);
            }}
          />
        )}
      </AnimatePresence>

      {/* Project Settings Modal */}
      <ProjectSettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        project={project}
      />
    </div>
  );
}
