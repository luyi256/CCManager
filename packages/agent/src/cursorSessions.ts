import { existsSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { readdir, readFile, stat } from 'fs/promises';
import type { AgentMessage, SDKAgentInfo } from '@cursor/sdk';
import type { SessionListItem, SessionSearchResult, SessionTimelineEntry } from './sessions.js';
import {
  equivalentProjectPaths,
  pathBelongsToProject,
  projectPathToStoreName,
} from './projectPaths.js';

const ACTIVE_THRESHOLD_MS = 120_000;
const SESSION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

interface CursorSessionQueryOptions {
  homeDir?: string;
  includeSdk?: boolean;
}

interface CursorIdeSession {
  sessionId: string;
  transcriptPath: string;
  cwd?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function cursorAgent(): Promise<typeof import('@cursor/sdk')['Agent']> {
  const { Agent } = await import('@cursor/sdk');
  return Agent;
}

function messageText(message: unknown): string {
  if (typeof message === 'string') return message.trim();
  if (!message || typeof message !== 'object') return '';
  const record = message as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text.trim();
  if (typeof record.content === 'string') return record.content.trim();
  if (!Array.isArray(record.content)) return '';
  return record.content
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function cleanCursorUserText(text: string): string {
  const userQuery = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)?.[1];
  if (userQuery) return userQuery.trim();
  return text
    .replace(/^\s*<timestamp>[\s\S]*?<\/timestamp>\s*/i, '')
    .replace(/^\s*<manually_attached_skills>[\s\S]*?<\/manually_attached_skills>\s*/i, '')
    .replace(/^\s*<user_query>\s*/i, '')
    .replace(/\s*<\/user_query>\s*$/i, '')
    .trim();
}

function titleFromPrompt(prompt: string): string {
  const clean = prompt.replace(/\s+/g, ' ').trim();
  if (!clean) return 'Cursor session';
  return clean.length > 72 ? `${clean.slice(0, 71).trimEnd()}…` : clean;
}

function messageTimestamp(message: AgentMessage, fallback: number, offset: number): number {
  const value = message.message && typeof message.message === 'object'
    ? (message.message as Record<string, unknown>).timestamp
    : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback + offset;
}

function sdkAgentCwd(item: SDKAgentInfo): string | undefined {
  return item.runtime === 'local' ? item.cwd : undefined;
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

async function loadCursorChatMetadata(
  cursorHome: string,
  sessionIds: Set<string>,
): Promise<Map<string, Omit<CursorIdeSession, 'sessionId' | 'transcriptPath'>>> {
  const result = new Map<string, Omit<CursorIdeSession, 'sessionId' | 'transcriptPath'>>();
  for (const workspaceDir of await listDirectories(join(cursorHome, 'chats'))) {
    for (const sessionDir of await listDirectories(workspaceDir)) {
      const sessionId = basename(sessionDir);
      if (!sessionIds.has(sessionId)) continue;
      try {
        const meta = JSON.parse(await readFile(join(sessionDir, 'meta.json'), 'utf8')) as Record<string, unknown>;
        result.set(sessionId, {
          cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined,
          title: typeof meta.title === 'string' ? meta.title : undefined,
          createdAt: typeof meta.createdAtMs === 'number' ? meta.createdAtMs : undefined,
          updatedAt: typeof meta.updatedAtMs === 'number' ? meta.updatedAtMs : undefined,
        });
      } catch {
        // Some older transcripts have no chat metadata.
      }
    }
  }
  return result;
}

async function discoverCursorIdeSessions(
  projectPath: string,
  homeDir = homedir(),
): Promise<CursorIdeSession[]> {
  const cursorHome = join(homeDir, '.cursor');
  const projectsRoot = join(cursorHome, 'projects');
  if (!existsSync(projectsRoot)) return [];
  const acceptedPaths = await equivalentProjectPaths(projectPath);
  const names = acceptedPaths.map((path) => projectPathToStoreName(path, true));
  const suffixes = names.map((name) => name.split('-').slice(-2).join('-'));
  const projectDirs = (await listDirectories(projectsRoot)).filter((dir) => {
    const name = basename(dir);
    return names.some((candidate, index) =>
      name === candidate || name.startsWith(`${candidate}-`) || name.endsWith(suffixes[index])
    );
  });

  const transcripts: Array<{ sessionId: string; transcriptPath: string; inferredCwd?: string }> = [];
  for (const projectDir of projectDirs) {
    const transcriptRoot = join(projectDir, 'agent-transcripts');
    for (const sessionDir of await listDirectories(transcriptRoot)) {
      const sessionId = basename(sessionDir);
      if (!SESSION_ID_REGEX.test(sessionId)) continue;
      const transcriptPath = join(sessionDir, `${sessionId}.jsonl`);
      if (existsSync(transcriptPath)) {
        const matchingIndex = names.findIndex((name) =>
          basename(projectDir) === name || basename(projectDir).startsWith(`${name}-`)
        );
        transcripts.push({
          sessionId,
          transcriptPath,
          inferredCwd: matchingIndex >= 0 ? acceptedPaths[matchingIndex] : undefined,
        });
      }
    }
  }

  const metadata = await loadCursorChatMetadata(
    cursorHome,
    new Set(transcripts.map((item) => item.sessionId)),
  );
  const sessions: CursorIdeSession[] = [];
  for (const transcript of transcripts) {
    const meta = metadata.get(transcript.sessionId);
    const cwd = meta?.cwd || transcript.inferredCwd;
    if (!cwd) continue;
    if (!await pathBelongsToProject(cwd, acceptedPaths)) continue;
    sessions.push({ ...transcript, ...meta, cwd });
  }
  return sessions;
}

function parseCursorIdeTimeline(content: string, fallbackTimestamp: number): SessionTimelineEntry[] {
  const entries: SessionTimelineEntry[] = [];
  let counter = 0;
  for (const line of content.split('\n')) {
    let record: Record<string, any>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.role !== 'user' && record.role !== 'assistant') continue;
    const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const timestamp = fallbackTimestamp + counter;
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = record.role === 'user' ? cleanCursorUserText(block.text) : block.text.trim();
        if (text) {
          entries.push({
            id: `cursor-ide-${counter++}`,
            type: record.role === 'user' ? 'user_message' : 'output',
            timestamp,
            content: text,
          });
        }
      } else if (record.role === 'assistant' && block.type === 'tool_use') {
        entries.push({
          id: `cursor-ide-tool-${counter++}`,
          type: 'tool_use',
          timestamp,
          content: '',
          toolName: typeof block.name === 'string' ? block.name : 'tool',
          toolInput: block.input,
        });
      }
    }
  }
  return entries;
}

