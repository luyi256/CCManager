import { useQuery } from '@tanstack/react-query';
import * as api from '../services/api';

export function useSessions(projectId: string, enabled = true) {
  return useQuery({
    queryKey: ['sessions', projectId],
    queryFn: () => api.getSessions(projectId),
    enabled: !!projectId && enabled,
    staleTime: 30_000,
  });
}

export function useActiveSessions(projectId: string) {
  return useQuery({
    queryKey: ['sessions', 'active', projectId],
    queryFn: () => api.getActiveSessions(projectId),
    enabled: !!projectId,
    staleTime: 10_000,
    refetchInterval: 10_000,
  });
}

export function useSessionSearch(projectId: string, query: string) {
  return useQuery({
    queryKey: ['sessionSearch', projectId, query],
    queryFn: () => api.searchSessions(projectId, query),
    enabled: !!projectId && query.trim().length >= 2,
    staleTime: 30_000,
  });
}

export function useSessionDetail(projectId: string, sessionId: string | null, relatedSessionIds?: string[]) {
  return useQuery({
    queryKey: ['sessionDetail', projectId, sessionId, relatedSessionIds],
    queryFn: () => api.getSessionDetail(projectId, sessionId!, relatedSessionIds),
    enabled: !!projectId && !!sessionId,
    staleTime: Infinity, // Session content is immutable
  });
}
