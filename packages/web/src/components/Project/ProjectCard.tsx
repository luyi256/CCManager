import { Link } from 'react-router-dom';
import { Server, GitBranch, Clock, ChevronRight } from 'lucide-react';
import { motion } from 'framer-motion';
import type { Project } from '../../types';

interface ProjectCardProps {
  project: Project;
}

export default function ProjectCard({ project }: ProjectCardProps) {
  const lastActivity = project.lastActivity
    ? formatRelativeTime(new Date(project.lastActivity))
    : 'No activity';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
    >
      <Link
        to={`/project/${project.id}`}
        className="block card p-4 hover:border-dark-600 transition-colors group"
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
