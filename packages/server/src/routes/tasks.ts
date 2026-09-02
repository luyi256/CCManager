import { Router } from 'express';
import * as storage from '../services/storage.js';
import { db } from '../services/database.js';
import { agentPool } from '../services/agentPool.js';
import { broadcast } from '../websocket/index.js';
import { cancelDependentTasks } from '../services/waitingTasks.js';
import { buildTaskAllowedPaths } from '../services/pathValidation.js';
import { errorResponse } from '../utils/errorResponse.js';
import { enqueue, queueSize, hasQueued, peekAll, clear as clearFollowUpQueue } from '../services/followUpQueue.js';
import { drainFollowUps, isTaskActive } from '../services/followUpDispatch.js';
import { validateRunnerSelection } from '../services/runnerModels.js';
import { taskLogToStreamEvent } from '../services/taskStream.js';
import { bindAttachmentsToLog, getTaskImages, replaceTaskImages, validateTaskImages, listTaskAttachments, getAttachmentForTask, type AttachmentMeta } from '../services/taskAttachments.js';
import type { Runner, Task } from '../types/index.js';

const router = Router();
const VALID_RUNNERS = new Set<Runner>(['claude', 'claude-grok', 'codex', 'qwen', 'tclaude', 'tcodex']);
const FOLLOWUP_BLOCKED_MESSAGES: Record<string, string> = {
  no_session: 'This task has no session to resume yet. Wait for it to start, then try again.',
  no_project: 'The project for this task is no longer available.',
  agent_unavailable: 'The agent is not reachable. Reconnect it, then try again.',
  task_active: 'This task is already running. These messages will be sent when it finishes.',
};

async function broadcastStreamPhase(
  task: Task,
  phase: 'starting' | 'cancelled'
): Promise<void> {
  const log = await storage.appendTaskLog(task.projectId, task.id, {
    type: 'stream_phase',
    content: { phase, runId: task.startedAt },
  });
  const event = taskLogToStreamEvent(task.id, log, task.startedAt);
  if (event) broadcast(task.id, { type: 'task:stream', ...event });
}

function parseRunner(value: unknown): Runner | undefined {
  return typeof value === 'string' && VALID_RUNNERS.has(value as Runner)
    ? value as Runner
    : undefined;
}

