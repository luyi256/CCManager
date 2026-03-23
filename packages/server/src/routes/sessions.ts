import { Router } from 'express';
import * as storage from '../services/storage.js';
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

export default router;
