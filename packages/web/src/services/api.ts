import type { Project, Task, GlobalConfig, Agent } from '../types';
import { getApiToken, clearApiToken } from './auth';

const API_BASE = '/api';

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1s

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryable(status: number): boolean {
  return status >= 500 && status < 600;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
      await sleep(delay);
    }

    let response: Response;
    try {
      const token = getApiToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      response = await fetch(`${API_BASE}${url}`, {
        headers: {
          ...headers,
          ...options?.headers,
        },
        ...options,
      });
    } catch (fetchErr) {
      lastError = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));
      // Network errors are retryable
      if (attempt < MAX_RETRIES) continue;
      throw lastError;
    }

    if (response.ok) {
      if (response.status === 204) {
        return undefined as T;
      }
      return response.json();
    }

    const error = await response.json().catch(() => ({ message: response.statusText }));
    lastError = new Error(error.message || 'Request failed');

    // Auth failure — clear token and reload to show login page
    if (response.status === 401 || response.status === 403) {
      clearApiToken();
      window.location.reload();
      throw lastError;
    }

    if (isRetryable(response.status) && attempt < MAX_RETRIES) {
      continue;
    }

    throw lastError;
  }

  throw lastError || new Error('Request failed after retries');
}

// Projects
export async function getProjects(): Promise<Project[]> {
  return request('/projects');
}

export async function getProject(id: string): Promise<Project> {
  return request(`/projects/${id}`);
}

export async function createProject(data: Omit<Project, 'id' | 'createdAt' | 'taskCount' | 'runningCount'>): Promise<Project> {
  return request<Project>('/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  });
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
  images?: string[];
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

export async function continueTask(taskId: number, prompt: string, images?: string[]): Promise<Task> {
  return request(`/tasks/${taskId}/continue`, {
    method: 'POST',
    body: JSON.stringify({ prompt, images }),
  });
}

export async function mergeTask(taskId: number, deleteBranch = false): Promise<{ message: string }> {
  return request(`/tasks/${taskId}/merge`, {
    method: 'POST',
    body: JSON.stringify({ deleteBranch }),
  });
}

export async function cleanupWorktree(taskId: number): Promise<{ message: string }> {
  return request(`/tasks/${taskId}/cleanup-worktree`, {
    method: 'POST',
  });
}

export interface TaskLog {
  timestamp: string;
  type: 'output' | 'tool_use' | 'tool_result' | 'plan_question' | 'permission_request' | 'user_message';
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

// Device management
export interface DeviceInfo {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function getCurrentDevice(): Promise<DeviceInfo> {
  return request('/auth/me');
}

export async function getDeviceTokens(): Promise<DeviceInfo[]> {
  return request('/auth/devices');
}

export async function createDeviceToken(name: string): Promise<{ id: number; name: string; token: string }> {
  return request('/auth/devices', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function revokeDeviceToken(id: number): Promise<void> {
  return request(`/auth/devices/${id}`, { method: 'DELETE' });
}

// Agent token management
export interface AgentTokenInfo {
  agentId: string;
  hasToken: boolean;
  createdAt?: string;
  lastUsedAt?: string | null;
}

export async function registerAgent(agentId: string, agentName?: string): Promise<{ agentId: string; agentName: string; token: string }> {
  return request('/agents/register', {
    method: 'POST',
    body: JSON.stringify({ agentId, agentName }),
  });
}

export async function generateAgentToken(agentId: string): Promise<{ agentId: string; token: string }> {
  return request(`/agents/${agentId}/token`, {
    method: 'POST',
  });
}

export async function getAgentTokenInfo(agentId: string): Promise<AgentTokenInfo> {
  return request(`/agents/${agentId}/token`);
}

export async function revokeAgentToken(agentId: string): Promise<void> {
  return request(`/agents/${agentId}/token`, {
    method: 'DELETE',
  });
}

// Voice transcription
export async function transcribeAudio(audioBlob: Blob, filename = 'recording.webm'): Promise<{ text: string }> {
  const formData = new FormData();
  formData.append('audio', audioBlob, filename);

  const headers: Record<string, string> = {};
  const token = getApiToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}/transcribe`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || 'Transcription failed');
  }

  return response.json();
}