// Get tasks for project
router.get('/projects/:projectId/tasks', async (req, res) => {
  try {
    const tasks = await storage.getTasks(req.params.projectId);
    res.json(tasks);
  } catch (error) {
    console.error('Failed to get tasks:', error);
    return errorResponse(res, 500, 'Failed to get tasks', {
      projectId: req.params.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Get single task
router.get('/tasks/:id', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const task = await storage.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    res.json(task);
  } catch (error) {
    console.error('Failed to get task:', error);
    errorResponse(res, 500, 'Failed to get task');
  }
});

// Create task
router.post('/projects/:projectId/tasks', async (req, res) => {
  try {
    const { prompt, isPlanMode, runner, model, dependsOn, images } = req.body;
    const normalizedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    const selectedRunner = parseRunner(runner) ?? 'claude';
    const projectId = req.params.projectId;

    if (!normalizedPrompt && (!images || images.length === 0)) {
      return res.status(400).json({ message: 'Prompt or images required' });
    }

    const project = await storage.getProject(projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    // Check if agent is available
    const agent = agentPool.getAgent(project.agentId);
    if (!agent) {
      return res.status(503).json({
        message: `Agent ${project.agentId} is not connected. Please ensure the agent is running.`,
      });
    }
    // Validate the user's own input (images) before environmental checks
    // (model availability), so the actionable error surfaces first.
    let validatedImages: string[];
    try {
      validatedImages = validateTaskImages(images).map((image) => image.dataUrl);
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : 'Invalid images' });
    }
    const selectedModel = validateRunnerSelection(agent.capabilities, selectedRunner, model);
    if (selectedModel.error) {
      return res.status(400).json({ message: selectedModel.error });
    }

    const effectivePrompt = normalizedPrompt ||
      `Please analyze the ${validatedImages.length} attached image${validatedImages.length === 1 ? '' : 's'}.`;

    const task = await storage.createTask(projectId, {
      projectId,
      prompt: effectivePrompt,
      status: 'pending',
      isPlanMode: isPlanMode || false,
      runner: selectedRunner,
      model: selectedModel.model,
      dependsOn,
      createdAt: new Date().toISOString(),
    });
    if (validatedImages.length > 0) replaceTaskImages(task.id, validatedImages);

    // If project has worktree enabled, set the branch name
    if (project.enableWorktree) {
      task.worktreeBranch = `ccm-task-${task.id}`;
      await storage.saveTask(projectId, task);
    }

    // Start execution if no dependencies
    if (!dependsOn) {
      const startedAt = new Date().toISOString();
      task.attemptCount = (task.attemptCount || 0) + 1;
      task.lastProgressAt = startedAt;
      task.status = 'running';
      task.startedAt = startedAt;
      await storage.saveTask(projectId, task);
      const dispatched = agentPool.dispatchTask(project.agentId, {
        taskId: task.id,
        projectId: project.id,
        projectPath: project.projectPath,
        prompt: task.prompt,
        isPlanMode: task.isPlanMode,
        runner: task.runner,
        model: task.model,
        executor: project.executor,
        dockerImage: project.dockerImage,
        worktreeBranch: task.worktreeBranch,
        postTaskHook: project.postTaskHook,
        extraMounts: project.extraMounts,
        allowedPaths: buildTaskAllowedPaths(project),
        images: validatedImages.length > 0 ? validatedImages : undefined,
        startedAt,
        attempt: task.attemptCount,
      });

      if (dispatched) {
        // The task was persisted before dispatch so early session events cannot
        // race with this request and be overwritten.
      } else {
        task.status = 'failed';
        task.error = 'Failed to dispatch task to agent';
        task.completedAt = new Date().toISOString();
        await storage.saveTask(projectId, task);
      }
      if (dispatched) await broadcastStreamPhase(task, 'starting');
    }

    // Keep the remembered model aligned with the most recent runner selection.
    db.prepare(`UPDATE projects SET last_model = ? WHERE id = ?`).run(selectedModel.model || null, projectId);

    res.status(201).json(task);
  } catch (error) {
    console.error('Failed to create task:', error);
    return errorResponse(res, 500, 'Failed to create task', {
      projectId: req.params.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Update task (whitelist allowed fields)
const TASK_UPDATABLE_FIELDS = new Set([
  'status', 'error', 'summary', 'waitingUntil', 'waitReason',
  'checkCommand', 'continuePrompt', 'isPlanMode',
]);

router.put('/tasks/:id', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const task = await storage.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    for (const [key, value] of Object.entries(req.body)) {
      if (TASK_UPDATABLE_FIELDS.has(key)) {
        (task as unknown as Record<string, unknown>)[key] = value;
      }
    }
    await storage.saveTask(task.projectId, task);
    res.json(task);
  } catch (error) {
    console.error('Failed to update task:', error);
    errorResponse(res, 500, 'Failed to update task');
  }
});

// Cancel task
router.post('/tasks/:id/cancel', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const task = await storage.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const project = await storage.getProject(task.projectId);
    if (project) {
      agentPool.cancelTask(project.agentId, taskId);
    }

    task.status = 'cancelled';
    task.completedAt = new Date().toISOString();
    // Keep continuePrompt so retry can re-send the follow-up message.
    // Previously we cleared it, but that caused retry to fall back to the
    // original prompt (whose work is already done), making it appear to "not run".
    await storage.saveTask(task.projectId, task);
    await broadcastStreamPhase(task, 'cancelled');

    // Keep queued follow-ups for the same reason continuePrompt is preserved
    // above: silently dropping the user's queued messages (and their images) is
    // worse than leaving them visible to resend or discard explicitly.
    if (hasQueued(taskId)) {
      broadcast(taskId, {
        type: 'task:followup_pending',
        taskId,
        queueSize: queueSize(taskId),
        reason: 'task_cancelled',
      });
    }

    broadcast(taskId, { type: 'task:cancelled', taskId });

    // Cascade cancel any pending tasks that depend on this one
    await cancelDependentTasks(taskId);

    res.json(task);
  } catch (error) {
    console.error('Failed to cancel task:', error);
    errorResponse(res, 500, 'Failed to cancel task');
  }
});

// Retry task
router.post('/tasks/:id/retry', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const task = await storage.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const project = await storage.getProject(task.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    // Check if dependency task is completed (Bug #7 fix)
    if (task.dependsOn) {
      const dependencyTask = await storage.getTaskById(task.dependsOn);
      if (!dependencyTask) {
        return res.status(400).json({
          message: `Dependency task ${task.dependsOn} not found`,
        });
      }
      if (dependencyTask.status !== 'completed' && dependencyTask.status !== 'completed_with_warnings') {
        return res.status(400).json({
          message: `Cannot retry: dependency task ${task.dependsOn} is not completed (status: ${dependencyTask.status})`,
        });
      }
    }

    // Check if agent is connected
    const agent = agentPool.getAgent(project.agentId);
    if (!agent) {
      return res.status(503).json({
        message: `Agent ${project.agentId} is not connected`,
      });
    }

    // Determine whether to resume session or start fresh
    let prompt = task.prompt;
    let continueSession = false;
    let sessionId: string | undefined;

    // Resume session if we have a continuePrompt (follow-up) and sessionId,
    // regardless of whether the task was cancelled or failed.
    // For cancelled tasks, the session might already contain the follow-up prompt
    // (slight risk of duplicate), but losing the user's follow-up message entirely
    // is a much worse experience than a potential duplicate.
    sessionId = task.sessionId;
    if (sessionId) {
      prompt = task.continuePrompt || 'Continue the interrupted task from where you left off and finish it.';
      continueSession = true;
    } else if (task.continuePrompt && task.gitInfo) {
      try {
        const gitInfo = JSON.parse(task.gitInfo);
        if (gitInfo.sessionId) {
          prompt = task.continuePrompt;
          continueSession = true;
          sessionId = gitInfo.sessionId;
        }
      } catch { /* ignore parse errors */ }
    }

    const previousStatus = task.status;
    const previousStartedAt = task.startedAt;
    const previousCompletedAt = task.completedAt;
    const startedAt = new Date().toISOString();
    task.attemptCount = (task.attemptCount || 0) + 1;
    task.lastProgressAt = startedAt;
    task.status = 'running';
    task.error = undefined;
    task.startedAt = startedAt;
    task.completedAt = undefined;
    if (!continueSession) task.continuePrompt = undefined;
    await storage.saveTask(task.projectId, task);
    const dispatched = agentPool.dispatchTask(project.agentId, {
      taskId: task.id,
      projectId: project.id,
      projectPath: project.projectPath,
      prompt,
      isPlanMode: task.isPlanMode,
      runner: task.runner,
      model: task.model,
      skipModelValidation: true,
      executor: project.executor,
      dockerImage: project.dockerImage,
      worktreeBranch: task.worktreeBranch,
      continueSession,
      sessionId,
      isRetry: true,
      postTaskHook: project.postTaskHook,
      extraMounts: project.extraMounts,
      allowedPaths: buildTaskAllowedPaths(project),
      images: getTaskImages(task.id),
      startedAt,
      attempt: task.attemptCount,
    });

    if (!dispatched) {
      task.status = previousStatus;
      task.startedAt = previousStartedAt;
      task.completedAt = previousCompletedAt;
      await storage.saveTask(task.projectId, task);
      return res.status(503).json({
        message: 'Failed to dispatch task to agent',
      });
    }

    await broadcastStreamPhase(task, 'starting');

    res.json(task);
  } catch (error) {
    console.error('Failed to retry task:', error);
    errorResponse(res, 500, 'Failed to retry task');
  }
});

// Continue task (resume session)
router.post('/tasks/:id/continue', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const { prompt, images, runner, model } = req.body;
    const normalizedPrompt = typeof prompt === 'string' ? prompt.trim() : '';

    if (!normalizedPrompt && (!images || images.length === 0)) {
      return res.status(400).json({ message: 'Prompt or images required' });
    }

    let validatedImages: string[];
    try {
      validatedImages = validateTaskImages(images).map((image) => image.dataUrl);
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : 'Invalid images' });
    }
    const effectivePrompt = normalizedPrompt ||
      `Please analyze the ${validatedImages.length} attached image${validatedImages.length === 1 ? '' : 's'}.`;

    const task = await storage.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const project = await storage.getProject(task.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    // Check if agent is connected
    const agent = agentPool.getAgent(project.agentId);
    if (!agent) {
      return res.status(503).json({
        message: `Agent ${project.agentId} is not connected`,
      });
    }
    let sessionRunner: Runner | undefined;
    sessionRunner = task.sessionRunner;
    let sessionId: string | undefined = task.sessionId;
    if (!sessionId && task.gitInfo) {
      try {
        const gitInfo = JSON.parse(task.gitInfo);
        sessionId = typeof gitInfo.sessionId === 'string' ? gitInfo.sessionId : undefined;
        sessionRunner = parseRunner(gitInfo.sessionRunner);
      } catch {
        // Ignore malformed legacy metadata.
      }
    }
    const nextRunner = sessionRunner ?? parseRunner(runner) ?? task.runner ?? 'claude';
    const modelWasProvided = Object.prototype.hasOwnProperty.call(req.body, 'model');
    const selectedModel = validateRunnerSelection(agent.capabilities, nextRunner, model);
    if (selectedModel.error) {
      return res.status(400).json({ message: selectedModel.error });
    }
    const runnerChanged = nextRunner !== (task.runner ?? 'claude');
    let nextModel = modelWasProvided
      ? selectedModel.model
      : runnerChanged ? undefined : task.model;

    // If task is currently active (running/waiting/etc.), queue instead of dispatching
    const isQueued = isTaskActive(task.status);

    // Persist attachments before the log row so their ids can be recorded on it.
    // Queued images land inactive so the in-flight run keeps its own image set;
    // drainFollowUps activates them at dispatch time.
    const stored = replaceTaskImages(task.id, validatedImages, null, { activate: !isQueued });

    // Log the follow-up prompt FIRST so it appears in the timeline
    const userLog = await storage.appendTaskLog(task.projectId, task.id, {
      type: 'user_message',
      content: { text: effectivePrompt, attachmentIds: stored.ids },
    });
    bindAttachmentsToLog(stored.ids, userLog.id);

    if (isQueued) {
      enqueue(taskId, effectivePrompt, validatedImages.length > 0 ? validatedImages : undefined, nextRunner, nextModel, userLog.id);
      const queued = queueSize(taskId);
      console.log(`Task ${taskId}: Follow-up queued (${queued} pending), will merge when current execution finishes`);
      // Broadcast queue info to frontend
      broadcast(taskId, { type: 'task:followup_queued', taskId, queueSize: queued, prompt });
      return res.json({ ...task, followUpQueued: true, queueSize: queued });
    }

    // Get session ID from gitInfo. Active tasks can accept queued follow-ups before
    // the session ID is available; completed tasks need it to resume immediately.
    if (!sessionId) {
      return res.status(400).json({ message: 'No session ID found for this task' });
    }
    // Historical rows created before runner-aware session metadata were
    // introduced still bind to the task's original runner.
    const boundRunner = sessionRunner ?? task.runner ?? 'claude';
    if (nextRunner !== boundRunner) {
      return res.status(400).json({
        message: `This session belongs to ${boundRunner}. Resume it with the same coding agent.`,
      });
    }
    if (modelWasProvided && !nextModel) nextModel = task.model;

    // Task is completed/failed — dispatch immediately as a continue session
    // Update task status BEFORE dispatching to avoid race condition
    // where task:completed handler could overwrite with stale data
    const previousStatus = task.status;
    const previousStartedAt = task.startedAt;
    const previousCompletedAt = task.completedAt;
    const startedAt = new Date().toISOString();
    task.status = 'running';
    task.continuePrompt = effectivePrompt;
    task.runner = nextRunner;
    task.model = nextModel;
    task.startedAt = startedAt;
    task.completedAt = undefined;
    task.error = undefined;
    task.attemptCount = (task.attemptCount || 0) + 1;
    task.lastProgressAt = startedAt;
    await storage.saveTask(task.projectId, task);

    // Dispatch task with continue session (after DB is updated)
    const dispatched = agentPool.dispatchTask(project.agentId, {
      taskId: task.id,
      projectId: project.id,
      projectPath: project.projectPath,
      prompt: effectivePrompt,
      isPlanMode: task.isPlanMode,
      runner: task.runner,
      model: task.model,
      executor: project.executor,
      dockerImage: project.dockerImage,
      worktreeBranch: task.worktreeBranch,
      continueSession: true,
      sessionId: sessionId,
      postTaskHook: project.postTaskHook,
      extraMounts: project.extraMounts,
      allowedPaths: buildTaskAllowedPaths(project),
      images: validatedImages.length > 0 ? validatedImages : undefined,
      startedAt,
      attempt: task.attemptCount,
    });

    if (!dispatched) {
      // Revert task status on dispatch failure
      task.status = previousStatus as Task['status'];
      task.startedAt = previousStartedAt;
      task.completedAt = previousCompletedAt;
      await storage.saveTask(task.projectId, task);
      return res.status(503).json({
        message: 'Failed to dispatch task to agent',
      });
    }

    await broadcastStreamPhase(task, 'starting');
    res.json(task);
  } catch (error) {
    console.error('Failed to continue task:', error);
    errorResponse(res, 500, 'Failed to continue task');
  }
});

