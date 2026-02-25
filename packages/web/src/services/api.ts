import type { Project, Task, GlobalConfig, Agent } from '../types';

const API_BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  console.log('request:', options?.method || 'GET', `${API_BASE}${url}`);
  console.log('request body:', options?.body);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${url}`, {
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      ...options,
    });
  } catch (fetchErr) {
    console.error('fetch failed:', fetchErr);
    throw fetchErr;
  }

  console.log('response status:', response.status, response.statusText);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    console.error('request failed:', error);
    throw new Error(error.message || 'Request failed');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

// Projects
export async function getProjects(): Promise<Project[]> {
  return request('/projects');
}

export async function getProject(id: string): Promise<Project> {
  return request(`/projects/${id}`);
}

export async function createProject(data: Omit<Project, 'id' | 'createdAt' | 'taskCount' | 'runningCount'>): Promise<Project> {
  console.log('api.createProject called with:', data);
  console.log('api.createProject - about to call request()');
  try {
    const result = await request<Project>('/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    console.log('api.createProject result:', result);
    return result;
  } catch (err) {
    console.error('api.createProject error:', err);
    throw err;
  }
}

export async function updateProject(id: string, data: Partial<Project>): Promise<Project> {
  return request(`/projects/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteProject(id: string): Promise<void> {
  return request(`/projects/${id}`, {
    method: 'DELETE',
  });
}

// Agents
export async function getAgents(): Promise<Agent[]> {
  return request('/agents');
}

export async function getOnlineAgents(): Promise<Agent[]> {
  return request('/agents/online');
}

// Tasks
export async function getTasks(projectId: string): Promise<Task[]> {
  return request(`/projects/${projectId}/tasks`);
}

export async function getTask(taskId: number): Promise<Task> {
  return request(`/tasks/${taskId}`);
}

export async function createTask(projectId: string, data: {
  prompt: string;
  isPlanMode: boolean;
  dependsOn?: number;
}): Promise<Task> {
  return request(`/projects/${projectId}/tasks`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateTask(taskId: number, data: Partial<Task>): Promise<Task> {
  return request(`/tasks/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function cancelTask(taskId: number): Promise<Task> {
  return request(`/tasks/${taskId}/cancel`, {
    method: 'POST',
  });
}

export async function retryTask(taskId: number): Promise<Task> {
  return request(`/tasks/${taskId}/retry`, {
    method: 'POST',
  });
}

export interface TaskLog {
  timestamp: string;
  type: 'output' | 'tool_use' | 'tool_result' | 'plan_question' | 'permission_request';
  content: unknown;
}

export async function getTaskLogs(taskId: number): Promise<TaskLog[]> {
  return request(`/tasks/${taskId}/logs`);
}

// Plan mode
export async function answerPlanQuestion(taskId: number, answer: string): Promise<void> {
  return request(`/tasks/${taskId}/plan/answer`, {
    method: 'POST',
    body: JSON.stringify({ answer }),
  });
}

export async function confirmPlan(taskId: number): Promise<void> {
  return request(`/tasks/${taskId}/plan/confirm`, {
    method: 'POST',
  });
}

export async function modifyPlan(taskId: number, feedback: string): Promise<void> {
  return request(`/tasks/${taskId}/plan/modify`, {
    method: 'POST',
    body: JSON.stringify({ feedback }),
  });
}

// Settings
export async function getSettings(): Promise<GlobalConfig> {
  return request('/settings');
}

export async function updateSettings(data: Partial<GlobalConfig>): Promise<GlobalConfig> {
  return request('/settings', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function validateAuth(type: 'oauth' | 'apikey', token: string): Promise<{ valid: boolean; error?: string }> {
  return request('/settings/validate-auth', {
    method: 'POST',
    body: JSON.stringify({ type, token }),
  });
}

// Voice transcription
export async function transcribeAudio(audioBlob: Blob, filename = 'recording.webm'): Promise<{ text: string }> {
  const formData = new FormData();
  formData.append('audio', audioBlob, filename);

  const response = await fetch(`${API_BASE}/transcribe`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || 'Transcription failed');
  }

  return response.json();
}