async function listCursorIdeSessions(
  projectPath: string,
  activeOnly: boolean,
  homeDir?: string,
): Promise<SessionListItem[]> {
  const sessions: SessionListItem[] = [];
  for (const item of await discoverCursorIdeSessions(projectPath, homeDir)) {
    try {
      const fileStat = await stat(item.transcriptPath);
      const lastModified = item.updatedAt || fileStat.mtime.getTime();
      const isActive = Date.now() - lastModified <= ACTIVE_THRESHOLD_MS;
      if (activeOnly && !isActive) continue;
      const entries = parseCursorIdeTimeline(
        await readFile(item.transcriptPath, 'utf8'),
        item.createdAt || fileStat.birthtime.getTime() || fileStat.mtime.getTime(),
      );
      const firstPrompt = entries.find((entry) => entry.type === 'user_message')?.content || 'Cursor session';
      sessions.push({
        sessionId: item.sessionId,
        runner: 'cursor',
        title: item.title || titleFromPrompt(firstPrompt),
        firstPrompt: firstPrompt.slice(0, 200),
        lastModified: new Date(lastModified).toISOString(),
        fileSize: Number(fileStat.size),
        isActive,
      });
    } catch {
      // Ignore a transcript that disappears while it is being read.
    }
  }
  return sessions;
}