// Plan mode: answer question
router.post('/tasks/:id/plan/answer', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const { answer } = req.body;

    const task = await storage.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const project = await storage.getProject(task.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    agentPool.sendInput(project.agentId, taskId, answer);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to answer:', error);
    errorResponse(res, 500, 'Failed to send answer');
  }
});

// Plan mode: confirm
router.post('/tasks/:id/plan/confirm', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);

    const task = await storage.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const project = await storage.getProject(task.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    agentPool.sendInput(project.agentId, taskId, 'y');
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to confirm:', error);
    errorResponse(res, 500, 'Failed to confirm plan');
  }
});

// Merge worktree branch
router.post('/tasks/:id/merge', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const { deleteBranch } = req.body;

    const task = await storage.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (!task.worktreeBranch) {
      return res.status(400).json({ message: 'Task has no worktree branch' });
    }

    const project = await storage.getProject(task.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const dispatched = agentPool.mergeWorktree(project.agentId, {
      taskId: task.id,
      projectPath: project.projectPath,
      branch: task.worktreeBranch,
      deleteBranch: deleteBranch || false,
    });

    if (!dispatched) {
      return res.status(503).json({ message: 'Agent not available for merge operation' });
    }

    res.json({ message: 'Merge request sent to agent' });
  } catch (error) {
    console.error('Failed to merge worktree:', error);
    errorResponse(res, 500, 'Failed to merge worktree');
  }
});

