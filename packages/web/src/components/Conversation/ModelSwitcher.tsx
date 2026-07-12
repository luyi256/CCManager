import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, Cpu, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import * as api from '../../services/api';
import type { Runner } from '../../types';

const RUNNERS: Array<{ id: Runner; label: string; accent: string }> = [
  { id: 'codex', label: 'Codex', accent: 'text-emerald-400' },
  { id: 'claude', label: 'Claude', accent: 'text-primary-400' },
  { id: 'qwen', label: 'Qwen', accent: 'text-amber-400' },
];

type Step = 'runner' | 'mode' | 'models';

interface ModelSwitcherProps {
  selectedRunner: Runner;
  selectedModel: string;
  onRunnerChange: (runner: Runner) => void;
  onModelChange: (model: string) => void;
  agentId?: string;
  compact?: boolean;
}

function shortModelName(model: string): string {
  return model
    .replace(/^claude-/, '')
    .replace(/^openai\//, '')
    .replace(/^qwen\//, '');
}

export default function ModelSwitcher({
  selectedRunner,
  selectedModel,
  onRunnerChange,
  onModelChange,
  agentId,
  compact = false,
}: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('runner');
  const [draftRunner, setDraftRunner] = useState<Runner>(selectedRunner);
  const [models, setModels] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelListMeta, setModelListMeta] = useState<{ cached?: boolean; updatedAt?: string } | null>(null);

  const currentRunner = useMemo(
    () => RUNNERS.find((runner) => runner.id === selectedRunner) ?? RUNNERS[0],
    [selectedRunner]
  );

  const draftRunnerMeta = useMemo(
    () => RUNNERS.find((runner) => runner.id === draftRunner) ?? RUNNERS[0],
    [draftRunner]
  );

  const close = () => {
    setOpen(false);
    setStep('runner');
    setDraftRunner(selectedRunner);
    setError(null);
  };

  const loadModels = async (runner: Runner, force = false) => {
    if (!agentId) {
      setModels([]);
      setError('Agent is required to run /model');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const result = await api.getRunnerModels(agentId, runner, force);
      setModels(result.models);
      setModelListMeta({ cached: result.cached, updatedAt: result.updatedAt });
      if (result.models.length === 0) {
        setError('No models returned from /model');
      }
    } catch (err) {
      setModels([]);
      setModelListMeta(null);
      setError(err instanceof Error ? err.message : 'Failed to load models');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setDraftRunner(selectedRunner);
    setStep('runner');
  }, [open, selectedRunner]);

  const applyDefault = () => {
    onRunnerChange(draftRunner);
    onModelChange('');
    close();
  };

  const openModelList = () => {
    onRunnerChange(draftRunner);
    onModelChange('');
    setStep('models');
    setModels([]);
    setModelListMeta(null);
    void loadModels(draftRunner);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`rounded-md border border-dark-600 bg-dark-800 text-dark-300 hover:text-dark-100 hover:border-dark-500 transition-colors flex items-center gap-1.5 ${
          compact ? 'px-1.5 py-1 text-xs' : 'px-2.5 py-1.5 text-sm'
        }`}
        title="Switch coding model"
      >
        <span className="relative inline-flex h-4 w-4 items-center justify-center">
          <Cpu size={compact ? 13 : 15} className={currentRunner.accent} />
          <Sparkles size={8} className="absolute -right-1 -bottom-1 text-dark-200" />
        </span>
        {!compact && <span>{currentRunner.label}</span>}
        {selectedModel && (
          <span className="max-w-[90px] truncate text-dark-500">
            {shortModelName(selectedModel)}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-dark-700 bg-dark-850 shadow-xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-dark-700">
            <div className="flex items-center gap-2 text-sm font-medium text-dark-200">
              <Bot size={15} />
              Change model
            </div>
            <button
              type="button"
              onClick={close}
              className="p-1 text-dark-500 hover:text-dark-200"
              title="Close"
            >
              <X size={14} />
            </button>
          </div>

          {step === 'runner' && (
            <div className="p-2">
              <div className="text-xs uppercase text-dark-500 px-1 pb-2">Coding software</div>
              <div className="grid grid-cols-1 gap-1">
                {RUNNERS.map((runner) => (
                  <button
                    key={runner.id}
                    type="button"
                    onClick={() => {
                      setDraftRunner(runner.id);
                      setStep('mode');
                      setError(null);
                    }}
                    className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-dark-300 hover:bg-dark-800"
                  >
                    <Cpu size={15} className={runner.accent} />
                    <span className="flex-1">{runner.label}</span>
                    {selectedRunner === runner.id && <Check size={14} className="text-dark-400" />}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 'mode' && (
            <div className="p-2">
              <div className="px-1 pb-2 text-xs uppercase text-dark-500">
                {draftRunnerMeta.label} model option
              </div>
              <button
                type="button"
                onClick={applyDefault}
                className="w-full flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-dark-300 hover:bg-dark-800"
              >
                <span className="w-4">{!selectedModel && selectedRunner === draftRunner && <Check size={14} />}</span>
                <span className="flex-1">Use default model</span>
              </button>
              <button
                type="button"
                onClick={openModelList}
                className="mt-1 w-full flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-dark-300 hover:bg-dark-800"
              >
                <RefreshCw size={14} className="text-dark-500" />
                <span className="flex-1">Switch model from /model</span>
              </button>
            </div>
          )}

          {step === 'models' && (
            <div className="p-2">
              <div className="flex items-center justify-between px-1 pb-2">
                <div>
                  <span className="block text-xs uppercase text-dark-500">{draftRunnerMeta.label} models</span>
                  {modelListMeta?.updatedAt && (
                    <span className="block text-[11px] text-dark-600">
                      {modelListMeta.cached ? 'Cached' : 'Updated'} {new Date(modelListMeta.updatedAt).toLocaleString()}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => loadModels(draftRunner, true)}
                  disabled={!agentId || isLoading}
                  className="p-1 text-dark-500 hover:text-dark-200 disabled:text-dark-700"
                  title="Refresh /model"
                >
                  {isLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                </button>
              </div>

              <div className="max-h-64 overflow-y-auto py-1">
                {isLoading && models.length === 0 ? (
                  <div className="px-2 py-4 text-center text-sm text-dark-500">Loading /model...</div>
                ) : (
                  models.map((model) => (
                    <button
                      key={model}
                      type="button"
                      onClick={() => {
                        onRunnerChange(draftRunner);
                        onModelChange(model);
                        close();
                      }}
                      className="w-full flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-dark-300 hover:bg-dark-800"
                    >
                      <span className="w-4">{selectedRunner === draftRunner && selectedModel === model && <Check size={14} />}</span>
                      <span className="truncate">{shortModelName(model)}</span>
                    </button>
                  ))
                )}
              </div>

              {error && (
                <div className="px-2 py-2 text-xs text-amber-400 border-t border-dark-700">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
