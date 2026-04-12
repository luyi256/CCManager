import { readdir, readFile, stat } from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { homedir } from 'os';
import { db } from './database.js';

export interface SessionListItem {
  sessionId: string;
  firstPrompt: string;
  lastModified: string;
  fileSize: number;
  gitBranch?: string;
  linkedTaskId?: number;
  isActive?: boolean;
  /** All session IDs in this conversation chain (oldest → newest), present when merged. */
  relatedSessionIds?: string[];
}

const ACTIVE_THRESHOLD_MS = 120_000; // 120 seconds

export interface SessionTimelineEntry {
  id: string;
  type: 'output' | 'tool_use' | 'tool_result' | 'user_message';
  timestamp: number;
  content: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
}

export interface SessionDetail {
  sessionId: string;
  entries: SessionTimelineEntry[];
  linkedTaskId?: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function projectPathToHash(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function getSessionDir(projectPath: string): string {
  const hash = projectPathToHash(projectPath);
  return join(homedir(), '.claude', 'projects', hash);
}

/**
 * Read the first user prompt from a JSONL session file (efficient - stops early).
 */
async function getFirstUserPrompt(filePath: string): Promise<{ prompt: string; gitBranch?: string; timestamp?: string } | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    let resolved = false;

    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' && typeof obj.message?.content === 'string') {
          resolved = true;
          rl.close();
          resolve({
            prompt: obj.message.content.slice(0, 200),
            gitBranch: obj.gitBranch,
            timestamp: obj.timestamp,
          });
        }
      } catch { /* skip malformed lines */ }
    });

    rl.on('close', () => {
      if (!resolved) resolve(null);
    });

    rl.on('error', () => {
      if (!resolved) resolve(null);
    });
  });
}

/**
 * Batch lookup: find CCManager tasks linked to session IDs.
 */
export function getLinkedTaskIds(projectId: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const stmt = db.prepare(
      'SELECT id, git_info FROM tasks WHERE project_id = ? AND git_info IS NOT NULL'
    );
    const rows = stmt.all(projectId) as Array<{ id: number; git_info: string }>;
    for (const row of rows) {
      try {
        const info = JSON.parse(row.git_info);
        if (info.sessionId) {
          map.set(info.sessionId, row.id);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return map;
}

/**
 * Merge sessions with the same firstPrompt into a single entry.
 * Uses the latest (by lastModified) session as representative.
 */
export function mergeSessions(sessions: SessionListItem[]): SessionListItem[] {
  if (sessions.length <= 1) return sessions;

  const groups = new Map<string, SessionListItem[]>();
  for (const s of sessions) {
    const key = s.firstPrompt;
    const group = groups.get(key);
    if (group) {
      group.push(s);
    } else {
      groups.set(key, [s]);
    }
  }

  const merged: SessionListItem[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }

    // Sort by lastModified ascending (oldest first) so latest is last
    group.sort((a, b) => new Date(a.lastModified).getTime() - new Date(b.lastModified).getTime());
    const latest = group[group.length - 1];

    merged.push({
      sessionId: latest.sessionId,
      firstPrompt: latest.firstPrompt,
      lastModified: latest.lastModified,
      fileSize: group.reduce((sum, s) => sum + s.fileSize, 0),
      gitBranch: latest.gitBranch,
      linkedTaskId: latest.linkedTaskId ?? group.find(s => s.linkedTaskId)?.linkedTaskId,
      isActive: group.some(s => s.isActive),
      relatedSessionIds: group.map(s => s.sessionId),
    });
  }

  // Sort by lastModified descending (newest first)
  merged.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
  return merged;
}

/**
 * List all CLI sessions for a project path.
 */
export async function listSessions(projectPath: string, projectId: string): Promise<SessionListItem[]> {
  const dir = getSessionDir(projectPath);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    const entries = await readdir(dir);
    files = entries.filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  // Batch lookup for linked tasks
  const linkedTasks = getLinkedTaskIds(projectId);
  const now = Date.now();

  const results: SessionListItem[] = [];

  // Process in parallel with concurrency limit
  const CONCURRENCY = 20;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const items = await Promise.all(
      batch.map(async (file) => {
        const sessionId = file.replace('.jsonl', '');
        if (!UUID_REGEX.test(sessionId)) return null;

        const filePath = join(dir, file);
        try {
          const [fileStat, meta] = await Promise.all([
            stat(filePath),
            getFirstUserPrompt(filePath),
          ]);

          if (!meta) return null;

          return {
            sessionId,
            firstPrompt: meta.prompt,
            lastModified: fileStat.mtime.toISOString(),
            fileSize: fileStat.size,
            gitBranch: meta.gitBranch,
            linkedTaskId: linkedTasks.get(sessionId),
            isActive: now - fileStat.mtime.getTime() <= ACTIVE_THRESHOLD_MS,
          };
        } catch {
          return null;
        }
      })
    );

    for (const item of items) {
      if (item) results.push(item);
    }
  }

  // Sort by lastModified descending (newest first)
  results.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
  return results;
}

/**
 * List only active (recently modified) CLI sessions — fast path.
 * Stats all files first, then reads content only for active ones.
 */
export async function listActiveSessions(projectPath: string, projectId: string): Promise<SessionListItem[]> {
  const dir = getSessionDir(projectPath);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    const entries = await readdir(dir);
    files = entries.filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const now = Date.now();
  const linkedTasks = getLinkedTaskIds(projectId);
  const results: SessionListItem[] = [];

  // Phase 1: stat all files to find active ones (cheap)
  const CONCURRENCY = 50;
  const activeFiles: Array<{ file: string; sessionId: string; mtime: Date; size: number }> = [];

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const items = await Promise.all(
      batch.map(async (file) => {
        const sessionId = file.replace('.jsonl', '');
        if (!UUID_REGEX.test(sessionId)) return null;
        try {
          const fileStat = await stat(join(dir, file));
          if (now - fileStat.mtime.getTime() <= ACTIVE_THRESHOLD_MS) {
            return { file, sessionId, mtime: fileStat.mtime, size: fileStat.size };
          }
        } catch { /* skip */ }
        return null;
      })
    );
    for (const item of items) {
      if (item) activeFiles.push(item);
    }
  }

  // Phase 2: read first prompt only for active files
  for (const { file, sessionId, mtime, size } of activeFiles) {
    try {
      const meta = await getFirstUserPrompt(join(dir, file));
      if (!meta) continue;
      results.push({
        sessionId,
        firstPrompt: meta.prompt,
        lastModified: mtime.toISOString(),
        fileSize: size,
        gitBranch: meta.gitBranch,
        linkedTaskId: linkedTasks.get(sessionId),
        isActive: true,
      });
    } catch { /* skip */ }
  }

  results.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
  return results;
}

