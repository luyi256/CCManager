import { AnimatePresence } from 'framer-motion';
import { FolderOpen } from 'lucide-react';
import ProjectCard from './ProjectCard';
import type { Project } from '../../types';

interface ProjectListProps {
  projects: Project[];
  isLoading: boolean;
  error?: string;
  onRetry?: () => void;
}

export default function ProjectList({ projects, isLoading, error, onRetry }: ProjectListProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="card p-4 animate-pulse"
          >
            <div className="h-5 bg-dark-700 rounded w-1/3 mb-3" />
            <div className="h-4 bg-dark-700 rounded w-1/2 mb-2" />
            <div className="h-4 bg-dark-700 rounded w-1/4" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-8 text-center border-red-500/30">
        <h3 className="text-lg font-medium text-red-300 mb-2">Could not load projects</h3>
        <p className="text-dark-400 text-sm mb-4">{error}</p>
        <button type="button" onClick={onRetry} className="btn btn-secondary">
          Try again
        </button>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="card p-12 text-center">
        <FolderOpen size={48} className="mx-auto text-dark-600 mb-4" />
        <h3 className="text-lg font-medium text-dark-300 mb-2">No projects yet</h3>
        <p className="text-dark-500">
          Add your first project to get started with Claude Code Manager.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <AnimatePresence mode="popLayout">
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </AnimatePresence>
    </div>
  );
}
