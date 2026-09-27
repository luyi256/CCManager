import type { AgentMessage } from '@cursor/sdk';
import type { SessionListItem, SessionSearchResult, SessionTimelineEntry } from './sessions.js';

const ACTIVE_THRESHOLD_MS = 120_000;

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

export async function listCursorSessions(
  projectPath: string,
  activeOnly = false,
): Promise<SessionListItem[]> {
  const Agent = await cursorAgent();
  const sessions: SessionListItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await Agent.list({ runtime: 'local', cwd: projectPath, limit: 100, cursor });
    for (const item of page.items) {
      const isActive = item.status === 'running' ||
        Date.now() - item.lastModified <= ACTIVE_THRESHOLD_MS;
      if (activeOnly && !isActive) continue;
      let firstPrompt = item.summary || item.name || 'Cursor session';
      try {
        const messages = await Agent.messages.list(item.agentId, {
          runtime: 'local',
          cwd: projectPath,
          limit: 100,
        });
        firstPrompt = messages
          .filter((message) => message.type === 'user')
          .map((message) => messageText(message.message))
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
  return sessions;
}

export async function getCursorSessionDetail(
  projectPath: string,
  sessionId: string,
): Promise<SessionTimelineEntry[] | null> {
  const Agent = await cursorAgent();
  let messages: AgentMessage[];
  try {
    messages = await Agent.messages.list(sessionId, {
      runtime: 'local',
      cwd: projectPath,
      limit: 1000,
    });
  } catch {
    return null;
  }
  const fallback = Date.now() - messages.length;
  const entries = messages.flatMap((message, index): SessionTimelineEntry[] => {
    const text = messageText(message.message);
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
): Promise<SessionSearchResult[]> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const sessions = await listCursorSessions(projectPath);
  const results: SessionSearchResult[] = [];
  for (const session of sessions) {
    const entries = await getCursorSessionDetail(projectPath, session.sessionId);
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