// Cleanup worktree
router.post('/tasks/:id/cleanup-worktree', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);

    const task = await storage.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (!task.worktreeBranch) {
      return res.status(400).json({ message: 'Task has no worktree branch' });
    }

    const project = await storage.getProject(task.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const dispatched = agentPool.cleanupWorktree(project.agentId, {
      taskId: task.id,
      projectPath: project.projectPath,
      branch: task.worktreeBranch,
    });

    if (!dispatched) {
      return res.status(503).json({ message: 'Agent not available for cleanup operation' });
    }

    res.json({ message: 'Cleanup request sent to agent' });
  } catch (error) {
    console.error('Failed to cleanup worktree:', error);
    errorResponse(res, 500, 'Failed to cleanup worktree');
  }
});

// Inspect queued follow-ups. Never returns base64 image payloads — only counts.
router.get('/tasks/:id/followups', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const task = await storage.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const items = peekAll(taskId).map((message) => ({
      id: message.id,
      prompt: message.prompt,
      imageCount: message.images?.length ?? 0,
      runner: message.runner,
      model: message.model,
    }));
    res.json({ queueSize: items.length, items });
  } catch (error) {
    console.error('Failed to get queued follow-ups:', error);
    errorResponse(res, 500, 'Failed to get queued follow-ups');
  }
});

