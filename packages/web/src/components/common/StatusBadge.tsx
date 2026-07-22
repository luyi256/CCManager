import { clsx } from 'clsx';
import type { TaskStatus } from '../../types';

const statusConfig: Record<TaskStatus, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'bg-dark-700 text-dark-200 ring-1 ring-inset ring-dark-500/50' },
  running: { label: 'Running', color: 'bg-blue-500/15 text-blue-300 ring-1 ring-inset ring-blue-500/30' },
  waiting: { label: 'Waiting', color: 'bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-500/30' },
  waiting_permission: { label: 'Permission', color: 'bg-orange-500/15 text-orange-300 ring-1 ring-inset ring-orange-500/30' },
  plan_review: { label: 'Review', color: 'bg-purple-500/15 text-purple-300 ring-1 ring-inset ring-purple-500/30' },
  completed: { label: 'Completed', color: 'bg-green-500/15 text-green-300 ring-1 ring-inset ring-green-500/30' },
  completed_with_warnings: { label: 'Warnings', color: 'bg-yellow-500/15 text-yellow-300 ring-1 ring-inset ring-yellow-500/30' },
  failed: { label: 'Failed', color: 'bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-500/30' },
  cancelled: { label: 'Cancelled', color: 'bg-dark-700 text-dark-400 ring-1 ring-inset ring-dark-600' },
};

interface StatusBadgeProps {
  status: TaskStatus;
  className?: string;
}

export default function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = statusConfig[status];

  return (
    <span
      className={clsx(
        'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
        config.color,
        className
      )}
    >
      {config.label}
    </span>
  );
}
