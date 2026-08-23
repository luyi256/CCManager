import { Router } from 'express';
import * as storage from '../services/storage.js';
import { agentPool } from '../services/agentPool.js';
import { buildTaskAllowedPaths } from '../services/pathValidation.js';
import { listSessions, listActiveSessions, getSessionDetail, getLinkedTaskIds, mergeSessions, searchSessions, cleanUserMessage, isCommandMessage, isContinuationMessage } from '../services/sessionBrowser.js';
import type { SessionListItem, SessionDetail, SessionTimelineEntry } from '../services/sessionBrowser.js';
import type { Runner } from '../types/index.js';

const router = Router();
const VALID_RUNNERS = new Set<Runner>(['claude', 'claude-grok', 'codex', 'qwen', 'tclaude', 'tcodex']);

function parseRunner(value: unknown): Runner | undefined {
  return typeof value === 'string' && VALID_RUNNERS.has(value as Runner)
    ? value as Runner
    : undefined;
}

function normalizeAgentSessions(sessions: SessionListItem[]): SessionListItem[] {
  return sessions
    .map((session) => ({ ...session, runner: parseRunner(session.runner) ?? 'claude' }));
}

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

function attachLinkedTasks(projectId: string, sessions: SessionListItem[]): SessionListItem[] {
  const linked = getLinkedTaskIds(projectId);
  for (const session of sessions) {
    session.linkedTaskId = linked.get(`${session.runner}:${session.sessionId}`)
      ?? linked.get(session.sessionId)
      ?? session.linkedTaskId;
  }
  return sessions;
}

function combineSessions(...groups: SessionListItem[][]): SessionListItem[] {
  const unique = new Map<string, SessionListItem>();
  for (const session of groups.flat()) {
    const key = `${session.runner}:${session.sessionId}`;
    const previous = unique.get(key);
    if (!previous || new Date(session.lastModified).getTime() > new Date(previous.lastModified).getTime()) {
      unique.set(key, session);
    }
  }
  return mergeSessions(Array.from(unique.values()));
}

/**
 * Read locally available Claude sessions and combine them with the agent's
 * complete multi-runner catalog. The agent is authoritative for remote hosts
 * and for runner-specific stores such as Codex, tClaude, tCodex, and Qwen.
 */
async function fetchSessionList(project: { id: string; projectPath: string; agentId: string }): Promise<SessionListItem[]> {
  const local = await listSessions(project.projectPath, project.id);
  console.log(`[sessions] local list for ${project.id}: ${local.length} sessions`);
  const agent = agentPool.getAgent(project.agentId);
  if (!agent) {
    console.log(`[sessions] agent ${project.agentId} not connected`);
    return combineSessions(attachLinkedTasks(project.id, local));
  }

  console.log(`[sessions] requesting sessions from agent ${project.agentId} for path ${project.projectPath}`);
  let result: { ok: boolean; sessions?: SessionListItem[]; error?: string };
  try {
    result = await agentPool.requestSessions(project.agentId, project.projectPath, project.id) as typeof result;
  } catch (err) {
    console.error(`[sessions] agent request failed:`, err);
    return combineSessions(attachLinkedTasks(project.id, local));
  }
  console.log(`[sessions] agent response: ok=${result.ok}, sessions=${result.sessions?.length ?? 'undefined'}, error=${result.error}`);
  if (!result.ok || !result.sessions) return combineSessions(attachLinkedTasks(project.id, local));
  result.sessions = normalizeAgentSessions(result.sessions);

  // Clean agent-returned data (safety net for older agent versions)
  cleanSessionList(result.sessions);
  return combineSessions(attachLinkedTasks(project.id, local), attachLinkedTasks(project.id, result.sessions));
}

