import { useState, useRef, useCallback } from 'react';
import { transcribeAudio } from '../services/api';

interface VoiceInputState {
  isRecording: boolean;
  isStarting: boolean;
  isTranscribing: boolean;
  error: string | null;
}

function getExtFromMime(mime: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'mp4';
  return 'webm';
}

export function useVoiceInput(onTranscription: (text: string) => void) {
  const [state, setState] = useState<VoiceInputState>({
    isRecording: false,
    isStarting: false,
    isTranscribing: false,
    error: null,
  });

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Only check basic API existence — don't gate on isSecureContext,
  // so the mic button always renders. Errors surface when the user clicks.
  const canRecord = typeof MediaRecorder !== 'undefined';

  const startRecording = useCallback(async () => {
    // Immediate visual feedback
    setState({ isRecording: false, isStarting: true, isTranscribing: false, error: null });

    // Runtime check: navigator.mediaDevices is undefined in non-secure HTTP contexts (Chrome)
    if (!navigator.mediaDevices?.getUserMedia) {
      setState({
        isRecording: false,
        isStarting: false,
        isTranscribing: false,
        error: !window.isSecureContext
          ? 'HTTP connection detected. Browser blocks microphone access over HTTP. Please upload an audio file instead.'
          : 'Browser does not support recording. Please upload an audio file instead.',
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
        stream.getTracks().forEach((t) => t.stop());

        const actualMime = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: actualMime });
        chunksRef.current = [];

        if (blob.size === 0) {
          setState({ isRecording: false, isStarting: false, isTranscribing: false, error: 'No audio recorded' });
          return;
        }

        setState((prev) => ({ ...prev, isRecording: false, isTranscribing: true }));

        try {
          const ext = getExtFromMime(actualMime);
          const result = await transcribeAudio(blob, `recording.${ext}`);
          if (result.text?.trim()) {
            onTranscription(result.text.trim());
          }
          setState({ isRecording: false, isStarting: false, isTranscribing: false, error: null });
        } catch (err) {
          setState({
            isRecording: false,
            isStarting: false,
            isTranscribing: false,
            error: err instanceof Error ? err.message : 'Transcription failed',
          });
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setState({ isRecording: true, isStarting: false, isTranscribing: false, error: null });
    } catch (err) {
      let message = 'Cannot access microphone';
      if (err instanceof DOMException) {
        if (err.name === 'NotAllowedError') {
          message = 'Microphone permission denied. Please allow microphone access in browser settings.';
        } else if (err.name === 'NotFoundError') {
          message = 'No microphone device found';
        }
      }
      setState({ isRecording: false, isStarting: false, isTranscribing: false, error: message });
    }
  }, [onTranscription]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
  }, []);

  const toggleRecording = useCallback(() => {
    if (state.isStarting) return;
    if (state.isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [state.isStarting, state.isRecording, startRecording, stopRecording]);

  const transcribeFile = useCallback(async (file: File) => {
    setState({ isRecording: false, isStarting: false, isTranscribing: true, error: null });
    try {
      const result = await transcribeAudio(file, file.name);
      if (result.text?.trim()) {
        onTranscription(result.text.trim());
      }
      setState({ isRecording: false, isStarting: false, isTranscribing: false, error: null });
    } catch (err) {
      setState({
        isRecording: false,
        isStarting: false,
        isTranscribing: false,
        error: err instanceof Error ? err.message : 'Transcription failed',
      });
    }
  }, [onTranscription]);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  return {
    ...state,
    canRecord,
    startRecording,
    stopRecording,
    toggleRecording,
    transcribeFile,
    clearError,
  };
}
