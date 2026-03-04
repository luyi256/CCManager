import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { Settings, RefreshCw } from 'lucide-react';
import TaskBoard from '../components/Task/TaskBoard';
import TaskInput from '../components/Task/TaskInput';
import TaskDetail from '../components/Task/TaskDetail';
import { useProject } from '../hooks/useProjects';
import { useTasks, useCreateTask } from '../hooks/useTasks';
import type { Task } from '../types';

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  const { data: project, isLoading: projectLoading } = useProject(projectId!);
  const { data: tasks = [], isLoading: tasksLoading, refetch } = useTasks(projectId!);
  const createTask = useCreateTask(projectId!);

  const handleCreateTask = async (data: {
    prompt: string;
    isPlanMode: boolean;
    dependsOn?: number;
    images?: string[];
  }) => {
    const task = await createTask.mutateAsync(data);
    if (data.isPlanMode) {
      setSelectedTask(task);
    }
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

  if (!project) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="card p-8 text-center">
          <h2 className="text-xl font-semibold text-dark-200 mb-2">
            Project not found
          </h2>
          <p className="text-dark-400">
            The project you're looking for doesn't exist or has been deleted.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-dark-100">{project.name}</h1>
          <p className="text-dark-400 mt-1">
            Agent: {project.agentId} • {project.projectPath}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            className="btn btn-ghost p-2"
            title="Refresh"
          >
            <RefreshCw size={18} />
          </button>
          <button className="btn btn-ghost p-2" title="Settings">
            <Settings size={18} />
          </button>
        </div>
      </div>

      {/* Task Input */}
      <div className="mb-6">
        <TaskInput
          onSubmit={handleCreateTask}
          isSubmitting={createTask.isPending}
          tasks={tasks}
        />
      </div>

      {/* Task Board */}
      {tasksLoading ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="min-w-[280px] bg-dark-850 rounded-xl animate-pulse"
            >
              <div className="px-3 py-2 border-b border-dark-700">
                <div className="h-5 bg-dark-700 rounded w-20" />
              </div>
              <div className="p-2 space-y-2">
                <div className="h-24 bg-dark-800 rounded" />
                <div className="h-24 bg-dark-800 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <TaskBoard
          tasks={tasks}
          onTaskClick={setSelectedTask}
          activeTaskId={selectedTask?.id}
        />
      )}

      {/* Task Detail Drawer */}
      <AnimatePresence>
        {selectedTask && (
          <TaskDetail
            task={selectedTask}
            onClose={() => setSelectedTask(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
