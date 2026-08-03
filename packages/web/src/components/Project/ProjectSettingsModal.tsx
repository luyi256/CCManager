import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import Modal from '../common/Modal';
import { useUpdateProject } from '../../hooks/useProjects';
import type { Project } from '../../types';

interface ProjectSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: Project;
}

export default function ProjectSettingsModal({ isOpen, onClose, project }: ProjectSettingsModalProps) {
  const [allowedPathsText, setAllowedPathsText] = useState('');
  const [submitError, setSubmitError] = useState('');
  const updateProject = useUpdateProject();

  useEffect(() => {
    if (isOpen) {
      setAllowedPathsText(project.allowedPaths?.join('\n') || '');
      setSubmitError('');
    }
  }, [isOpen, project.allowedPaths]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const paths = allowedPathsText
      .split('\n')
      .map(p => p.trim())
      .filter(Boolean);

    setSubmitError('');
    try {
      await updateProject.mutateAsync({
        id: project.id,
        data: { allowedPaths: paths },
      });
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to save project settings');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Project Settings">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-dark-200 mb-1">
            Project
          </label>
          <p className="text-dark-400 text-sm">{project.name}</p>
        </div>

        {submitError && (
          <p className="text-red-400 text-sm" role="alert">{submitError}</p>
        )}

        <div>
          <label className="block text-sm font-medium text-dark-200 mb-1">
            Allowed Paths
          </label>
          <p className="text-dark-500 text-xs mb-2">
            Override agent-level allowed paths for this project. One path per line.
            Supports glob patterns: /path/* (children), /path/** (recursive).
            Leave empty to use agent defaults.
          </p>
          <textarea
            value={allowedPathsText}
            onChange={(e) => setAllowedPathsText(e.target.value)}
            placeholder={`/Users/name/projects/*\n/home/user/workspace/**`}
            className="input w-full font-mono text-sm"
            rows={5}
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">
            Cancel
          </button>
          <button
            type="submit"
            disabled={updateProject.isPending}
            className="btn btn-primary"
          >
            {updateProject.isPending ? (
              <Loader2 size={16} className="animate-spin mr-2" />
            ) : null}
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
