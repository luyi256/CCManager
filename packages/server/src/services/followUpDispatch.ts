import { agentPool } from './agentPool.js';
import { getProject, getTaskById, saveTask } from './storage.js';
import { peekAll, recordAttachmentIds, removeByIds } from './followUpQueue.js';
import { buildTaskAllowedPaths } from './pathValidation.js';
import { activateAttachments, listTaskAttachments, replaceTaskImages } from './taskAttachments.js';
import type { QueuedMessage } from './followUpQueue.js';
import type { Runner, Task } from '../types/index.js';

export type BlockedReason = 'no_session' | 'no_project' | 'agent_unavailable' | 'task_active';

const ACTIVE_STATUSES = ['running', 'waiting', 'waiting_permission', 'plan_review'];

/** A task that is mid-run must not be dispatched again. */
export function isTaskActive(status: string): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export type DrainResult =
  | { status: 'empty' }
  | { status: 'dispatched'; count: number; startedAt: string }
  | { status: 'blocked'; reason: BlockedReason; count: number };

/**
 * Session metadata moved from gitInfo onto dedicated columns, so both shapes
 * still exist in the wild. Older rows keep it only in the JSON blob.
 */
export function resolveSession(task: Task): {
  sessionId?: string;
  sessionRunner?: Runner;
} {
  if (task.sessionId) {
    return { sessionId: task.sessionId, sessionRunner: task.sessionRunner };
  }
  if (!task.gitInfo) return {};
  try {
    const gitInfo = JSON.parse(task.gitInfo) as {
      sessionId?: unknown;
      sessionRunner?: unknown;
    };
    return {
      sessionId: typeof gitInfo.sessionId === 'string' ? gitInfo.sessionId : undefined,
      sessionRunner: typeof gitInfo.sessionRunner === 'string'
        ? gitInfo.sessionRunner as Runner
        : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Merge every queued follow-up into one resumed run.
 *
 * Ordering is the whole point: the queue is read but not consumed until the
 * agent has accepted the dispatch. The previous implementation deleted rows
 * first and only then checked for a session id, a project, and a reachable
 * agent — so any of those failing silently destroyed the user's prompts and
 * their uploaded images. On a blocked drain the rows stay put, which means the
 * base64 in task_followups.images is still recoverable via a later flush.
 */
export async function drainFollowUps(taskId: number): Promise<DrainResult> {
  const queued = peekAll(taskId);
  if (queued.length === 0) return { status: 'empty' };

  const task = await getTaskById(taskId);
  if (!task) return { status: 'blocked', reason: 'no_project', count: queued.length };

  // A blocked drain leaves the queue in place, so this can be re-entered while a
  // run is already going (orphan recovery, or a user hitting Resend). Dispatching
  // again would start a second concurrent run on the same session.
  if (isTaskActive(task.status)) {
    return { status: 'blocked', reason: 'task_active', count: queued.length };
  }

  const { sessionId, sessionRunner } = resolveSession(task);
  if (!sessionId) {
    return { status: 'blocked', reason: 'no_session', count: queued.length };
  }

  const project = await getProject(task.projectId);
  if (!project) {
    return { status: 'blocked', reason: 'no_project', count: queued.length };
  }

  const merged = mergeQueued(queued, task);
  let { runner, model } = merged;
  // A resumed session belongs to the coding agent that created it.
  if (sessionRunner && runner !== sessionRunner) {
    console.log(`Task ${taskId}: keeping queued follow-up on original ${sessionRunner} session runner`);
    runner = sessionRunner;
    model = task.model;
  }

  const previousStatus = task.status;
  const previousStartedAt = task.startedAt;
  const previousCompletedAt = task.completedAt;
  const startedAt = new Date().toISOString();
  task.status = 'running';
  task.continuePrompt = merged.prompt;
  task.runner = runner;
  task.model = model;
  task.startedAt = startedAt;
  task.completedAt = undefined;
  task.error = undefined;
  // Queued images were already stored (inactive) against their user_message log,
  // so promote those rows rather than inserting a duplicate generation — a
  // blocked drain can be retried repeatedly and re-inserting would grow the DB
  // without bound. Rows enqueued before log binding existed carry no logId, so
  // store those once and remember the ids on the queue row for later retries.
  const activateIds: number[] = [];
  const stored = listTaskAttachments(task.id);
  for (const message of queued) {
    if (typeof message.logId === 'number') {
      const logId = message.logId;
      activateIds.push(...stored.filter((a) => a.logId === logId).map((a) => a.id));
    } else if (message.attachmentIds?.length) {
      activateIds.push(...message.attachmentIds);
    } else if (message.images?.length) {
      const ids = replaceTaskImages(task.id, message.images, null, { activate: false }).ids;
      recordAttachmentIds(message.id, ids);
      activateIds.push(...ids);
    }
  }
  activateAttachments(task.id, activateIds);
  task.attemptCount = (task.attemptCount || 0) + 1;
  task.lastProgressAt = startedAt;
  await saveTask(task.projectId, task);

  console.log(`Task ${taskId}: Draining ${queued.length} queued follow-up(s), resuming session`);
  const dispatched = agentPool.dispatchTask(project.agentId, {
    taskId: task.id,
    projectId: project.id,
    projectPath: project.projectPath,
    prompt: merged.prompt,
    isPlanMode: task.isPlanMode,
    runner: task.runner,
    model: task.model,
    skipModelValidation: true,
    executor: project.executor,
    dockerImage: project.dockerImage,
    worktreeBranch: task.worktreeBranch,
    continueSession: true,
    sessionId,
    postTaskHook: project.postTaskHook,
    extraMounts: project.extraMounts,
    allowedPaths: buildTaskAllowedPaths(project),
    images: merged.images.length > 0 ? merged.images : undefined,
    startedAt,
    attempt: task.attemptCount,
  });

  if (!dispatched) {
    // Agent went away. Restore the task and leave the queue intact so the user
    // can resend once it reconnects. continuePrompt stays set on purpose: the
    // retry route resumes from it, and clearing it would make Retry re-run the
    // original prompt while silently dropping the follow-up.
    console.warn(`Task ${taskId}: Failed to dispatch queued follow-up (agent unavailable); queue retained`);
    task.status = previousStatus;
    task.startedAt = previousStartedAt;
    task.completedAt = previousCompletedAt;
    await saveTask(task.projectId, task);
    return { status: 'blocked', reason: 'agent_unavailable', count: queued.length };
  }

  removeByIds(queued.map((message) => message.id));
  return { status: 'dispatched', count: queued.length, startedAt };
}

function mergeQueued(queued: QueuedMessage[], task: Task): {
  prompt: string;
  images: string[];
  runner: Runner | undefined;
  model: string | undefined;
} {
  const images: string[] = [];
  let runner = task.runner;
  let model = task.model;
  for (const message of queued) {
    if (message.images) images.push(...message.images);
    if (message.runner) runner = message.runner;
    if (message.model !== undefined) model = message.model;
  }
  return {
    prompt: queued.map((message) => message.prompt).join('\n\n'),
    images,
    runner,
    model,
  };
}