// Retry a drain that was blocked (agent had gone away, session not yet known).
router.post('/tasks/:id/followups/flush', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const task = await storage.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const result = await drainFollowUps(taskId);
    if (result.status === 'empty') return res.status(204).end();
    if (result.status === 'blocked') {
      return res.status(409).json({
        message: FOLLOWUP_BLOCKED_MESSAGES[result.reason],
        reason: result.reason,
        queueSize: result.count,
      });
    }

    await broadcastStreamPhase({ ...task, startedAt: result.startedAt }, 'starting');
    broadcast(taskId, { type: 'task:status', taskId, status: 'running' });
    res.json({ dispatched: result.count });
  } catch (error) {
    console.error('Failed to flush queued follow-ups:', error);
    errorResponse(res, 500, 'Failed to flush queued follow-ups');
  }
});

// Explicit user discard — the only path that may drop queued messages.
router.delete('/tasks/:id/followups', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const task = await storage.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const discarded = queueSize(taskId);
    clearFollowUpQueue(taskId);
    broadcast(taskId, { type: 'task:followup_queued', taskId, queueSize: 0 });
    res.json({ discarded });
  } catch (error) {
    console.error('Failed to discard queued follow-ups:', error);
    errorResponse(res, 500, 'Failed to discard queued follow-ups');
  }
});

