import { useQuery } from '@tanstack/react-query';
import * as api from '../services/api';

export function useSessions(projectId: string) {
  return useQuery({
    queryKey: ['sessions', projectId],
    queryFn: () => api.getSessions(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useSessionDetail(projectId: string, sessionId: string | null) {
  return useQuery({
    queryKey: ['sessionDetail', projectId, sessionId],
    queryFn: () => api.getSessionDetail(projectId, sessionId!),
    enabled: !!projectId && !!sessionId,
    staleTime: Infinity, // Session content is immutable
  });
}
