import { useEffect, useRef } from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useVoiceInput } from '../../hooks/useVoiceInput';

interface VoiceInputProps {
  onTranscription: (text: string) => void;
  className?: string;
}

const AUDIO_ACCEPT = 'audio/webm,audio/ogg,audio/mp3,audio/mp4,audio/wav,audio/flac,audio/m4a,audio/mpeg,.webm,.ogg,.mp3,.mp4,.wav,.flac,.m4a';

export default function VoiceInput({ onTranscription, className }: VoiceInputProps) {
  const {
    isRecording, isStarting, isTranscribing, canRecord,
    toggleRecording, transcribeFile, error, clearError,
  } = useVoiceInput(onTranscription);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const busy = isStarting || isTranscribing;

  // Auto-dismiss inline error after 6 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(clearError, 6000);
    return () => clearTimeout(timer);
  }, [error, clearError]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      transcribeFile(file);
    }
    // Reset so same file can be selected again
    e.target.value = '';
  };

  const handleClick = () => {
    if (busy) return;
    if (canRecord) {
      toggleRecording();
    } else {
      // On HTTP (non-secure context), microphone API is unavailable.
      // Fall back to file upload picker directly.
      fileInputRef.current?.click();
    }
  };

  return (
    <div className={clsx('relative flex flex-col gap-1', className)}>
      {/* Hidden file input for audio upload - always rendered.
          Use absolute + clip approach instead of display:none to ensure .click() works cross-browser */}
      <input
        ref={fileInputRef}
        type="file"
        accept={AUDIO_ACCEPT}
        onChange={handleFileChange}
        tabIndex={-1}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}
      />

      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className={clsx(
          'p-2 rounded-lg transition-all duration-200',
          isRecording
            ? 'bg-red-500 text-white animate-pulse'
            : busy
              ? 'bg-dark-700 text-dark-500 cursor-wait'
              : 'bg-dark-700 text-dark-400 hover:text-dark-200 hover:bg-dark-600',
        )}
        title={
          isStarting
            ? '请求麦克风权限...'
            : isRecording
              ? '停止录音'
              : isTranscribing
                ? '转写中...'
                : canRecord
                  ? '语音输入'
                  : '上传音频文件（HTTP 下不支持直接录音）'
        }
      >
        {busy ? (
          <Loader2 size={20} className="animate-spin" />
        ) : isRecording ? (
          <MicOff size={20} />
        ) : (
          <Mic size={20} />
        )}
      </button>

      {error && (
        <div
          className="absolute right-0 top-full mt-2 z-50 w-64 px-3 py-2.5 text-xs text-red-200 bg-red-950 border border-red-500/50 rounded-lg shadow-xl cursor-pointer"
          onClick={clearError}
        >
          {error}
        </div>
      )}
    </div>
  );
}
