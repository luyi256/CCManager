import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as api from '../services/api';

/**
 * Loads attachment bytes with the auth header and exposes them as an object URL.
 *
 * The API is Bearer-authenticated, so a plain <img src="/api/..."> would 401.
 * The Blob is cached by React Query (attachment bytes never change), while each
 * mount creates and revokes its own URL — so revoking is always safe and no
 * reference counting is needed.
 */
export function useAttachmentUrl(taskId: number, attachmentId: number | null): {
  url: string | null;
  isLoading: boolean;
  isError: boolean;
} {
  const { data: blob, isLoading, isError } = useQuery({
    queryKey: ['attachment', taskId, attachmentId],
    queryFn: () => api.fetchAttachmentBlob(taskId, attachmentId as number),
    enabled: attachmentId !== null,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    retry: 1,
  });

  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  return { url, isLoading, isError };
}

export function useTaskAttachments(taskId: number | null) {
  return useQuery({
    queryKey: ['taskAttachments', taskId],
    queryFn: () => api.getTaskAttachments(taskId as number),
    enabled: taskId !== null,
  });
}
