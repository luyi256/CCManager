import { Router, Response } from 'express';
import * as storage from '../services/storage.js';
import { agentPool } from '../services/agentPool.js';
import { broadcast } from '../websocket/index.js';
import type { Task } from '../types/index.js';

const router = Router();

// Helper for consistent error responses with context (Bug #17 fix)
function errorResponse(res: Response, status: number, message: string, details?: Record<string, unknown>) {
  const response: { message: string; details?: Record<string, unknown>; timestamp: string } = {
    message,
    timestamp: new Date().toISOString(),
  };
  if (details) {
    response.details = details;
  }
  return res.status(status).json(response);
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
    res.status(500).json({ message: 'Failed to get task' });
  }
});

// Create task
router.post('/projects/:projectId/tasks', async (req, res) => {
  try {
    const { prompt, isPlanMode, dependsOn } = req.body;
    const projectId = req.params.projectId;

    if (!prompt) {
      return res.status(400).json({ message: 'Prompt is required' });
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
      });

      if (dispatched) {
        task.status = 'running';
        task.startedAt = new Date().toISOString();
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

// Update task
router.put('/tasks/:id', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const task = await storage.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    Object.assign(task, req.body);
    await storage.saveTask(task.projectId, task);
    res.json(task);
  } catch (error) {
    console.error('Failed to update task:', error);
    res.status(500).json({ message: 'Failed to update task' });
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
    await storage.saveTask(task.projectId, task);

    broadcast(taskId, { type: 'task:cancelled', taskId });
    res.json(task);
  } catch (error) {
    console.error('Failed to cancel task:', error);
    res.status(500).json({ message: 'Failed to cancel task' });
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

    // Try to dispatch first, only update status if successful
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
    });

    if (!dispatched) {
      return res.status(503).json({
        message: 'Failed to dispatch task to agent',
      });
    }

    // Reset task only after successful dispatch
    task.status = 'running';
    task.error = undefined;
    task.startedAt = new Date().toISOString();
    task.completedAt = undefined;
    await storage.saveTask(task.projectId, task);

    res.json(task);
  } catch (error) {
    console.error('Failed to retry task:', error);
    res.status(500).json({ message: 'Failed to retry task' });
  }
});

// Continue task (resume session)
router.post('/tasks/:id/continue', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ message: 'Prompt is required' });
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

    // Update task status BEFORE dispatching to avoid race condition
    // where task:completed handler could overwrite with stale data
    const previousStatus = task.status;
    const previousStartedAt = task.startedAt;
    const previousCompletedAt = task.completedAt;
    task.status = 'running';
    task.continuePrompt = prompt;
    task.startedAt = new Date().toISOString();
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
    res.status(500).json({ message: 'Failed to continue task' });
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
    res.status(500).json({ message: 'Failed to send answer' });
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
    res.status(500).json({ message: 'Failed to confirm plan' });
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
    res.status(500).json({ message: 'Failed to merge worktree' });
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
    res.status(500).json({ message: 'Failed to cleanup worktree' });
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
    res.status(500).json({ message: 'Failed to get logs' });
  }
});

export default router;
