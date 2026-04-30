import { Router } from 'express';
import * as storage from '../services/storage.js';
import { agentPool } from '../services/agentPool.js';
import { buildTaskAllowedPaths } from '../services/pathValidation.js';
import { listSessions, listActiveSessions, getSessionDetail, getLinkedTaskIds, mergeSessions, searchSessions, cleanUserMessage, isCommandMessage, isContinuationMessage } from '../services/sessionBrowser.js';
import type { SessionListItem, SessionDetail, SessionTimelineEntry } from '../services/sessionBrowser.js';

const router = Router();

/**
 * Server-side safety net: re-clean agent-returned session data.
 * Agents may be running older code that doesn't apply cleanUserMessage properly.
 */
function cleanSessionList(sessions: SessionListItem[]): SessionListItem[] {
  for (const s of sessions) {
    if (s.firstPrompt) {
      const raw = s.firstPrompt;
      const cleaned = cleanUserMessage(raw);
      if (!cleaned) {
        // System-only message → try to find any meaningful text
        s.firstPrompt = '(system message)';
      } else {
        s.firstPrompt = cleaned.slice(0, 200);
      }
    }
  }
  return sessions;
}

function cleanSessionEntries(entries: SessionTimelineEntry[]): SessionTimelineEntry[] {
  const cleaned: SessionTimelineEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== 'user_message') {
      cleaned.push(entry);
      continue;
    }
    const result = cleanUserMessage(entry.content);
    if (result) {
      cleaned.push({ ...entry, content: result });
    }
    // null → system message, drop it
  }
  return cleaned;
}

/**
 * Try local filesystem first, then ask the agent via WebSocket.
 * Local is fast (no network hop); agent is fallback for remote projects.
 */
async function fetchSessionList(project: { id: string; projectPath: string; agentId: string }): Promise<SessionListItem[]> {
  // 1. Try local
  const local = await listSessions(project.projectPath, project.id);
  console.log(`[sessions] local list for ${project.id}: ${local.length} sessions`);
  if (local.length > 0) return mergeSessions(local);

  // 2. Fall back to agent
  const agent = agentPool.getAgent(project.agentId);
  if (!agent) { console.log(`[sessions] agent ${project.agentId} not connected`); return []; }

  console.log(`[sessions] requesting sessions from agent ${project.agentId} for path ${project.projectPath}`);
  let result: { ok: boolean; sessions?: SessionListItem[]; error?: string };
  try {
    result = await agentPool.requestSessions(project.agentId, project.projectPath) as typeof result;
  } catch (err) {
    console.error(`[sessions] agent request failed:`, err);
    return [];
  }
  console.log(`[sessions] agent response: ok=${result.ok}, sessions=${result.sessions?.length ?? 'undefined'}, error=${result.error}`);
  if (!result.ok || !result.sessions) return [];

  // Clean agent-returned data (safety net for older agent versions)
  cleanSessionList(result.sessions);

  // Merge linkedTaskIds from server DB
  const linked = getLinkedTaskIds(project.id);
  for (const s of result.sessions) {
    s.linkedTaskId = linked.get(s.sessionId);
  }
  return mergeSessions(result.sessions);
}

async function fetchSessionDetail(
  project: { id: string; projectPath: string; agentId: string },
  sessionId: string,
  relatedSessionIds?: string[],
): Promise<SessionDetail | null> {
  // 1. Try local (supports merging related sessions)
  const local = await getSessionDetail(project.projectPath, sessionId, project.id, relatedSessionIds);
  if (local) return local;

  // 2. Fall back to agent
  const agent = agentPool.getAgent(project.agentId);
  if (!agent) return null;

  const result = await agentPool.requestSessionDetail(project.agentId, project.projectPath, sessionId) as {
    ok: boolean;
    entries?: SessionDetail['entries'];
    error?: string;
  };
  if (!result.ok || !result.entries) return null;

  const linked = getLinkedTaskIds(project.id);
  return {
    sessionId,
    entries: cleanSessionEntries(result.entries),
    linkedTaskId: linked.get(sessionId),
  };
}

