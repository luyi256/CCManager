import { useState } from 'react';
import { Plus } from 'lucide-react';
import ProjectList from '../components/Project/ProjectList';
import AddProjectModal from '../components/Project/AddProjectModal';
import { useProjects } from '../hooks/useProjects';

export default function HomePage() {
  const [showAddModal, setShowAddModal] = useState(false);
  const {
    data: projects = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useProjects();

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-dark-100">Projects</h1>
          <p className="text-dark-400 mt-1">
            Manage your Claude Code development tasks
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="btn btn-primary flex items-center justify-center gap-2 w-full sm:w-auto"
        >
          <Plus size={20} />
          Add Project
        </button>
      </div>

      <ProjectList
        projects={projects}
        isLoading={isLoading}
        error={isError ? (error instanceof Error ? error.message : 'Failed to load projects') : undefined}
        onRetry={() => refetch()}
      />

      <AddProjectModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
      />
    </div>
  );
}
