import { useState } from 'react';
import { Loader2, Server, Circle, Plus, X } from 'lucide-react';
import Modal from '../common/Modal';
import { useCreateProject } from '../../hooks/useProjects';
import { useWebSocket } from '../../contexts/WebSocketContext';
import type { ExtraMount } from '../../types';

interface AddProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface FormData {
  name: string;
  agentId: string;
  projectPath: string;
  securityMode: 'auto' | 'safe';
  postTaskHook: string;
  extraMounts: ExtraMount[];
  enableWorktree: boolean;
}

const initialFormData: FormData = {
  name: '',
  agentId: '',
  projectPath: '',
  securityMode: 'auto',
  postTaskHook: '',
  extraMounts: [],
  enableWorktree: false,
};

export default function AddProjectModal({ isOpen, onClose }: AddProjectModalProps) {
  const [formData, setFormData] = useState<FormData>(initialFormData);
  const { agents } = useWebSocket();
  console.log('AddProjectModal render, agents:', agents, 'formData:', formData);

  const createProject = useCreateProject();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('handleSubmit called, formData:', formData);

    if (!formData.agentId) {
      console.log('No agentId selected, returning');
      return;
    }

    try {
      const submitData = {
        ...formData,
        extraMounts: formData.extraMounts.length > 0
          ? formData.extraMounts.filter(m => m.source && m.target)
          : undefined,
      };
      console.log('Calling createProject.mutateAsync with:', submitData);
      await createProject.mutateAsync(submitData);
      console.log('createProject succeeded');
      onClose();
      setFormData(initialFormData);
    } catch (err) {
      console.error('createProject failed:', err);
      // Error handled by mutation
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online':
        return 'text-green-500';
      case 'busy':
        return 'text-yellow-500';
      default:
        return 'text-dark-500';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'online':
        return 'Online';
      case 'busy':
        return 'Busy';
      default:
        return 'Offline';
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Project">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-dark-300 mb-1.5">
            Project Name
          </label>
          <input
            type="text"
            className="input"
            placeholder="My Project"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-dark-300 mb-1.5">
            Execution Agent
          </label>
          {agents.length === 0 ? (
            <div className="card p-4 text-center">
              <Server size={24} className="mx-auto text-dark-500 mb-2" />
              <p className="text-dark-400 text-sm">No agents connected</p>
              <p className="text-dark-500 text-xs mt-1">
                Start an agent to create projects
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {agents.map((agent) => (
                <label
                  key={agent.id}
                  className={`card p-3 cursor-pointer transition-colors flex items-center gap-3 ${
                    formData.agentId === agent.id
                      ? 'border-primary-500 bg-primary-500/10'
                      : agent.status === 'offline'
                      ? 'opacity-50 cursor-not-allowed'
                      : 'hover:border-dark-600'
                  }`}
                >
                  <input
                    type="radio"
                    name="agentId"
                    value={agent.id}
                    checked={formData.agentId === agent.id}
                    onChange={(e) =>
                      setFormData({ ...formData, agentId: e.target.value })
                    }
                    disabled={agent.status === 'offline'}
                    className="sr-only"
                  />
                  <Circle
                    size={10}
                    className={`${getStatusColor(agent.status)} fill-current`}
                  />
                  <div className="flex-1">
                    <div className="font-medium text-dark-100">{agent.name}</div>
                    <div className="text-xs text-dark-400 flex items-center gap-2">
                      <span>{agent.executor}</span>
                      {agent.capabilities.length > 0 && (
                        <>
                          <span>•</span>
                          <span>{agent.capabilities.join(', ')}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      agent.status === 'online'
                        ? 'bg-green-500/20 text-green-400'
                        : agent.status === 'busy'
                        ? 'bg-yellow-500/20 text-yellow-400'
                        : 'bg-dark-700 text-dark-400'
                    }`}
                  >
                    {getStatusLabel(agent.status)}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-dark-300 mb-1.5">
            Project Path (on agent)
          </label>
          <input
            type="text"
            className="input"
            placeholder="/home/user/projects/myapp"
            value={formData.projectPath}
            onChange={(e) => setFormData({ ...formData, projectPath: e.target.value })}
            required
          />
          <p className="text-xs text-dark-500 mt-1">
            Path must be in the agent&apos;s allowed paths
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-dark-300 mb-1.5">
            Security Mode
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label
              className={`card p-3 cursor-pointer transition-colors ${
                formData.securityMode === 'auto'
                  ? 'border-primary-500 bg-primary-500/10'
                  : 'hover:border-dark-600'
              }`}
            >
              <input
                type="radio"
                name="securityMode"
                value="auto"
                checked={formData.securityMode === 'auto'}
                onChange={(e) =>
                  setFormData({ ...formData, securityMode: e.target.value as 'auto' | 'safe' })
                }
                className="sr-only"
              />
              <div className="font-medium text-dark-100">Auto</div>
              <div className="text-xs text-dark-400 mt-1">
                Fast execution with post-validation
              </div>
            </label>
            <label
              className={`card p-3 cursor-pointer transition-colors ${
                formData.securityMode === 'safe'
                  ? 'border-primary-500 bg-primary-500/10'
                  : 'hover:border-dark-600'
              }`}
            >
              <input
                type="radio"
                name="securityMode"
                value="safe"
                checked={formData.securityMode === 'safe'}
                onChange={(e) =>
                  setFormData({ ...formData, securityMode: e.target.value as 'auto' | 'safe' })
                }
                className="sr-only"
              />
              <div className="font-medium text-dark-100">Safe</div>
              <div className="text-xs text-dark-400 mt-1">
                Confirm sensitive operations
              </div>
            </label>
          </div>
        </div>

        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={formData.enableWorktree}
              onChange={(e) => setFormData({ ...formData, enableWorktree: e.target.checked })}
              className="rounded border-dark-600 bg-dark-800 text-primary-500 focus:ring-primary-500"
            />
            <div>
              <span className="text-sm font-medium text-dark-300">Git Worktree Isolation</span>
              <p className="text-xs text-dark-500 mt-0.5">
                Each task runs in an isolated git worktree branch. Merge changes back after review.
              </p>
            </div>
          </label>
        </div>

        <div>
          <label className="block text-sm font-medium text-dark-300 mb-1.5">
            Post-Task Hook <span className="text-dark-500">(optional)</span>
          </label>
          <input
            type="text"
            className="input"
            placeholder="pm2 restart my-app"
            value={formData.postTaskHook}
            onChange={(e) => setFormData({ ...formData, postTaskHook: e.target.value })}
          />
          <p className="text-xs text-dark-500 mt-1">
            Shell command to run on the agent after each successful task
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-dark-300 mb-1.5">
            Extra Mounts <span className="text-dark-500">(optional, Docker only)</span>
          </label>
          <div className="space-y-2">
            {formData.extraMounts.map((mount, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  type="text"
                  className="input flex-1"
                  placeholder="/host/path"
                  value={mount.source}
                  onChange={(e) => {
                    const mounts = [...formData.extraMounts];
                    mounts[index] = { ...mounts[index], source: e.target.value };
                    setFormData({ ...formData, extraMounts: mounts });
                  }}
                />
                <input
                  type="text"
                  className="input flex-1"
                  placeholder="/container/path"
                  value={mount.target}
                  onChange={(e) => {
                    const mounts = [...formData.extraMounts];
                    mounts[index] = { ...mounts[index], target: e.target.value };
                    setFormData({ ...formData, extraMounts: mounts });
                  }}
                />
                <label className="flex items-center gap-1 text-xs text-dark-400 whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={mount.readonly || false}
                    onChange={(e) => {
                      const mounts = [...formData.extraMounts];
                      mounts[index] = { ...mounts[index], readonly: e.target.checked };
                      setFormData({ ...formData, extraMounts: mounts });
                    }}
                    className="rounded border-dark-600"
                  />
                  RO
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const mounts = formData.extraMounts.filter((_, i) => i !== index);
                    setFormData({ ...formData, extraMounts: mounts });
                  }}
                  className="text-dark-400 hover:text-red-400 transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => {
                setFormData({
                  ...formData,
                  extraMounts: [...formData.extraMounts, { source: '', target: '' }],
                });
              }}
              className="btn btn-secondary text-xs py-1 px-2 flex items-center gap-1"
            >
              <Plus size={14} />
              Add Mount
            </button>
          </div>
          <p className="text-xs text-dark-500 mt-1">
            Additional volumes to mount in Docker containers (source → target)
          </p>
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createProject.isPending || !formData.agentId}
            className="btn btn-primary"
          >
            {createProject.isPending ? (
              <>
                <Loader2 size={16} className="animate-spin mr-2" />
                Creating...
              </>
            ) : (
              'Create Project'
            )}
          </button>
        </div>

        {createProject.isError && (
          <p className="text-red-400 text-sm mt-2">
            {createProject.error instanceof Error
              ? createProject.error.message
              : 'Failed to create project'}
          </p>
        )}
      </form>
    </Modal>
  );
}
