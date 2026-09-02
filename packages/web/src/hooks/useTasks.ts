import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as api from '../services/api';
import type { Runner, Task } from '../types';

export function useTasks(projectId: string) {
  return useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => api.getTasks(projectId),
    enabled: !!projectId,
    refetchInterval: 5000, // Poll for updates
  });
}

export function useTask(taskId: number) {
  return useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.getTask(taskId),
    enabled: !!taskId,
    refetchInterval: 3000, // Poll for updates more frequently
  });
}

export function useCreateTask(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { prompt: string; isPlanMode: boolean; runner?: Runner; model?: string; dependsOn?: number; images?: string[] }) =>
      api.createTask(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, data }: { taskId: number; data: Partial<Task> }) =>
      api.updateTask(taskId, data),
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', task.projectId] });
      queryClient.invalidateQueries({ queryKey: ['task', task.id] });
    },
  });
}

export function useCancelTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.cancelTask,
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', task.projectId] });
      queryClient.invalidateQueries({ queryKey: ['task', task.id] });
    },
  });
}

export function useRetryTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.retryTask,
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', task.projectId] });
    },
  });
}

export function useContinueTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      taskId,
      prompt,
      images,
      runner,
      model,
    }: {
      taskId: number;
      prompt: string;
      images?: string[];
      runner?: Runner;
      model?: string;
    }) => api.continueTask(taskId, prompt, images, runner, model),
    onSuccess: (task) => {
      // Immediately update the task cache with new data
      queryClient.setQueryData(['task', task.id], task);
      // Optimistically update tasks list
      queryClient.setQueryData<Task[]>(['tasks', task.projectId], (old) =>
        old ? old.map((t) => (t.id === task.id ? task : t)) : [task]
      );
      // Also refetch to ensure consistency
      queryClient.invalidateQueries({ queryKey: ['tasks', task.projectId] });
      queryClient.invalidateQueries({ queryKey: ['taskLogs', task.id] });
      queryClient.invalidateQueries({ queryKey: ['taskAttachments', task.id] });
      queryClient.invalidateQueries({ queryKey: ['taskFollowUps', task.id] });
    },
  });
}

/**
 * Queued follow-ups are durable server state, so read them from the API rather
 * than the live stream: the stream is torn down as soon as a task goes terminal,
 * which is exactly when a stranded queue needs to be visible.
 */
export function useTaskFollowUps(taskId: number | null, enabled = true) {
  return useQuery({
    queryKey: ['taskFollowUps', taskId],
    queryFn: () => api.getTaskFollowUps(taskId as number),
    enabled: taskId !== null && enabled,
  });
}

export function useFlushFollowUps() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (taskId: number) => api.flushTaskFollowUps(taskId),
    onSuccess: (_result, taskId) => {
      queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      queryClient.invalidateQueries({ queryKey: ['taskLogs', taskId] });
      queryClient.invalidateQueries({ queryKey: ['taskFollowUps', taskId] });
      queryClient.invalidateQueries({ queryKey: ['taskAttachments', taskId] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useDiscardFollowUps() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (taskId: number) => api.discardTaskFollowUps(taskId),
    onSuccess: (_result, taskId) => {
      queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      queryClient.invalidateQueries({ queryKey: ['taskLogs', taskId] });
      queryClient.invalidateQueries({ queryKey: ['taskFollowUps', taskId] });
    },
  });
}

export function useTaskLogs(taskId: number | null) {
  return useQuery({
    queryKey: ['taskLogs', taskId],
    queryFn: () => api.getTaskLogs(taskId!),
    enabled: !!taskId,
  });
}
