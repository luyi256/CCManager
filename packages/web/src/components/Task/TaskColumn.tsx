import { AnimatePresence } from 'framer-motion';
import TaskCard from './TaskCard';
import ActiveSessionCard from './ActiveSessionCard';
import type { Task, TaskStatus } from '../../types';
import type { SessionListItem } from '../../services/api';

interface TaskColumnProps {
  title: string;
  status: TaskStatus | TaskStatus[];
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  activeTaskId?: number;
  activeSessions?: SessionListItem[];
  onSessionClick?: (session: SessionListItem) => void;
}

export default function TaskColumn({
  title,
  tasks,
  onTaskClick,
  activeTaskId,
  activeSessions,
  onSessionClick,
}: TaskColumnProps) {
  const totalCount = tasks.length + (activeSessions?.length ?? 0);

  return (
    <div className="flex flex-col flex-1 bg-dark-850 rounded-xl border border-dark-700 overflow-hidden">
      <div className="px-3 py-2 border-b border-dark-700">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-dark-200">{title}</h3>
          <span className="text-xs text-dark-500 bg-dark-700 px-2 py-0.5 rounded-full">
            {totalCount}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[200px]">
        <AnimatePresence mode="popLayout">
          {activeSessions?.map((session) => (
            <ActiveSessionCard
              key={`session-${session.sessionId}`}
              session={session}
              onClick={() => onSessionClick?.(session)}
            />
          ))}
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onClick={() => onTaskClick(task)}
              isActive={task.id === activeTaskId}
            />
          ))}
        </AnimatePresence>

        {totalCount === 0 && (
          <div className="flex items-center justify-center h-20 text-dark-600 text-sm">
            No tasks
          </div>
        )}
      </div>
    </div>
  );
}
