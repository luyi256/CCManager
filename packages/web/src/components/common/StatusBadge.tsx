import { clsx } from 'clsx';
import type { TaskStatus } from '../../types';

const statusConfig: Record<TaskStatus, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'bg-dark-600 text-dark-300' },
  running: { label: 'Running', color: 'bg-blue-600 text-white' },
  waiting: { label: 'Waiting', color: 'bg-amber-600 text-white' },
  waiting_permission: { label: 'Permission', color: 'bg-orange-600 text-white' },
  plan_review: { label: 'Review', color: 'bg-purple-600 text-white' },
  completed: { label: 'Completed', color: 'bg-green-600 text-white' },
  completed_with_warnings: { label: 'Warnings', color: 'bg-yellow-600 text-white' },
  failed: { label: 'Failed', color: 'bg-red-600 text-white' },
  cancelled: { label: 'Cancelled', color: 'bg-dark-500 text-dark-300' },
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
