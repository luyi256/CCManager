import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../services/api';
import type { DirListing, FileContent } from '../services/api';
import { useWebSocket } from '../contexts/WebSocketContext';

/** Safety net for filesystems that deliver no change events (e.g. network mounts). */
const SYNC_INTERVAL_MS = 10_000;
const PUSH_SYNC_DELAY_MS = 150;

export const dirListingKey = (projectId: string, path: string) => ['files', 'list', projectId, path] as const;
export const fileContentKey = (projectId: string, path: string) => ['files', 'content', projectId, path] as const;

export function useDirListing(projectId: string, path: string) {
  return useQuery({
    queryKey: dirListingKey(projectId, path),
    queryFn: () => api.getDirListing(projectId, path),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useFileContent(projectId: string, path: string | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: fileContentKey(projectId, path ?? ''),
    queryFn: async (): Promise<FileContent> => {
      const key = fileContentKey(projectId, path!);
      const previous = queryClient.getQueryData<FileContent>(key);
      const result = await api.getFileContent(projectId, path!, previous?.etag);
      if ('notModified' in result) {
        if (previous) return previous;
        const fresh = await api.getFileContent(projectId, path!);
        if ('notModified' in fresh) throw new Error('Unexpected not-modified response');
        return fresh;
      }
      return result;
    },
    enabled: !!path,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/**
 * Keeps expanded folders and the open file fresh with one batched request:
 * every cached listing and the open file are sent with their etags and only
 * what changed comes back. Runs on agent change hints, on tab focus, and on a
 * slow interval.
 */
export function useFileSync(
  projectId: string,
  expandedDirs: string[],
  openFile: string | null,
  onMissing: (dirs: string[]) => void,
) {
  const queryClient = useQueryClient();
  const { onMessage } = useWebSocket();
  const state = useRef({ expandedDirs, openFile, onMissing });
  state.current = { expandedDirs, openFile, onMissing };
  const inFlight = useRef(false);
  const rerun = useRef(false);

  const sync = useCallback(async () => {
    if (inFlight.current) {
      rerun.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        rerun.current = false;
        const { expandedDirs: dirs, openFile: file } = state.current;
        const known = ['', ...dirs]
          .map((path) => ({ path, listing: queryClient.getQueryData<DirListing>(dirListingKey(projectId, path)) }))
          .filter((item): item is { path: string; listing: DirListing } => !!item.listing)
          .map(({ path, listing }) => ({ path, etag: listing.etag }));
        const content = file ? queryClient.getQueryData<FileContent>(fileContentKey(projectId, file)) : undefined;
        if (known.length === 0 && !content) break;

        const result = await api.syncFiles(projectId, {
          dirs: known,
          file: file && content ? { path: file, etag: content.etag } : undefined,
        });
        for (const listing of result.changed) {
          queryClient.setQueryData(dirListingKey(projectId, listing.path), listing);
        }
        if (result.missing.length > 0) {
          for (const path of result.missing) {
            queryClient.removeQueries({ queryKey: dirListingKey(projectId, path), exact: true });
          }
          state.current.onMissing(result.missing);
        }
        if (result.file?.changed) {
          void queryClient.invalidateQueries({ queryKey: fileContentKey(projectId, result.file.path), exact: true });
        }
      } while (rerun.current);
    } catch {
      // Offline agent or transient error; the next trigger retries.
    } finally {
      inFlight.current = false;
    }
  }, [projectId, queryClient]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = onMessage((msg) => {
      if (msg.type !== 'files:changed' || msg.projectId !== projectId) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void sync();
      }, PUSH_SYNC_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [onMessage, projectId, sync]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void sync();
    }, SYNC_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void sync();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sync]);

  return sync;
}
