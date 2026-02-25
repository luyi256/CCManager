import { useState, useRef, useCallback } from 'react';

interface SpeechRecognitionEvent {
  results: { [index: number]: { [index: number]: { transcript: string } }; length: number };
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent {
  error: string;
  message?: string;
}

interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

interface VoiceInputState {
  isRecording: boolean;
  error: string | null;
}

function getSpeechRecognition(): (new () => SpeechRecognitionInstance) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    (new () => SpeechRecognitionInstance) | null;
}

export function useVoiceInput(onTranscription: (text: string) => void) {
  const [state, setState] = useState<VoiceInputState>({
    isRecording: false,
    error: null,
  });

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  const startRecording = useCallback(() => {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      setState({
        isRecording: false,
        error: 'Speech recognition is not supported in this browser. Please use Chrome or Edge.',
      });
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = navigator.language || 'zh-CN';
      recognition.interimResults = false;
      recognition.continuous = false;

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        if (transcript.trim()) {
          onTranscription(transcript.trim());
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        let message: string;
        switch (event.error) {
          case 'not-allowed':
            message = 'Microphone access denied. Please allow microphone permission.';
            break;
          case 'no-speech':
            message = 'No speech detected. Please try again.';
            break;
          case 'network':
            message = 'Network error. Speech recognition requires an internet connection.';
            break;
          default:
            message = `Speech recognition error: ${event.error}`;
        }
        setState({ isRecording: false, error: message });
      };

      recognition.onend = () => {
        setState((prev) => ({ ...prev, isRecording: false }));
        recognitionRef.current = null;
      };

      recognition.start();
      recognitionRef.current = recognition;
      setState({ isRecording: true, error: null });
    } catch (error) {
      setState({
        isRecording: false,
        error: error instanceof Error ? error.message : 'Failed to start speech recognition',
      });
    }
  }, [onTranscription]);

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
  }, []);

  const toggleRecording = useCallback(() => {
    if (state.isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [state.isRecording, startRecording, stopRecording]);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  return {
    ...state,
    startRecording,
    stopRecording,
    toggleRecording,
    clearError,
  };
}
