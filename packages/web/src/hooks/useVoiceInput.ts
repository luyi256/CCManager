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
    if (!navigator.mediaDevices?.getUserMedia) {
      setState({
        isRecording: false,
        isTranscribing: false,
        error: 'Microphone access is not supported in this browser or requires HTTPS.',
      });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        // Release microphone
        stream.getTracks().forEach((t) => t.stop());

        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        chunksRef.current = [];

        if (blob.size === 0) {
          setState({ isRecording: false, isTranscribing: false, error: 'No audio recorded.' });
          return;
        }

        setState((prev) => ({ ...prev, isRecording: false, isTranscribing: true }));

        try {
          const result = await transcribeAudio(blob);
          if (result.text?.trim()) {
            onTranscription(result.text.trim());
          } else {
            setState((prev) => ({
              ...prev,
              isTranscribing: false,
              error: 'No speech detected. Please try again.',
            }));
            return;
          }
          setState((prev) => ({ ...prev, isTranscribing: false, error: null }));
        } catch (err) {
          setState((prev) => ({
            ...prev,
            isTranscribing: false,
            error: err instanceof Error ? err.message : 'Transcription failed',
          }));
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setState({ isRecording: true, isTranscribing: false, error: null });
    } catch (err) {
      let message = 'Failed to access microphone.';
      if (err instanceof DOMException) {
        if (err.name === 'NotAllowedError') {
          message = 'Microphone access denied. Please allow microphone permission.';
        } else if (err.name === 'NotFoundError') {
          message = 'No microphone found on this device.';
        }
      }
      setState({ isRecording: false, isTranscribing: false, error: message });
    }
  }, [onTranscription]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
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