// Attachment metadata for the timeline. Grouped so each user_message can render
// its own thumbnails; log_id NULL means the task's initial prompt.
router.get('/tasks/:id/attachments', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const task = await storage.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const initial: AttachmentMeta[] = [];
    const byLogId: Record<string, AttachmentMeta[]> = {};
    for (const attachment of listTaskAttachments(taskId)) {
      if (attachment.logId === null) initial.push(attachment);
      else (byLogId[String(attachment.logId)] ||= []).push(attachment);
    }
    res.json({ initial, byLogId });
  } catch (error) {
    console.error('Failed to list attachments:', error);
    errorResponse(res, 500, 'Failed to list attachments');
  }
});

// Serve the image bytes. Scoping the path by task id gives ownership validation
// for free. Auth is device-level (any valid device already sees every project
// via GET /projects), so apiAuthMiddleware is the whole access check here.
router.get('/tasks/:id/attachments/:attachmentId', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const attachmentId = parseInt(req.params.attachmentId, 10);
    if (!Number.isInteger(taskId) || !Number.isInteger(attachmentId)) {
      return res.status(400).json({ message: 'Invalid attachment reference' });
    }

    const attachment = getAttachmentForTask(taskId, attachmentId);
    if (!attachment) {
      return res.status(404).json({ message: 'Attachment not found' });
    }

    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', attachment.buffer.length);
    // Attachment bytes never change once stored.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.end(attachment.buffer);
  } catch (error) {
    console.error('Failed to read attachment:', error);
    errorResponse(res, 500, 'Failed to read attachment');
  }
});

// Get task logs
router.get('/tasks/:id/logs', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const task = await storage.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const logs = await storage.getTaskLogs(task.projectId, taskId);
    res.json(logs);
  } catch (error) {
    console.error('Failed to get logs:', error);
    errorResponse(res, 500, 'Failed to get logs');
  }
});

export default router;
