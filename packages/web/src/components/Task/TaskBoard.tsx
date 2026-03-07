import { useMemo } from 'react';
import TaskColumn from './TaskColumn';
import type { Task, TaskStatus } from '../../types';

interface TaskBoardProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  activeTaskId?: number;
}

interface ColumnConfig {
  id: string;
  title: string;
  statuses: TaskStatus[];
}

const columns: ColumnConfig[] = [
  { id: 'pending', title: 'Pending', statuses: ['pending'] },
  { id: 'running', title: 'Running', statuses: ['running', 'waiting', 'waiting_permission', 'plan_review'] },
  { id: 'completed', title: 'Completed', statuses: ['completed', 'completed_with_warnings'] },
  { id: 'failed', title: 'Failed', statuses: ['failed', 'cancelled'] },
];

export default function TaskBoard({ tasks, onTaskClick, activeTaskId }: TaskBoardProps) {
  const tasksByColumn = useMemo(() => {
    const result: Record<string, Task[]> = {};

    columns.forEach((col) => {
      result[col.id] = tasks
        .filter((task) => col.statuses.includes(task.status))
        .sort((a, b) => {
          // Running tasks: newest first
          if (col.id === 'running') {
            return new Date(b.startedAt || b.createdAt).getTime() -
                   new Date(a.startedAt || a.createdAt).getTime();
          }
          // Completed/Failed: newest first
          if (col.id === 'completed' || col.id === 'failed') {
            return new Date(b.completedAt || b.createdAt).getTime() -
                   new Date(a.completedAt || a.createdAt).getTime();
          }
          // Pending: oldest first (FIFO)
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });
    });

    return result;
  }, [tasks]);

  return (
    <div className="flex justify-center gap-4 overflow-x-auto pb-4 -mx-4 px-4">
      {columns.map((column) => (
        <TaskColumn
          key={column.id}
          title={column.title}
          status={column.statuses}
          tasks={tasksByColumn[column.id]}
          onTaskClick={onTaskClick}
          activeTaskId={activeTaskId}
        />
      ))}
    </div>
  );
}