async function listCursorSdkSessions(
  projectPath: string,
  activeOnly: boolean,
): Promise<SessionListItem[]> {
  const Agent = await cursorAgent();
  const sessions: SessionListItem[] = [];
  const seen = new Set<string>();
  for (const cwd of await equivalentProjectPaths(projectPath)) {
    let cursor: string | undefined;
    do {
      const page = await Agent.list({ runtime: 'local', cwd, limit: 100, cursor });
      for (const item of page.items) {
        if (seen.has(item.agentId)) continue;
        seen.add(item.agentId);
        const isActive = item.status === 'running' ||
          Date.now() - item.lastModified <= ACTIVE_THRESHOLD_MS;
        if (activeOnly && !isActive) continue;
        let firstPrompt = item.summary || item.name || 'Cursor session';
        try {
          const messages = await Agent.messages.list(item.agentId, {
            runtime: 'local',
            cwd: sdkAgentCwd(item) || cwd,
            limit: 100,
          });
          firstPrompt = messages
            .filter((message) => message.type === 'user')
            .map((message) => cleanCursorUserText(messageText(message.message)))
            .find(Boolean) || firstPrompt;
        } catch {
          // Metadata remains useful if one transcript cannot be read.
        }
        sessions.push({
          sessionId: item.agentId,
          runner: 'cursor',
          title: item.name,
          firstPrompt: firstPrompt.slice(0, 200),
          lastModified: new Date(item.lastModified).toISOString(),
          fileSize: 0,
          isActive,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  return sessions;
}

export async function listCursorSessions(
  projectPath: string,
  activeOnly = false,
  options: CursorSessionQueryOptions = {},
): Promise<SessionListItem[]> {
  const [ideSessions, sdkSessions] = await Promise.all([
    listCursorIdeSessions(projectPath, activeOnly, options.homeDir),
    // Cursor SDK sessions are also persisted under agent-transcripts, which is
    // the fast path above. Loading @cursor/sdk can synchronously block Node for
    // over 10 seconds on a cold start, exceeding the server's request timeout.
    // Keep direct SDK-store discovery as an explicit legacy fallback only.
    options.includeSdk === true
      ? settleWithin(listCursorSdkSessions(projectPath, activeOnly), 5_000, []).catch(() => [])
      : Promise.resolve([]),
  ]);
  const unique = new Map<string, SessionListItem>();
  for (const session of [...ideSessions, ...sdkSessions]) {
    const previous = unique.get(session.sessionId);
    if (!previous || new Date(session.lastModified) > new Date(previous.lastModified)) {
      unique.set(session.sessionId, session);
    }
  }
  return Array.from(unique.values())
    .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
}

async function findCursorSdkSession(projectPath: string, sessionId: string): Promise<SDKAgentInfo | null> {
  const Agent = await cursorAgent();
  for (const cwd of await equivalentProjectPaths(projectPath)) {
    let cursor: string | undefined;
    do {
      const page = await Agent.list({ runtime: 'local', cwd, limit: 100, cursor });
      const match = page.items.find((item) => item.agentId === sessionId);
      if (match) return match;
      cursor = page.nextCursor;
    } while (cursor);
  }
  return null;
}

export async function getCursorSessionDetail(
  projectPath: string,
  sessionId: string,
  options: CursorSessionQueryOptions = {},
): Promise<SessionTimelineEntry[] | null> {
  if (!SESSION_ID_REGEX.test(sessionId)) return null;
  const ideSession = (await discoverCursorIdeSessions(projectPath, options.homeDir))
    .find((item) => item.sessionId === sessionId);
  if (ideSession) {
    try {
      const fileStat = await stat(ideSession.transcriptPath);
      const entries = parseCursorIdeTimeline(
        await readFile(ideSession.transcriptPath, 'utf8'),
        ideSession.createdAt || fileStat.birthtime.getTime() || fileStat.mtime.getTime(),
      );
      return entries.length > 0 ? entries : null;
    } catch {
      return null;
    }
  }
  if (options.includeSdk !== true) return null;

  const Agent = await cursorAgent();
  let messages: AgentMessage[];
  try {
    const session = await findCursorSdkSession(projectPath, sessionId);
    if (!session) return null;
    messages = await Agent.messages.list(sessionId, {
      runtime: 'local',
      cwd: sdkAgentCwd(session) || projectPath,
      limit: 1000,
    });
  } catch {
    return null;
  }
  const fallback = Date.now() - messages.length;
  const entries = messages.flatMap((message, index): SessionTimelineEntry[] => {
    const text = message.type === 'user'
      ? cleanCursorUserText(messageText(message.message))
      : messageText(message.message);
    if (!text) return [];
    return [{
      id: `cursor-${message.uuid || index}`,
      type: message.type === 'user' ? 'user_message' : 'output',
      timestamp: messageTimestamp(message, fallback, index),
      content: text,
    }];
  });
  return entries.length > 0 ? entries : null;
}

export async function searchCursorSessions(
  projectPath: string,
  query: string,
  options: CursorSessionQueryOptions = {},
): Promise<SessionSearchResult[]> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const sessions = await listCursorSessions(projectPath, false, options);
  const results: SessionSearchResult[] = [];
  for (const session of sessions) {
    const entries = await getCursorSessionDetail(projectPath, session.sessionId, options);
    if (!entries) continue;
    const matches = entries
      .filter((entry) => entry.type === 'user_message' && entry.content.toLowerCase().includes(normalized))
      .map((entry) => ({
        message: entry.content.slice(0, 300),
        entryId: entry.id,
        context: [],
      }));
    if (matches.length === 0) continue;
    results.push({
      ...session,
      matches,
      matchedMessage: matches[0].message,
      matchedEntryIndex: 0,
      matchedEntryId: matches[0].entryId,
    });
  }
  return results;
}
