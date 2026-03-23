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
}

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
  return projectPath.replace(/\//g, '-');
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
function getLinkedTaskIds(projectId: string): Map<string, number> {
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
 * Get full session detail with timeline entries.
 */
export async function getSessionDetail(projectPath: string, sessionId: string, projectId: string): Promise<SessionDetail | null> {
  if (!UUID_REGEX.test(sessionId)) return null;

  const filePath = join(getSessionDir(projectPath), `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return null;

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n').filter((l) => l.trim());
  const entries: SessionTimelineEntry[] = [];
  let counter = 0;

  // First pass: collect all entries
  const toolUseMap = new Map<string, SessionTimelineEntry>(); // tool_use_id -> entry

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
          id: `user-${counter++}`,
          type: 'user_message',
          timestamp,
          content: msgContent,
        });
      } else if (Array.isArray(msgContent)) {
        // Tool results come as user messages with tool_result blocks
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

            // Pair with matching tool_use
            const matchingTool = toolUseMap.get(toolUseId);
            if (matchingTool) {
              matchingTool.toolResult = resultText;
            } else {
              // Standalone tool_result (shouldn't happen often)
              entries.push({
                id: `result-${counter++}`,
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
                id: `text-${counter++}`,
                type: 'output',
                timestamp,
                content: text,
              });
            }
          } else if (block.type === 'tool_use') {
            const entry: SessionTimelineEntry = {
              id: `tool-${block.id || counter++}`,
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
          // Skip 'thinking' and 'server_tool_use' blocks
        }
      }
    }
  }

  // Lookup linked task
  const linkedTasks = getLinkedTaskIds(projectId);

  return {
    sessionId,
    entries,
    linkedTaskId: linkedTasks.get(sessionId),
  };
}
