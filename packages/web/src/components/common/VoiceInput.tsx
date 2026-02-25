import { useEffect } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { clsx } from 'clsx';
import { useVoiceInput } from '../../hooks/useVoiceInput';

interface VoiceInputProps {
  onTranscription: (text: string) => void;
  className?: string;
}

export default function VoiceInput({ onTranscription, className }: VoiceInputProps) {
  const { isRecording, toggleRecording, error, clearError } = useVoiceInput(onTranscription);

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
      className={clsx(
        'p-2 rounded-lg transition-all duration-200',
        isRecording
          ? 'bg-red-500 text-white animate-pulse'
          : 'bg-dark-700 text-dark-400 hover:text-dark-200 hover:bg-dark-600',
        className
      )}
      title={isRecording ? 'Stop recording' : 'Start voice input'}
    >
      {isRecording ? <MicOff size={20} /> : <Mic size={20} />}
    </button>
  );
}
