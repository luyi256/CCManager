import { Router } from 'express';
import * as storage from '../services/storage.js';
import { agentPool } from '../services/agentPool.js';
import { broadcast } from '../websocket/index.js';
import { cancelDependentTasks } from '../services/waitingTasks.js';
import { buildTaskAllowedPaths } from '../services/pathValidation.js';
import { errorResponse } from '../utils/errorResponse.js';
import { enqueue, hasQueued, queueSize, clear as clearFollowUpQueue } from '../services/followUpQueue.js';
import type { Task } from '../types/index.js';

const router = Router();

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
    const { prompt, isPlanMode, dependsOn, images } = req.body;
    const projectId = req.params.projectId;

    if (!prompt && (!images || images.length === 0)) {
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

    const task = await storage.createTask(projectId, {
      projectId,
      prompt,
      status: 'pending',
      isPlanMode: isPlanMode || false,
      dependsOn,
      createdAt: new Date().toISOString(),
    });

    // If project has worktree enabled, set the branch name
    if (project.enableWorktree) {
      task.worktreeBranch = `ccm-task-${task.id}`;
      await storage.saveTask(projectId, task);
    }

    // Start execution if no dependencies
    if (!dependsOn) {
      // Try to dispatch first, only update status if successful
      const startedAt = new Date().toISOString();
      const dispatched = agentPool.dispatchTask(project.agentId, {
        taskId: task.id,
        projectId: project.id,
        projectPath: project.projectPath,
        prompt: task.prompt,
        isPlanMode: task.isPlanMode,
        executor: project.executor,
        dockerImage: project.dockerImage,
        worktreeBranch: task.worktreeBranch,
        postTaskHook: project.postTaskHook,
        extraMounts: project.extraMounts,
        allowedPaths: buildTaskAllowedPaths(project),
        images: images as string[] | undefined,
        startedAt,
      });

      if (dispatched) {
        task.status = 'running';
        task.startedAt = startedAt;
      } else {
        task.status = 'failed';
        task.error = 'Failed to dispatch task to agent';
      }
      await storage.saveTask(projectId, task);
    }

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
    if (task.continuePrompt && task.gitInfo) {
      try {
        const gitInfo = JSON.parse(task.gitInfo);
        if (gitInfo.sessionId) {
          prompt = task.continuePrompt;
          continueSession = true;
          sessionId = gitInfo.sessionId;
        }
      } catch { /* ignore parse errors */ }
    }

    // Try to dispatch first, only update status if successful
    const startedAt = new Date().toISOString();
    const dispatched = agentPool.dispatchTask(project.agentId, {
      taskId: task.id,
      projectId: project.id,
      projectPath: project.projectPath,
      prompt,
      isPlanMode: task.isPlanMode,
      executor: project.executor,
      dockerImage: project.dockerImage,
      worktreeBranch: task.worktreeBranch,
      continueSession,
      sessionId,
      isRetry: true,
      postTaskHook: project.postTaskHook,
      extraMounts: project.extraMounts,
      allowedPaths: project.allowedPaths,
      startedAt,
    });

    if (!dispatched) {
      return res.status(503).json({
        message: 'Failed to dispatch task to agent',
      });
    }

    // Reset task only after successful dispatch
    task.status = 'running';
    task.error = undefined;
    task.startedAt = startedAt;
    task.completedAt = undefined;
    // Clear stale continuePrompt so future retries don't try to resume old follow-ups
    if (!continueSession) {
      task.continuePrompt = undefined;
    }
    await storage.saveTask(task.projectId, task);

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
    const { prompt, images } = req.body;

    if (!prompt && (!images || images.length === 0)) {
      return res.status(400).json({ message: 'Prompt or images required' });
    }

    const task = await storage.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const project = await storage.getProject(task.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    // Get session ID from gitInfo
    let sessionId: string | undefined;
    if (task.gitInfo) {
      try {
        const gitInfo = JSON.parse(task.gitInfo);
        sessionId = gitInfo.sessionId;
      } catch {
        // Ignore parse errors
      }
    }

    if (!sessionId) {
      return res.status(400).json({ message: 'No session ID found for this task' });
    }

    // Check if agent is connected
    const agent = agentPool.getAgent(project.agentId);
    if (!agent) {
      return res.status(503).json({
        message: `Agent ${project.agentId} is not connected`,
      });
    }

    // Log the follow-up prompt FIRST so it appears in the timeline
    await storage.appendTaskLog(task.projectId, task.id, {
      type: 'user_message',
      content: prompt,
    });

    // If task is currently active (running/waiting/etc.), queue instead of dispatching
    const activeStatuses = ['running', 'waiting', 'waiting_permission', 'plan_review'];
    if (activeStatuses.includes(task.status)) {
      enqueue(taskId, prompt, images as string[] | undefined);
      const queued = queueSize(taskId);
      console.log(`Task ${taskId}: Follow-up queued (${queued} pending), will merge when current execution finishes`);
      // Broadcast queue info to frontend
      broadcast(taskId, { type: 'task:followup_queued', taskId, queueSize: queued, prompt });
      return res.json({ ...task, followUpQueued: true, queueSize: queued });
    }

    // Task is completed/failed — dispatch immediately as a continue session
    // Update task status BEFORE dispatching to avoid race condition
    // where task:completed handler could overwrite with stale data
    const previousStatus = task.status;
    const previousStartedAt = task.startedAt;
    const previousCompletedAt = task.completedAt;
    const startedAt = new Date().toISOString();
    task.status = 'running';
    task.continuePrompt = prompt;
    task.startedAt = startedAt;
    task.completedAt = undefined;
    task.error = undefined;
    await storage.saveTask(task.projectId, task);

    // Dispatch task with continue session (after DB is updated)
    const dispatched = agentPool.dispatchTask(project.agentId, {
      taskId: task.id,
      projectId: project.id,
      projectPath: project.projectPath,
      prompt: prompt,
      isPlanMode: task.isPlanMode,
      executor: project.executor,
      dockerImage: project.dockerImage,
      worktreeBranch: task.worktreeBranch,
      continueSession: true,
      sessionId: sessionId,
      postTaskHook: project.postTaskHook,
      extraMounts: project.extraMounts,
      allowedPaths: project.allowedPaths,
      images: images as string[] | undefined,
      startedAt,
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
