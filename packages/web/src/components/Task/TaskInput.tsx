import { useState, useCallback } from 'react';
import { Send, Loader2 } from 'lucide-react';
import VoiceInput from '../common/VoiceInput';
import type { Task } from '../../types';

interface TaskInputProps {
  onSubmit: (data: { prompt: string; isPlanMode: boolean; dependsOn?: number }) => Promise<void>;
  isSubmitting: boolean;
  tasks: Task[];
}

export default function TaskInput({ onSubmit, isSubmitting, tasks }: TaskInputProps) {
  const [prompt, setPrompt] = useState('');
  const [isPlanMode, setIsPlanMode] = useState(false);
  const [dependsOn, setDependsOn] = useState<number | undefined>();

  const pendingTasks = tasks.filter((t) =>
    ['pending', 'running', 'waiting', 'plan_review'].includes(t.status)
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isSubmitting) return;

    await onSubmit({ prompt: prompt.trim(), isPlanMode, dependsOn });
    setPrompt('');
    setDependsOn(undefined);
  };

  const handleVoiceTranscription = useCallback((text: string) => {
    setPrompt((prev) => (prev ? `${prev} ${text}` : text));
  }, []);

  return (
    <form onSubmit={handleSubmit} className="card p-4">
      <div className="flex gap-3">
        <div className="flex-1">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the task for Claude Code..."
            className="input resize-none h-20"
            disabled={isSubmitting}
          />
        </div>
        <div className="flex flex-col gap-2">
          <VoiceInput onTranscription={handleVoiceTranscription} />
          <button
            type="submit"
            disabled={!prompt.trim() || isSubmitting}
            className="btn btn-primary p-2"
          >
            {isSubmitting ? (
              <Loader2 size={20} className="animate-spin" />
            ) : (
              <Send size={20} />
            )}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-4 mt-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={isPlanMode}
            onChange={(e) => setIsPlanMode(e.target.checked)}
            className="w-4 h-4 rounded border-dark-600 bg-dark-700 text-primary-500 focus:ring-primary-500"
          />
          <span className="text-sm text-dark-300">Plan Mode</span>
        </label>

        {pendingTasks.length > 0 && (
          <select
            value={dependsOn || ''}
            onChange={(e) => setDependsOn(e.target.value ? Number(e.target.value) : undefined)}
            className="input py-1.5 text-sm max-w-[200px]"
          >
            <option value="">No dependency</option>
            {pendingTasks.map((task) => (
              <option key={task.id} value={task.id}>
                #{task.id}: {task.prompt.slice(0, 30)}...
              </option>
            ))}
          </select>
        )}
      </div>
    </form>
  );
}
