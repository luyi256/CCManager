import { useState, useCallback, useRef, useEffect } from 'react';
import { Send, Loader2, AlertCircle, X, Image, Paperclip } from 'lucide-react';
import VoiceInput from '../common/VoiceInput';
import * as api from '../../services/api';
import type { Task } from '../../types';

const PRESET_MODELS = [
  'claude-sonnet-4-5-20250514',
  'claude-opus-4-5-20250414',
  'claude-haiku-4-5-20251001',
];

interface PastedImage {
  id: string;
  dataUrl: string; // data:image/png;base64,...
  name: string;
}

interface TaskInputProps {
  onSubmit: (data: { prompt: string; isPlanMode: boolean; runner?: 'claude' | 'codex'; model?: string; dependsOn?: number; images?: string[] }) => Promise<void>;
  isSubmitting: boolean;
  tasks: Task[];
  lastModel?: string;
}

export default function TaskInput({ onSubmit, isSubmitting, tasks, lastModel }: TaskInputProps) {
  const [prompt, setPrompt] = useState('');
  const [isPlanMode, setIsPlanMode] = useState(false);
  const [runner, setRunner] = useState<'claude' | 'codex'>('claude');
  const [model, setModel] = useState(lastModel || '');
  const [customModelInput, setCustomModelInput] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [dependsOn, setDependsOn] = useState<number | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<PastedImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);

  // Load custom models on mount
  useEffect(() => {
    api.getCustomModels().then(setCustomModels).catch(() => {});
  }, []);

  // Update model when lastModel prop changes (project switch)
  useEffect(() => {
    if (lastModel !== undefined) {
      setModel(lastModel || '');
    }
  }, [lastModel]);

  const allModels = [...PRESET_MODELS, ...customModels.filter(m => !PRESET_MODELS.includes(m))];

  const pendingTasks = tasks.filter((t) =>
    ['pending', 'running', 'waiting', 'plan_review'].includes(t.status)
  );

  const handleModelChange = (value: string) => {
    if (value === '__custom__') {
      setShowCustomInput(true);
      setTimeout(() => customInputRef.current?.focus(), 50);
    } else {
      setModel(value);
      setShowCustomInput(false);
    }
  };

  const handleAddCustomModel = () => {
    const trimmed = customModelInput.trim();
    if (!trimmed) return;
    setModel(trimmed);
    setShowCustomInput(false);
    setCustomModelInput('');
    // Persist if not already known
    if (!allModels.includes(trimmed)) {
      const updated = [...customModels, trimmed];
      setCustomModels(updated);
      api.saveCustomModels(updated).catch(() => {});
    }
  };

  const addImagesFromClipboard = useCallback((items: DataTransferItemList) => {
    const newImages: PastedImage[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target?.result as string;
          if (dataUrl) {
            setImages((prev) => [
              ...prev,
              {
                id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                dataUrl,
                name: file.name || `screenshot-${Date.now()}.png`,
              },
            ]);
          }
        };
        reader.readAsDataURL(file);
        newImages.push({ id: '', dataUrl: '', name: '' }); // placeholder to track we found images
      }
    }
    return newImages.length > 0;
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (e.clipboardData?.items) {
        const hasImage = addImagesFromClipboard(e.clipboardData.items);
        if (hasImage) {
          // Don't prevent default — allow text paste to still work
          // Images are handled separately
        }
      }
    },
    [addImagesFromClipboard]
  );

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        if (dataUrl) {
          setImages((prev) => [
            ...prev,
            {
              id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              dataUrl,
              name: file.name || `image-${Date.now()}.png`,
            },
          ]);
        }
      };
      reader.readAsDataURL(file);
    }
    // Reset so selecting the same file again triggers onChange
    e.target.value = '';
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!prompt.trim() && images.length === 0) || isSubmitting) return;

    setError(null);
    try {
      const imageBase64s = images.length > 0
        ? images.map((img) => img.dataUrl)
        : undefined;
      await onSubmit({
        prompt: prompt.trim(),
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

  // Helper to get display name for model
  const modelDisplayName = (m: string) => {
    // Strip common prefixes for shorter display
    return m.replace(/^claude-/, '');
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
      <div className="flex gap-3">
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
            placeholder="Describe the task for Claude Code..."
            className="input resize-none flex-1"
            disabled={isSubmitting}
          />
          {/* Pasted image previews */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {images.map((img) => (
                <div
                  key={img.id}
                  className="relative group w-16 h-16 rounded-lg overflow-hidden border border-dark-600 bg-dark-800"
                >
                  <img
                    src={img.dataUrl}
                    alt={img.name}
                    className="w-full h-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    className="absolute top-0 right-0 p-0.5 bg-dark-900/80 rounded-bl-lg text-dark-400 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              <div className="flex items-center text-dark-500 text-xs gap-1">
                <Image size={12} />
                <span>{images.length}</span>
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <VoiceInput onTranscription={handleVoiceTranscription} />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isSubmitting}
            className="p-2 rounded-lg bg-dark-700 text-dark-400 hover:text-dark-200 hover:bg-dark-600 transition-colors"
            title="Upload images"
          >
            <Paperclip size={20} />
          </button>
          <button
            type="submit"
            disabled={(!prompt.trim() && images.length === 0) || isSubmitting}
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

      <div className="flex items-center gap-4 mt-3 flex-wrap">
        <div className="flex items-center gap-1 bg-dark-800 rounded-lg p-0.5">
          <button
            type="button"
            onClick={() => setRunner('claude')}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              runner === 'claude'
                ? 'bg-primary-600 text-white'
                : 'text-dark-400 hover:text-dark-200'
            }`}
          >
            Claude
          </button>
          <button
            type="button"
            onClick={() => setRunner('codex')}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              runner === 'codex'
                ? 'bg-emerald-600 text-white'
                : 'text-dark-400 hover:text-dark-200'
            }`}
          >
            Codex
          </button>
        </div>

        {/* Model selector */}
        <div className="flex items-center gap-1.5">
          {showCustomInput ? (
            <div className="flex items-center gap-1">
              <input
                ref={customInputRef}
                type="text"
                value={customModelInput}
                onChange={(e) => setCustomModelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); handleAddCustomModel(); }
                  if (e.key === 'Escape') { setShowCustomInput(false); setCustomModelInput(''); }
                }}
                placeholder="model-name"
                className="input py-1 text-sm w-[200px]"
              />
              <button
                type="button"
                onClick={handleAddCustomModel}
                className="px-2 py-1 text-xs font-medium rounded-md bg-primary-600 text-white hover:bg-primary-700 transition-colors"
              >
                OK
              </button>
              <button
                type="button"
                onClick={() => { setShowCustomInput(false); setCustomModelInput(''); }}
                className="px-1.5 py-1 text-xs text-dark-400 hover:text-dark-200"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <select
              value={allModels.includes(model) || model === '' ? model : '__current_custom__'}
              onChange={(e) => handleModelChange(e.target.value)}
              className="input py-1.5 text-sm max-w-[220px]"
            >
              <option value="">Default Model</option>
              {allModels.map((m) => (
                <option key={m} value={m}>{modelDisplayName(m)}</option>
              ))}
              {model && !allModels.includes(model) && (
                <option value="__current_custom__">{modelDisplayName(model)}</option>
              )}
              <option value="__custom__">Custom...</option>
            </select>
          )}
        </div>

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
