import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as api from '../services/api';
import type { Project } from '../types';

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: api.getProjects,
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: ['project', id],
    queryFn: () => api.getProject(id),
    enabled: !!id,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Omit<Project, 'id' | 'createdAt' | 'taskCount' | 'runningCount'>) => {
      console.log('useCreateProject mutationFn called with:', data);
      return api.createProject(data);
    },
    onSuccess: (result) => {
      console.log('useCreateProject onSuccess:', result);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error) => {
      console.error('useCreateProject onError:', error);
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Project> }) =>
      api.updateProject(id, data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', id] });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.deleteProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: api.getAgents,
  });
}
