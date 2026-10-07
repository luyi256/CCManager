import { Router, type Response } from 'express';
import * as storage from '../services/storage.js';
import { agentPool } from '../services/agentPool.js';
import { buildTaskAllowedPaths } from '../services/pathValidation.js';
import type { Project } from '../types/index.js';

const router = Router();

interface AgentFileResult {
  ok?: boolean;
  error?: string;
  code?: string;
  [key: string]: unknown;
}

/** 403 is avoided on purpose: the web client treats it as a revoked device token. */
function fileErrorStatus(code: string | undefined): number {
  return code === 'not_found' ? 404 : 400;
}

function fileAccess(project: Project) {
  return { projectPath: project.projectPath, allowedPaths: buildTaskAllowedPaths(project) };
}

async function loadProject(projectId: string, res: Response): Promise<Project | null> {
  const project = await storage.getProject(projectId);
  if (!project) {
    res.status(404).json({ message: 'Project not found' });
    return null;
  }
  if (!agentPool.getAgent(project.agentId)) {
    res.status(503).json({ message: `Agent ${project.agentId} is offline` });
    return null;
  }
  return project;
}

function sendAgentResult(res: Response, result: unknown): void {
  const body = (result ?? {}) as AgentFileResult;
  if (!body.ok) {
    res.status(fileErrorStatus(body.code)).json({ message: body.error || 'File request failed', code: body.code });
    return;
  }
  const { ok: _ok, ...payload } = body;
  res.json(payload);
}

function sendAgentFailure(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'Agent timeout') {
    res.status(504).json({ message: 'The agent did not respond. It may need to be updated to support file browsing.' });
  } else {
    res.status(503).json({ message });
  }
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

router.get('/projects/:projectId/files/list', async (req, res) => {
  try {
    const project = await loadProject(req.params.projectId, res);
    if (!project) return;
    const result = await agentPool.requestFiles(project.agentId, 'files:list', {
      ...fileAccess(project),
      path: queryString(req.query.path) ?? '',
    });
    sendAgentResult(res, result);
  } catch (error) {
    sendAgentFailure(res, error);
  }
});

router.get('/projects/:projectId/files/content', async (req, res) => {
  try {
    const filePath = queryString(req.query.path);
    if (!filePath) return res.status(400).json({ message: 'path is required' });
    const project = await loadProject(req.params.projectId, res);
    if (!project) return;
    const result = await agentPool.requestFileContent(project.agentId, {
      ...fileAccess(project),
      path: filePath,
      etag: queryString(req.query.etag),
    });
    sendAgentResult(res, result);
  } catch (error) {
    sendAgentFailure(res, error);
  }
});

router.post('/projects/:projectId/files/sync', async (req, res) => {
  try {
    const rawDirs: unknown[] = Array.isArray(req.body?.dirs) ? req.body.dirs : [];
    const dirs = rawDirs
      .filter((dir): dir is { path: string; etag?: unknown } =>
        typeof dir === 'object' && dir !== null && typeof (dir as { path?: unknown }).path === 'string')
      .map((dir) => ({ path: dir.path, etag: typeof dir.etag === 'string' ? dir.etag : undefined }));
    const rawFile = req.body?.file;
    const file = rawFile && typeof rawFile.path === 'string'
      ? { path: rawFile.path, etag: typeof rawFile.etag === 'string' ? rawFile.etag : undefined }
      : undefined;
    const project = await loadProject(req.params.projectId, res);
    if (!project) return;
    const result = await agentPool.requestFiles(project.agentId, 'files:sync', {
      ...fileAccess(project),
      dirs,
      file,
    });
    sendAgentResult(res, result);
  } catch (error) {
    sendAgentFailure(res, error);
  }
});

export default router;
