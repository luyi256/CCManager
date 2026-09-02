import { useState, useCallback, useRef, useEffect } from 'react';
import { Send, Loader2, AlertCircle, Image, Paperclip } from 'lucide-react';
import VoiceInput from '../common/VoiceInput';
import ImageThumbnail from '../common/ImageThumbnail';
import ModelSwitcher from '../Conversation/ModelSwitcher';
import type { Runner, Task } from '../../types';
import { readImageFiles, type PendingImage } from '../../utils/images';

interface TaskInputProps {
  onSubmit: (data: { prompt: string; isPlanMode: boolean; runner?: Runner; model?: string; dependsOn?: number; images?: string[] }) => Promise<void>;
  isSubmitting: boolean;
  tasks: Task[];
  lastModel?: string;
  lastRunner?: Runner;
  agentId?: string;
}

export default function TaskInput({ onSubmit, isSubmitting, tasks, lastModel, lastRunner, agentId }: TaskInputProps) {
  const [prompt, setPrompt] = useState('');
  const [isPlanMode, setIsPlanMode] = useState(false);
  const [runner, setRunner] = useState<Runner>(lastRunner || 'claude');
  const [model, setModel] = useState(lastModel || '');
  const [dependsOn, setDependsOn] = useState<number | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [isReadingImages, setIsReadingImages] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Update model when lastModel prop changes (project switch)
  useEffect(() => {
    setModel(lastModel || '');
  }, [lastModel]);

  useEffect(() => {
    if (lastRunner) {
      setRunner(lastRunner);
    }
  }, [lastRunner]);

  const pendingTasks = tasks.filter((t) =>
    ['pending', 'running', 'waiting', 'waiting_permission', 'plan_review'].includes(t.status)
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items || [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (files.length === 0) return;
      if (isReadingImages) return;
      setIsReadingImages(true);
      try {
        const result = await readImageFiles(files, images);
        setImages(result.images);
        setError(result.error || null);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Could not read image');
      } finally {
        setIsReadingImages(false);
      }
    },
    [images, isReadingImages]
  );

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    if (isReadingImages) return;
    setIsReadingImages(true);
    try {
      const result = await readImageFiles(files, images);
      setImages(result.images);
      setError(result.error || null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not read image');
    } finally {
      setIsReadingImages(false);
      // Reset so selecting the same file again triggers onChange
      e.target.value = '';
    }
  }, [images, isReadingImages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!prompt.trim() && images.length === 0) || isSubmitting || isReadingImages) return;

    setError(null);
    try {
      const imageBase64s = images.length > 0
        ? images.map((img) => img.dataUrl)
        : undefined;
      await onSubmit({
        prompt: prompt.trim() || `Please analyze the ${images.length} attached image${images.length === 1 ? '' : 's'}.`,
        isPlanMode,
        runner,
        model: model || undefined,
        dependsOn,
        images: imageBase64s,
      });
      setPrompt('');
      setDependsOn(undefined);
      setImages([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    }
  };

  const handleVoiceTranscription = (text: string) => {
    setPrompt((prev) => (prev ? `${prev} ${text}` : text));
  };

  return (
    <form onSubmit={handleSubmit} className="card p-4">
      {error && (
        <div className="mb-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-2">
          <AlertCircle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-red-400 text-sm">{error}</p>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-300 text-sm"
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1 flex flex-col">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if ((prompt.trim() || images.length > 0) && !isSubmitting) {
                  handleSubmit(e);
                }
              }
            }}
            placeholder="Describe the coding task..."
            className="input resize-none flex-1"
            disabled={isSubmitting || isReadingImages}
          />
          {/* Pasted image previews */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {images.map((img) => (
                <ImageThumbnail
                  key={img.id}
                  src={img.dataUrl}
                  alt={img.name}
                  size="md"
                  onRemove={() => removeImage(img.id)}
                />
              ))}
              <div className="flex items-center text-dark-500 text-xs gap-1">
                <Image size={12} />
                <span>{images.length}</span>
              </div>
            </div>
          )}
        </div>
        <div className="flex sm:flex-col gap-2">
          <VoiceInput onTranscription={handleVoiceTranscription} />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isSubmitting || isReadingImages}
            className="p-2 rounded-lg bg-dark-700 text-dark-400 hover:text-dark-200 hover:bg-dark-600 transition-colors"
            title="Upload images"
          >
            <Paperclip size={20} />
          </button>
          <button
            type="submit"
            disabled={(!prompt.trim() && images.length === 0) || isSubmitting || isReadingImages}
            className="btn btn-primary p-2 flex-1 sm:flex-none"
          >
            {isSubmitting || isReadingImages ? (
              <Loader2 size={20} className="animate-spin" />
            ) : (
              <Send size={20} />
            )}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-4 mt-3 flex-wrap">
        <ModelSwitcher
          selectedRunner={runner}
          selectedModel={model}
          onRunnerChange={setRunner}
          onModelChange={setModel}
          agentId={agentId}
        />

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
