import { useState, useRef, useCallback } from 'react';
import { transcribeAudio } from '../services/api';

interface VoiceInputState {
  isRecording: boolean;
  isTranscribing: boolean;
  error: string | null;
}

export function useVoiceInput(onTranscription: (text: string) => void) {
  const [state, setState] = useState<VoiceInputState>({
    isRecording: false,
    isTranscribing: false,
    error: null,
  });

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus',
      });

      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
        stream.getTracks().forEach((track) => track.stop());

        setState((prev) => ({ ...prev, isRecording: false, isTranscribing: true }));

        try {
          const { text } = await transcribeAudio(audioBlob);
          onTranscription(text);
          setState((prev) => ({ ...prev, isTranscribing: false, error: null }));
        } catch (error) {
          setState((prev) => ({
            ...prev,
            isTranscribing: false,
            error: error instanceof Error ? error.message : 'Transcription failed',
          }));
        }
      };

      mediaRecorder.start();
      mediaRecorderRef.current = mediaRecorder;
      setState({ isRecording: true, isTranscribing: false, error: null });
    } catch (error) {
      setState((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to start recording',
      }));
    }
  }, [onTranscription]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && state.isRecording) {
      mediaRecorderRef.current.stop();
    }
  }, [state.isRecording]);

  const toggleRecording = useCallback(() => {
    if (state.isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [state.isRecording, startRecording, stopRecording]);

  return {
    ...state,
    startRecording,
    stopRecording,
    toggleRecording,
  };
}
