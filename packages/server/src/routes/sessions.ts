import { Router } from 'express';
import * as storage from '../services/storage.js';
import { agentPool } from '../services/agentPool.js';
import { buildTaskAllowedPaths } from '../services/pathValidation.js';
import { listSessions, getSessionDetail } from '../services/sessionBrowser.js';

const router = Router();

// List all CLI sessions for a project
router.get('/projects/:projectId/sessions', async (req, res) => {
  try {
    const project = await storage.getProject(req.params.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const sessions = await listSessions(project.projectPath, project.id);
    res.json(sessions);
  } catch (error) {
    console.error('Failed to list sessions:', error);
    res.status(500).json({ message: 'Failed to list sessions' });
  }
});

// Get session detail
router.get('/projects/:projectId/sessions/:sessionId', async (req, res) => {
  try {
    const project = await storage.getProject(req.params.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const detail = await getSessionDetail(project.projectPath, req.params.sessionId, project.id);
    if (!detail) {
      return res.status(404).json({ message: 'Session not found' });
    }

    res.json(detail);
  } catch (error) {
    console.error('Failed to get session detail:', error);
    res.status(500).json({ message: 'Failed to get session detail' });
  }
});

// Resume a CLI session as a new task
router.post('/projects/:projectId/sessions/:sessionId/continue', async (req, res) => {
  try {
    const { prompt, images } = req.body;
    if (!prompt && (!images || images.length === 0)) {
      return res.status(400).json({ message: 'Prompt required' });
    }

    const project = await storage.getProject(req.params.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const sessionId = req.params.sessionId;

    // Check agent
    const agent = agentPool.getAgent(project.agentId);
    if (!agent) {
      return res.status(503).json({ message: `Agent ${project.agentId} is not connected` });
    }

    // Create a new task with sessionId pre-set
    const task = await storage.createTask(project.id, {
      projectId: project.id,
      prompt,
      status: 'pending',
      isPlanMode: false,
      createdAt: new Date().toISOString(),
    });

    // Set the sessionId in gitInfo so the agent knows to --resume
    task.gitInfo = JSON.stringify({ sessionId });
    task.status = 'running';
    task.startedAt = new Date().toISOString();
    await storage.saveTask(project.id, task);

    // Dispatch with continueSession
    const dispatched = agentPool.dispatchTask(project.agentId, {
      taskId: task.id,
      projectId: project.id,
      projectPath: project.projectPath,
      prompt,
      isPlanMode: false,
      executor: project.executor,
      dockerImage: project.dockerImage,
      continueSession: true,
      sessionId,
      postTaskHook: project.postTaskHook,
      extraMounts: project.extraMounts,
      allowedPaths: buildTaskAllowedPaths(project),
      images: images as string[] | undefined,
    });

    if (!dispatched) {
      task.status = 'failed';
      task.error = 'Failed to dispatch task to agent';
      await storage.saveTask(project.id, task);
      return res.status(503).json({ message: 'Failed to dispatch task to agent' });
    }

    res.json(task);
  } catch (error) {
    console.error('Failed to continue session:', error);
    res.status(500).json({ message: 'Failed to continue session' });
  }
});

export default router;
