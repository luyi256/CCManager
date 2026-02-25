import { useEffect } from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useVoiceInput } from '../../hooks/useVoiceInput';

interface VoiceInputProps {
  onTranscription: (text: string) => void;
  className?: string;
}

export default function VoiceInput({ onTranscription, className }: VoiceInputProps) {
  const { isRecording, isTranscribing, toggleRecording, error, clearError } =
    useVoiceInput(onTranscription);

  useEffect(() => {
    if (error) {
      alert(error);
      clearError();
    }
  }, [error, clearError]);

  return (
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
        className
      )}
      title={
        isRecording
          ? 'Stop recording'
          : isTranscribing
            ? 'Transcribing...'
            : 'Start voice input'
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
  );
}
