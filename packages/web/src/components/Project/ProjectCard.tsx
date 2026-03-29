import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Server, GitBranch, Clock, ChevronRight, Trash2 } from 'lucide-react';
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

  const handleDelete = () => {
    deleteProject.mutate(project.id, {
      onSuccess: () => setShowDeleteConfirm(false),
    });
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
            e.preventDefault();
            setShowDeleteConfirm(true);
          }}
          className="absolute top-4 right-10 p-1.5 rounded-md text-dark-600 hover:text-red-400 hover:bg-dark-700 opacity-0 group-hover:opacity-100 transition-all"
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
        <p className="text-dark-300 mb-2">
          Are you sure you want to delete <span className="font-semibold text-dark-100">{project.name}</span>?
        </p>
        <p className="text-dark-500 text-sm mb-6">
          All tasks and logs associated with this project will be permanently deleted.
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={() => setShowDeleteConfirm(false)}
            className="btn-secondary px-4 py-2"
            disabled={deleteProject.isPending}
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:opacity-50"
            disabled={deleteProject.isPending}
          >
            {deleteProject.isPending ? 'Deleting...' : 'Delete'}
          </button>
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
