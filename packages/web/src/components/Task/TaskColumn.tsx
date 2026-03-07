import { AnimatePresence } from 'framer-motion';
import TaskCard from './TaskCard';
import type { Task, TaskStatus } from '../../types';

interface TaskColumnProps {
  title: string;
  status: TaskStatus | TaskStatus[];
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  activeTaskId?: number;
}

export default function TaskColumn({
  title,
  tasks,
  onTaskClick,
  activeTaskId,
}: TaskColumnProps) {
  return (
    <div className="flex flex-col flex-1 min-w-[280px] bg-dark-850 rounded-xl">
      <div className="px-3 py-2 border-b border-dark-700">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-dark-200">{title}</h3>
          <span className="text-xs text-dark-500 bg-dark-700 px-2 py-0.5 rounded-full">
            {tasks.length}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[200px]">
        <AnimatePresence mode="popLayout">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onClick={() => onTaskClick(task)}
              isActive={task.id === activeTaskId}
            />
          ))}
        </AnimatePresence>

        {tasks.length === 0 && (
          <div className="flex items-center justify-center h-20 text-dark-600 text-sm">
            No tasks
          </div>
        )}
      </div>
    </div>
  );
}
