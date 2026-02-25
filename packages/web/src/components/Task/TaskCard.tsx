import { motion } from 'framer-motion';
import { Clock, GitBranch, AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';
import StatusBadge from '../common/StatusBadge';
import type { Task } from '../../types';

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  isActive?: boolean;
}

export default function TaskCard({ task, onClick, isActive }: TaskCardProps) {
  const isRunning = task.status === 'running' || task.status === 'waiting';
  const hasWarnings = task.status === 'completed_with_warnings';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      className={clsx(
        'card p-3 cursor-pointer transition-all',
        isActive && 'ring-2 ring-primary-500',
        isRunning && 'border-blue-500/50'
      )}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-xs text-dark-500 font-mono">#{task.id}</span>
        <StatusBadge status={task.status} />
      </div>

      <p className="text-sm text-dark-200 line-clamp-2 mb-2">{task.prompt}</p>

      <div className="flex items-center gap-3 text-xs text-dark-500">
        {task.isPlanMode && (
          <span className="px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded">
            Plan
          </span>
        )}
        {task.worktreeBranch && (
          <span className="flex items-center gap-1">
            <GitBranch size={12} />
            {task.worktreeBranch.slice(0, 15)}...
          </span>
        )}
        {task.waitReason && (
          <span className="flex items-center gap-1 text-amber-400">
            <Clock size={12} />
            Waiting
          </span>
        )}
        {hasWarnings && (
          <span className="flex items-center gap-1 text-yellow-400">
            <AlertTriangle size={12} />
            Warnings
          </span>
        )}
      </div>

      {task.summary && (
        <p className="text-xs text-dark-400 mt-2 line-clamp-1">{task.summary}</p>
      )}
    </motion.div>
  );
}
