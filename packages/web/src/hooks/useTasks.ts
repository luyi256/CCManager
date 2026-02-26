import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as api from '../services/api';
import type { Task } from '../types';

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
  });
}

export function useCreateTask(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { prompt: string; isPlanMode: boolean; dependsOn?: number }) =>
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
    mutationFn: ({ taskId, prompt }: { taskId: number; prompt: string }) =>
      api.continueTask(taskId, prompt),
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', task.projectId] });
      queryClient.invalidateQueries({ queryKey: ['task', task.id] });
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
