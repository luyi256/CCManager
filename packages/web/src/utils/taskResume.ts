import type { Task } from '../types';

const ACTIVE_STATUSES = ['running', 'waiting', 'waiting_permission', 'plan_review'] as const;
const RESUMABLE_DONE_STATUSES = ['completed', 'completed_with_warnings', 'failed', 'cancelled'] as const;

export function isTaskActive(status: Task['status']): boolean {
  return ACTIVE_STATUSES.includes(status as (typeof ACTIVE_STATUSES)[number]);
}

export function hasResumeSession(task: Pick<Task, 'gitInfo'>): boolean {
  if (!task.gitInfo) return false;
  try {
    return Boolean(JSON.parse(task.gitInfo).sessionId);
  } catch {
    return false;
  }
}

export function canSendFollowUpForTask(task: Pick<Task, 'status' | 'gitInfo'>): boolean {
  if (isTaskActive(task.status)) return true;
  return RESUMABLE_DONE_STATUSES.includes(task.status as (typeof RESUMABLE_DONE_STATUSES)[number]);
}