async function fetchSessionDetail(
  project: { id: string; projectPath: string; agentId: string },
  runner: Runner,
  sessionId: string,
  relatedSessionIds?: string[],
): Promise<SessionDetail | null> {
  // 1. Try local (supports merging related sessions)
  const local = await getSessionDetail(project.projectPath, sessionId, project.id, relatedSessionIds, runner);
  if (local) return local;

  // 2. Fall back to agent
  const agent = agentPool.getAgent(project.agentId);
  if (!agent) return null;

  const result = await agentPool.requestSessionDetail(
    project.agentId,
    project.projectPath,
    runner,
    sessionId,
    relatedSessionIds,
    project.id,
  ) as {
    ok: boolean;
    entries?: SessionDetail['entries'];
    model?: string;
    error?: string;
  };
  if (!result.ok || !result.entries) return null;

  const linked = getLinkedTaskIds(project.id);
  return {
    sessionId,
    runner,
    model: result.model,
    entries: runner === 'claude' || runner === 'claude-grok'
      ? cleanSessionEntries(result.entries)
      : result.entries,
    linkedTaskId: linked.get(`${runner}:${sessionId}`) ?? linked.get(sessionId),
  };
}

async function fetchActiveSessionList(project: { id: string; projectPath: string; agentId: string }): Promise<SessionListItem[]> {
  const local = await listActiveSessions(project.projectPath, project.id);
  console.log(`[sessions] local active for ${project.id}: ${local.length} sessions`);
  const agent = agentPool.getAgent(project.agentId);
  if (!agent) {
    console.log(`[sessions] agent ${project.agentId} not connected for active`);
    return combineSessions(attachLinkedTasks(project.id, local));
  }

  try {
    console.log(`[sessions] requesting active sessions from agent ${project.agentId}`);
    const result = await agentPool.requestActiveSessions(project.agentId, project.projectPath, project.id) as {
      ok: boolean;
      sessions?: SessionListItem[];
      error?: string;
    };
    console.log(`[sessions] active agent response: ok=${result.ok}, sessions=${result.sessions?.length ?? 'undefined'}, error=${result.error}`);
    if (!result.ok || !result.sessions) return combineSessions(attachLinkedTasks(project.id, local));
    result.sessions = normalizeAgentSessions(result.sessions);

    // Clean agent-returned data (safety net)
    cleanSessionList(result.sessions);

    return combineSessions(attachLinkedTasks(project.id, local), attachLinkedTasks(project.id, result.sessions));
  } catch {
    return combineSessions(attachLinkedTasks(project.id, local));
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

    // Search local Claude sessions, then combine with the agent's multi-runner search.
    const localResults = await searchSessions(project.projectPath, project.id, query);
    const agentConn = agentPool.getAgent(project.agentId);
    if (agentConn) {
      const linked = getLinkedTaskIds(project.id);

      try {
        const searchResult = await agentPool.requestSessionSearch(
          project.agentId,
          project.projectPath,
          query,
          project.id,
        ) as {
          ok: boolean;
          results?: Array<SessionListItem & {
            matches: Array<{ message: string; entryId: string; context: Array<{ type: string; content: string }> }>;
            matchedMessage: string;
            matchedEntryIndex: number;
            matchedEntryId: string;
          }>;
        };
        if (searchResult.ok && searchResult.results) {
          const remote = searchResult.results
            .map((result) => ({ ...result, runner: parseRunner(result.runner) ?? 'claude' }));
          for (const result of remote) {
            result.linkedTaskId = linked.get(`${result.runner}:${result.sessionId}`)
              ?? linked.get(result.sessionId)
              ?? result.linkedTaskId;
          }
          const combined = new Map(localResults.map((result) => [`${result.runner}:${result.sessionId}`, result]));
          for (const result of remote) combined.set(`${result.runner}:${result.sessionId}`, result);
          return res.json(Array.from(combined.values())
            .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()));
        }
      } catch (err) {
        console.error('[sessions] agent search failed:', err);
      }
    }

    res.json(localResults);
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
    const runner = parseRunner(req.query.runner) ?? 'claude';

    const detail = await fetchSessionDetail(project, runner, req.params.sessionId, relatedSessionIds);
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
    const { prompt, images, runner, model } = req.body;
    if (!prompt && (!images || images.length === 0)) {
      return res.status(400).json({ message: 'Prompt required' });
    }

    const project = await storage.getProject(req.params.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const sessionId = req.params.sessionId;
    const selectedRunner = parseRunner(runner) ?? 'claude';

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
      runner: selectedRunner,
      model: typeof model === 'string' && model.trim() ? model.trim() : undefined,
      createdAt: new Date().toISOString(),
    });

    // Set the sessionId in gitInfo so the agent knows to --resume
    task.gitInfo = JSON.stringify({ sessionId, sessionRunner: selectedRunner });
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
      runner: selectedRunner,
      model: task.model,
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

