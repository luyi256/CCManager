import { useQuery } from '@tanstack/react-query';
import * as api from '../services/api';
import type { Runner } from '../types';

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
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
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

export function useSessionDetail(
  projectId: string,
  runner: Runner | null,
  sessionId: string | null,
  relatedSessionIds?: string[],
) {
  return useQuery({
    queryKey: ['sessionDetail', projectId, runner, sessionId, relatedSessionIds],
    queryFn: () => api.getSessionDetail(projectId, runner!, sessionId!, relatedSessionIds),
    enabled: !!projectId && !!runner && !!sessionId,
    staleTime: Infinity, // Session content is immutable
  });
}
