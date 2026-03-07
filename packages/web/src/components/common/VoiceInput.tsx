import { useEffect } from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useVoiceInput } from '../../hooks/useVoiceInput';

interface VoiceInputProps {
  onTranscription: (text: string) => void;
  className?: string;
  compact?: boolean;
}

export default function VoiceInput({ onTranscription, className, compact }: VoiceInputProps) {
  const {
    isRecording, isStarting, isTranscribing,
    toggleRecording, error, clearError,
  } = useVoiceInput(onTranscription);

  const busy = isStarting || isTranscribing;

  // Auto-dismiss inline error after 8 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(clearError, 8000);
    return () => clearTimeout(timer);
  }, [error, clearError]);

  return (
    <div className={clsx('relative flex flex-col gap-1', className)}>
      {/* Mic button - always shown, tries to record; shows error if unavailable */}
      <button
        type="button"
        onClick={() => !busy && toggleRecording()}
        disabled={busy}
        className={clsx(
          'rounded-lg transition-all duration-200',
          compact ? 'p-1.5' : 'p-2',
          isRecording
            ? 'bg-red-500 text-white animate-pulse'
            : busy
              ? compact ? 'text-dark-500 cursor-wait' : 'bg-dark-700 text-dark-500 cursor-wait'
              : compact ? 'text-dark-400 hover:text-dark-200' : 'bg-dark-700 text-dark-400 hover:text-dark-200 hover:bg-dark-600',
        )}
        title={
          isStarting ? '请求麦克风权限...'
            : isRecording ? '停止录音'
              : isTranscribing ? '转写中...'
                : '语音输入（录音）'
        }
      >
        {busy ? (
          <Loader2 size={compact ? 16 : 20} className="animate-spin" />
        ) : isRecording ? (
          <MicOff size={compact ? 16 : 20} />
        ) : (
          <Mic size={compact ? 16 : 20} />
        )}
      </button>

      {error && (
        <div
          className="absolute left-auto right-0 top-full mt-2 z-50 w-80 px-4 py-3 text-sm font-medium text-white bg-red-600 border border-red-400 rounded-lg shadow-2xl cursor-pointer animate-bounce"
          style={{ animationIterationCount: 2, animationDuration: '0.5s' }}
          onClick={clearError}
        >
          {error}
        </div>
      )}
    </div>
  );
}