// Adopt a CLI session as a conversation WITHOUT running it: create a completed
// task linked to the session and import its history into the task timeline, so it
// appears in the conversation sidebar and its history renders in the center view.
// Follow-ups from there resume the real session via gitInfo.sessionId.
router.post('/projects/:projectId/sessions/:sessionId/adopt', async (req, res) => {
  try {
    const project = await storage.getProject(req.params.projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const sessionId = req.params.sessionId;
    const runner = parseRunner(req.body?.runner) ?? 'claude';
    const model = typeof req.body?.model === 'string' && req.body.model.trim()
      ? req.body.model.trim()
      : undefined;
    const relatedRaw = req.body?.relatedSessionIds;
    const relatedSessionIds = Array.isArray(relatedRaw)
      ? relatedRaw.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
      : undefined;

    // Idempotent: if a task already represents this session, just return it.
    const linkedTasks = getLinkedTaskIds(project.id);
    const existingId = linkedTasks.get(`${runner}:${sessionId}`) ?? linkedTasks.get(sessionId);
    if (existingId) {
      const existing = await storage.getTaskById(existingId);
      if (existing) return res.json(existing);
    }

    const detail = await fetchSessionDetail(project, runner, sessionId, relatedSessionIds);
    if (!detail || detail.entries.length === 0) {
      return res.status(404).json({ message: 'Session not found or has no content' });
    }

    const firstUser = detail.entries.find((e) => e.type === 'user_message');
    const promptText = (firstUser?.content || 'Resumed CLI session').slice(0, 2000);
    const firstTs = detail.entries[0]?.timestamp;
    const createdAt = firstTs ? new Date(firstTs).toISOString() : new Date().toISOString();

    // Create a completed task pre-linked to the session.
    const task = await storage.createTask(project.id, {
      projectId: project.id,
      prompt: promptText,
      status: 'completed',
      isPlanMode: false,
      runner,
      model: model || detail.model,
      createdAt,
    });
    task.gitInfo = JSON.stringify({ sessionId, sessionRunner: runner });
    task.completedAt = new Date().toISOString();
    await storage.saveTask(project.id, task);

    // Import the session timeline as task logs. Skip the first user message —
    // it becomes the task prompt (rendered as the opening message in the panel).
    let promptConsumed = false;
    for (const e of detail.entries) {
      if (!promptConsumed && e.type === 'user_message' && e.content === firstUser?.content) {
        promptConsumed = true;
        continue;
      }
      if (e.type === 'output') {
        await storage.appendTaskLog(project.id, task.id, { type: 'output', content: e.content });
      } else if (e.type === 'user_message') {
        await storage.appendTaskLog(project.id, task.id, { type: 'user_message', content: e.content });
      } else if (e.type === 'tool_use') {
        await storage.appendTaskLog(project.id, task.id, { type: 'tool_use', content: { id: e.id, name: e.toolName, input: e.toolInput } });
      } else if (e.type === 'tool_result') {
        await storage.appendTaskLog(project.id, task.id, { type: 'tool_result', content: { id: e.id, result: e.toolResult } });
      }
    }

    res.json(task);
  } catch (error) {
    console.error('Failed to adopt session:', error);
    res.status(500).json({ message: 'Failed to adopt session' });
  }
});

export default router;
