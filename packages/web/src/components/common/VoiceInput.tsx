import { useEffect, useRef } from 'react';
import { Mic, MicOff, Loader2, Upload } from 'lucide-react';
import { clsx } from 'clsx';
import { useVoiceInput } from '../../hooks/useVoiceInput';

interface VoiceInputProps {
  onTranscription: (text: string) => void;
  className?: string;
}

const AUDIO_ACCEPT = 'audio/webm,audio/ogg,audio/mp3,audio/mp4,audio/wav,audio/flac,audio/m4a,audio/mpeg,.webm,.ogg,.mp3,.mp4,.wav,.flac,.m4a';

export default function VoiceInput({ onTranscription, className }: VoiceInputProps) {
  const {
    isRecording, isTranscribing, canRecord,
    toggleRecording, transcribeFile, error, clearError,
  } = useVoiceInput(onTranscription);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-dismiss inline error after 4 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(clearError, 4000);
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

  return (
    <div className={clsx('relative flex flex-col gap-1', className)}>
      {canRecord ? (
        <button
          type="button"
          onClick={toggleRecording}
          disabled={isTranscribing}
          className={clsx(
            'p-2 rounded-lg transition-all duration-200',
            isRecording
              ? 'bg-red-500 text-white animate-pulse'
              : isTranscribing
                ? 'bg-dark-700 text-dark-500 cursor-wait'
                : 'bg-dark-700 text-dark-400 hover:text-dark-200 hover:bg-dark-600',
          )}
          title={
            isRecording
              ? '停止录音'
              : isTranscribing
                ? '转写中...'
                : '语音输入'
          }
        >
          {isTranscribing ? (
            <Loader2 size={20} className="animate-spin" />
          ) : isRecording ? (
            <MicOff size={20} />
          ) : (
            <Mic size={20} />
          )}
        </button>
      ) : (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept={AUDIO_ACCEPT}
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isTranscribing}
            className={clsx(
              'p-2 rounded-lg transition-all duration-200',
              isTranscribing
                ? 'bg-dark-700 text-dark-500 cursor-wait'
                : 'bg-dark-700 text-dark-400 hover:text-dark-200 hover:bg-dark-600',
            )}
            title={isTranscribing ? '转写中...' : '上传音频文件'}
          >
            {isTranscribing ? (
              <Loader2 size={20} className="animate-spin" />
            ) : (
              <Upload size={20} />
            )}
          </button>
        </>
      )}

      {error && (
        <div
          className="absolute right-0 top-full mt-1 z-10 w-56 px-3 py-2 text-xs text-red-300 bg-dark-800 border border-red-500/30 rounded-lg shadow-lg cursor-pointer"
          onClick={clearError}
        >
          {error}
        </div>
      )}
    </div>
  );
}
