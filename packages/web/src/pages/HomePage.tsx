import { useState } from 'react';
import { Plus } from 'lucide-react';
import ProjectList from '../components/Project/ProjectList';
import AddProjectModal from '../components/Project/AddProjectModal';
import { useProjects } from '../hooks/useProjects';

export default function HomePage() {
  const [showAddModal, setShowAddModal] = useState(false);
  const { data: projects = [], isLoading } = useProjects();

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-dark-100">Projects</h1>
          <p className="text-dark-400 mt-1">
            Manage your Claude Code development tasks
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="btn btn-primary flex items-center gap-2"
        >
          <Plus size={20} />
          Add Project
        </button>
      </div>

      <ProjectList projects={projects} isLoading={isLoading} />

      <AddProjectModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
      />
    </div>
  );
}
