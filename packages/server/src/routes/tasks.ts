import { Router } from 'express';
import * as storage from '../services/storage.js';
import { db } from '../services/database.js';
import { agentPool } from '../services/agentPool.js';
import { broadcast } from '../websocket/index.js';
import { cancelDependentTasks } from '../services/waitingTasks.js';
import { buildTaskAllowedPaths } from '../services/pathValidation.js';
import { errorResponse } from '../utils/errorResponse.js';
import { enqueue, queueSize, clear as clearFollowUpQueue } from '../services/followUpQueue.js';
import { validateRunnerSelection } from '../services/runnerModels.js';
import { taskLogToStreamEvent } from '../services/taskStream.js';
import { getTaskImages, replaceTaskImages, validateTaskImages } from '../services/taskAttachments.js';
import type { Runner, Task } from '../types/index.js';

const router = Router();
const VALID_RUNNERS = new Set<Runner>(['claude', 'claude-grok', 'codex', 'qwen', 'tclaude', 'tcodex']);

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
    const selectedModel = validateRunnerSelection(agent.capabilities, selectedRunner, model);
    if (selectedModel.error) {
      return res.status(400).json({ message: selectedModel.error });
    }

    let validatedImages: string[];
    try {
      validatedImages = validateTaskImages(images).map((image) => image.dataUrl);
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : 'Invalid images' });
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

    // Clear any queued follow-ups
    clearFollowUpQueue(taskId);

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

    // Log the follow-up prompt FIRST so it appears in the timeline
    await storage.appendTaskLog(task.projectId, task.id, {
      type: 'user_message',
      content: effectivePrompt,
    });

    // If task is currently active (running/waiting/etc.), queue instead of dispatching
    const activeStatuses = ['running', 'waiting', 'waiting_permission', 'plan_review'];
    if (activeStatuses.includes(task.status)) {
      enqueue(taskId, effectivePrompt, validatedImages.length > 0 ? validatedImages : undefined, nextRunner, nextModel);
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
    replaceTaskImages(task.id, validatedImages);
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
