import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as storage from '../services/storage.js';
import { agentPool } from '../services/agentPool.js';
import type { Project } from '../types/index.js';

const router = Router();

// Get all projects
router.get('/', async (req, res) => {
  try {
    const projects = await storage.getProjects();
    res.json(projects);
  } catch (error) {
    console.error('Failed to get projects:', error);
    res.status(500).json({ message: 'Failed to get projects' });
  }
});

// Get single project
router.get('/:id', async (req, res) => {
  try {
    const project = await storage.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }
    res.json(project);
  } catch (error) {
    console.error('Failed to get project:', error);
    res.status(500).json({ message: 'Failed to get project' });
  }
});

// Create project
router.post('/', async (req, res) => {
  console.log('POST /api/projects - body:', JSON.stringify(req.body));
  try {
    const { name, agentId, projectPath, securityMode, executor, dockerImage, postTaskHook, extraMounts, enableWorktree } = req.body;

    if (!name || !agentId || !projectPath) {
      return res.status(400).json({ message: 'Missing required fields: name, agentId, projectPath' });
    }

    const project: Omit<Project, 'taskCount' | 'runningCount'> = {
      id: uuidv4(),
      name,
      agentId,
      projectPath,
      securityMode: securityMode || 'auto',
      executor: executor || 'local',
      dockerImage: dockerImage || undefined,
      postTaskHook: postTaskHook || undefined,
      extraMounts: extraMounts || undefined,
      enableWorktree: enableWorktree || false,
      createdAt: new Date().toISOString(),
    };

    await storage.saveProject(project);

    // Return full project with counts
    const savedProject = await storage.getProject(project.id);
    res.status(201).json(savedProject);
  } catch (error) {
    console.error('Failed to create project:', error);
    res.status(500).json({ message: 'Failed to create project' });
  }
});

// Update project
router.put('/:id', async (req, res) => {
  try {
    const project = await storage.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const { name, agentId, projectPath, securityMode, authType, executor, dockerImage, postTaskHook, extraMounts, enableWorktree } = req.body;

    const updatedProject: Omit<Project, 'taskCount' | 'runningCount'> = {
      id: project.id,
      name: name || project.name,
      agentId: agentId || project.agentId,
      projectPath: projectPath || project.projectPath,
      securityMode: securityMode || project.securityMode,
      authType: authType || project.authType,
      executor: executor !== undefined ? executor : project.executor,
      dockerImage: dockerImage !== undefined ? (dockerImage || undefined) : project.dockerImage,
      postTaskHook: postTaskHook !== undefined ? (postTaskHook || undefined) : project.postTaskHook,
      extraMounts: extraMounts !== undefined ? (extraMounts || undefined) : project.extraMounts,
      enableWorktree: enableWorktree !== undefined ? enableWorktree : project.enableWorktree,
      createdAt: project.createdAt,
      lastActivity: project.lastActivity,
    };

    await storage.saveProject(updatedProject);

    const saved = await storage.getProject(project.id);
    res.json(saved);
  } catch (error) {
    console.error('Failed to update project:', error);
    res.status(500).json({ message: 'Failed to update project' });
  }
});

// Delete project
router.delete('/:id', async (req, res) => {
  try {
    const project = await storage.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    await storage.deleteProject(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete project:', error);
    res.status(500).json({ message: 'Failed to delete project' });
  }
});

// Get all agents
router.get('/agents/list', async (req, res) => {
  try {
    const agents = agentPool.getAllAgents();
    res.json(agents);
  } catch (error) {
    console.error('Failed to get agents:', error);
    res.status(500).json({ message: 'Failed to get agents' });
  }
});

export default router;