/**
 * Parse a single session JSONL file into timeline entries.
 */
function parseSessionFile(content: string, idPrefix: string): { entries: SessionTimelineEntry[]; toolUseMap: Map<string, SessionTimelineEntry> } {
  const lines = content.split('\n').filter((l) => l.trim());
  const entries: SessionTimelineEntry[] = [];
  const toolUseMap = new Map<string, SessionTimelineEntry>();
  let counter = 0;

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const type = obj.type as string;
    if (type === 'queue-operation' || type === 'system') continue;

    const timestamp = obj.timestamp
      ? new Date(obj.timestamp as string).getTime()
      : 0;
    const message = obj.message as { role?: string; content?: unknown } | undefined;
    if (!message) continue;

    if (type === 'user') {
      const msgContent = message.content;
      if (typeof msgContent === 'string') {
        entries.push({
          id: `${idPrefix}user-${counter++}`,
          type: 'user_message',
          timestamp,
          content: msgContent,
        });
      } else if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if ((block as Record<string, unknown>).type === 'tool_result') {
            const toolUseId = (block as Record<string, unknown>).tool_use_id as string;
            const blockContent = (block as Record<string, unknown>).content;

            let resultText: string;
            if (typeof blockContent === 'string') {
              resultText = blockContent;
            } else if (Array.isArray(blockContent)) {
              resultText = (blockContent as Array<Record<string, unknown>>)
                .filter((b) => b.type === 'text')
                .map((b) => b.text as string)
                .join('\n');
            } else {
              resultText = JSON.stringify(blockContent);
            }

            const matchingTool = toolUseMap.get(toolUseId);
            if (matchingTool) {
              matchingTool.toolResult = resultText;
            } else {
              entries.push({
                id: `${idPrefix}result-${counter++}`,
                type: 'tool_result',
                timestamp,
                content: '',
                toolResult: resultText,
              });
            }
          }
        }
      }
    } else if (type === 'assistant') {
      const msgContent = message.content;
      if (Array.isArray(msgContent)) {
        for (const block of msgContent as Array<Record<string, unknown>>) {
          if (block.type === 'text') {
            const text = block.text as string;
            if (text.trim()) {
              entries.push({
                id: `${idPrefix}text-${counter++}`,
                type: 'output',
                timestamp,
                content: text,
              });
            }
          } else if (block.type === 'tool_use') {
            const entry: SessionTimelineEntry = {
              id: `${idPrefix}tool-${block.id || counter++}`,
              type: 'tool_use',
              timestamp,
              content: '',
              toolName: block.name as string,
              toolInput: block.input,
            };
            entries.push(entry);
            if (block.id) {
              toolUseMap.set(block.id as string, entry);
            }
          }
        }
      }
    }
  }

  return { entries, toolUseMap };
}

/**
 * Get full session detail with timeline entries.
 * If relatedSessionIds is provided, merges all sessions into a single timeline.
 */
export async function getSessionDetail(
  projectPath: string,
  sessionId: string,
  projectId: string,
  relatedSessionIds?: string[],
): Promise<SessionDetail | null> {
  const dir = getSessionDir(projectPath);
  const idsToLoad = relatedSessionIds && relatedSessionIds.length > 1
    ? relatedSessionIds
    : [sessionId];

  // Validate all IDs
  for (const id of idsToLoad) {
    if (!UUID_REGEX.test(id)) return null;
  }

  // Load and parse all session files
  const allEntries: SessionTimelineEntry[] = [];

  for (const id of idsToLoad) {
    const filePath = join(dir, `${id}.jsonl`);
    if (!existsSync(filePath)) continue;

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const { entries } = parseSessionFile(content, idsToLoad.length > 1 ? `${id.slice(0, 8)}-` : '');
    allEntries.push(...entries);
  }

  if (allEntries.length === 0) return null;

  // Sort by timestamp and deduplicate (same type + content within 1s)
  allEntries.sort((a, b) => a.timestamp - b.timestamp);

  if (idsToLoad.length > 1) {
    const deduped: SessionTimelineEntry[] = [];
    const seen = new Set<string>();
    for (const entry of allEntries) {
      // Key: type + content + rounded timestamp (1s window)
      const tsKey = Math.floor(entry.timestamp / 1000);
      const key = `${entry.type}|${entry.content}|${entry.toolName || ''}|${tsKey}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(entry);
      }
    }
    allEntries.length = 0;
    allEntries.push(...deduped);
  }

  const linkedTasks = getLinkedTaskIds(projectId);

  return {
    sessionId,
    entries: allEntries,
    linkedTaskId: linkedTasks.get(sessionId),
  };
}