async function fetchActiveSessionList(project: { id: string; projectPath: string; agentId: string }): Promise<SessionListItem[]> {
  // 1. Try local
  const local = await listActiveSessions(project.projectPath, project.id);
  console.log(`[sessions] local active for ${project.id}: ${local.length} sessions`);
  if (local.length > 0) return mergeSessions(local);

  // 2. Fall back to agent (remote project)
  const agent = agentPool.getAgent(project.agentId);
  if (!agent) { console.log(`[sessions] agent ${project.agentId} not connected for active`); return []; }

  try {
    console.log(`[sessions] requesting active sessions from agent ${project.agentId}`);
    const result = await agentPool.requestActiveSessions(project.agentId, project.projectPath) as {
      ok: boolean;
      sessions?: SessionListItem[];
      error?: string;
    };
    console.log(`[sessions] active agent response: ok=${result.ok}, sessions=${result.sessions?.length ?? 'undefined'}, error=${result.error}`);
    if (!result.ok || !result.sessions) return [];

    // Clean agent-returned data (safety net)
    cleanSessionList(result.sessions);

    const linked = getLinkedTaskIds(project.id);
    for (const s of result.sessions) {
      s.linkedTaskId = linked.get(s.sessionId);
    }
    return mergeSessions(result.sessions);
  } catch {
    return [];
  }
}

// Search sessions by user message content
router.get('/projects/:projectId/sessions/search', async (req, res) => {
  try {
    const project = await storage.getProject(req.params.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const query = (req.query.q as string || '').trim();
    if (!query) {
      return res.json([]);
    }

    // Try local first
    const localResults = await searchSessions(project.projectPath, project.id, query);
    if (localResults.length > 0) {
      return res.json(localResults);
    }

    // Fall back to agent for remote projects
    const agent = agentPool.getAgent(project.agentId);
    if (agent) {
      try {
        const result = await agentPool.requestSessionSearch(project.agentId, project.projectPath, query) as {
          ok: boolean;
          results?: Array<Record<string, unknown>>;
          error?: string;
        };
        if (result.ok && result.results) {
          // Merge linkedTaskIds from server DB
          const linked = getLinkedTaskIds(project.id);
          for (const r of result.results) {
            const sid = r.sessionId as string;
            if (sid && linked.has(sid)) {
              r.linkedTaskId = linked.get(sid);
            }
          }
          return res.json(result.results);
        }
      } catch (err) {
        console.error('[sessions] agent search failed:', err);
      }
    }

    res.json([]);
  } catch (error) {
    console.error('Failed to search sessions:', error);
    res.status(500).json({ message: 'Failed to search sessions' });
  }
});

// List active (running) CLI sessions for a project — must be before /:sessionId
router.get('/projects/:projectId/sessions/active', async (req, res) => {
  try {
    const project = await storage.getProject(req.params.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const sessions = await fetchActiveSessionList(project);
    res.json(sessions);
  } catch (error) {
    console.error('Failed to list active sessions:', error);
    res.status(500).json({ message: 'Failed to list active sessions' });
  }
});

// List all CLI sessions for a project
router.get('/projects/:projectId/sessions', async (req, res) => {
  try {
    const project = await storage.getProject(req.params.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const sessions = await fetchSessionList(project);
    res.json(sessions);
  } catch (error) {
    console.error('Failed to list sessions:', error);
    res.status(500).json({ message: 'Failed to list sessions' });
  }
});

// Get session detail (supports ?related=id1,id2,id3 for merged timeline)
router.get('/projects/:projectId/sessions/:sessionId', async (req, res) => {
  try {
    const project = await storage.getProject(req.params.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const relatedParam = req.query.related as string | undefined;
    const relatedSessionIds = relatedParam ? relatedParam.split(',').filter(Boolean) : undefined;

    const detail = await fetchSessionDetail(project, req.params.sessionId, relatedSessionIds);
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
