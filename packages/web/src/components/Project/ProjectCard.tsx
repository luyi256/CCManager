import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Server, GitBranch, Clock, ChevronRight, Trash2, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import type { Project } from '../../types';
import { useDeleteProject } from '../../hooks/useProjects';
import Modal from '../common/Modal';

interface ProjectCardProps {
  project: Project;
}

export default function ProjectCard({ project }: ProjectCardProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const deleteProject = useDeleteProject();

  const lastActivity = project.lastActivity
    ? formatRelativeTime(new Date(project.lastActivity))
    : 'No activity';

  const handleDelete = async () => {
    try {
      await deleteProject.mutateAsync(project.id);
      setShowDeleteConfirm(false);
    } catch {
      // Error handled by mutation
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
    >
      <div className="card p-4 hover:border-dark-600 transition-colors group relative">
        <Link
          to={`/project/${project.id}`}
          className="block"
        >
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-dark-100 truncate group-hover:text-primary-400 transition-colors">
                {project.name}
              </h3>
              <div className="mt-2 flex items-center gap-4 text-sm text-dark-400">
                <span className="flex items-center gap-1.5">
                  <Server size={14} />
                  {project.agentId}
                </span>
                <span className="flex items-center gap-1.5">
                  <GitBranch size={14} />
                  {project.taskCount} tasks
                </span>
              </div>
              <div className="mt-2 flex items-center gap-4 text-sm">
                <span className="flex items-center gap-1.5 text-dark-500">
                  <Clock size={14} />
                  {lastActivity}
                </span>
                {project.runningCount > 0 && (
                  <span className="flex items-center gap-1.5 text-blue-400">
                    <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                    {project.runningCount} running
                  </span>
                )}
              </div>
            </div>
            <ChevronRight
              size={20}
              className="text-dark-500 group-hover:text-dark-300 transition-colors flex-shrink-0"
            />
          </div>
        </Link>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowDeleteConfirm(true);
          }}
          className="absolute top-4 right-12 p-1.5 text-dark-500 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
          title="Delete project"
        >
          <Trash2 size={16} />
        </button>
      </div>

      <Modal
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="Delete Project"
      >
        <div className="space-y-4">
          <p className="text-dark-300">
            Are you sure you want to delete <span className="font-semibold text-dark-100">{project.name}</span>?
          </p>
          <p className="text-dark-400 text-sm">
            This will permanently delete the project and all {project.taskCount} associated tasks. This action cannot be undone.
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={() => setShowDeleteConfirm(false)}
              className="btn btn-secondary"
              disabled={deleteProject.isPending}
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleteProject.isPending}
              className="btn bg-red-600 hover:bg-red-700 text-white"
            >
              {deleteProject.isPending ? (
                <>
                  <Loader2 size={16} className="animate-spin mr-2" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </button>
          </div>
          {deleteProject.isError && (
            <p className="text-red-400 text-sm">
              {deleteProject.error instanceof Error
                ? deleteProject.error.message
                : 'Failed to delete project'}
            </p>
          )}
        </div>
      </Modal>
    </motion.div>
  );
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}
