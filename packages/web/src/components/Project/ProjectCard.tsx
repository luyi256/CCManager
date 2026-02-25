import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Server, GitBranch, Clock, ChevronRight, Trash2, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Project } from '../../types';
import { useDeleteProject } from '../../hooks/useProjects';
import Modal from '../common/Modal';

const LONG_PRESS_MS = 500;

interface ProjectCardProps {
  project: Project;
}

export default function ProjectCard({ project }: ProjectCardProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const deleteProject = useDeleteProject();
  const navigate = useNavigate();

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLongPressRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);

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

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startPress = useCallback(() => {
    isLongPressRef.current = false;
    timerRef.current = setTimeout(() => {
      isLongPressRef.current = true;
      setShowContextMenu(true);
    }, LONG_PRESS_MS);
  }, []);

  const endPress = useCallback(() => {
    clearTimer();
  }, [clearTimer]);

  // Close context menu on outside click
  useEffect(() => {
    if (!showContextMenu) return;
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        setShowContextMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [showContextMenu]);

  // Cleanup timer on unmount
  useEffect(() => clearTimer, [clearTimer]);

  const handleClick = (e: React.MouseEvent) => {
    if (isLongPressRef.current || showContextMenu) {
      e.preventDefault();
      return;
    }
    navigate(`/project/${project.id}`);
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
    >
      <div
        ref={cardRef}
        className="card p-4 hover:border-dark-600 transition-colors group relative cursor-pointer select-none"
        onMouseDown={startPress}
        onMouseUp={endPress}
        onMouseLeave={endPress}
        onTouchStart={startPress}
        onTouchEnd={endPress}
        onTouchCancel={endPress}
        onClick={handleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          setShowContextMenu(true);
        }}
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

        {/* Context menu on long press */}
        <AnimatePresence>
          {showContextMenu && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.12 }}
              className="absolute top-2 right-2 z-50 bg-dark-700 border border-dark-600 rounded-lg shadow-xl overflow-hidden"
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowContextMenu(false);
                  setShowDeleteConfirm(true);
                }}
                className="flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:bg-dark-600 transition-colors w-full"
              >
                <Trash2 size={15} />
                Delete Project
              </button>
            </motion.div>
          )}
        </AnimatePresence>
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
