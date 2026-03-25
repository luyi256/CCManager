/**
 * Agent-side session file reader.
 * Reads Claude CLI JSONL session files from ~/.claude/projects/<path-hash>/
 */
import { readdir, readFile, stat } from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { homedir } from 'os';

export interface SessionListItem {
  sessionId: string;
  firstPrompt: string;
  lastModified: string;
  fileSize: number;
  gitBranch?: string;
  isActive?: boolean;
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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function getSessionDir(projectPath: string): string {
  return join(homedir(), '.claude', 'projects', projectPath.replace(/\//g, '-'));
}

async function getFirstUserPrompt(filePath: string): Promise<{ prompt: string; gitBranch?: string } | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    let resolved = false;
    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' && typeof obj.message?.content === 'string') {
          resolved = true;
          rl.close();
          resolve({ prompt: obj.message.content.slice(0, 200), gitBranch: obj.gitBranch });
        }
      } catch { /* skip */ }
    });
    rl.on('close', () => { if (!resolved) resolve(null); });
    rl.on('error', () => { if (!resolved) resolve(null); });
  });
}

export async function listSessions(projectPath: string): Promise<SessionListItem[]> {
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
  const results: SessionListItem[] = [];
  const CONCURRENCY = 20;

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const items = await Promise.all(
      batch.map(async (file) => {
        const sessionId = file.replace('.jsonl', '');
        if (!UUID_REGEX.test(sessionId)) return null;
        const filePath = join(dir, file);
        try {
          const [fileStat, meta] = await Promise.all([stat(filePath), getFirstUserPrompt(filePath)]);
          if (!meta) return null;
          return {
            sessionId,
            firstPrompt: meta.prompt,
            lastModified: fileStat.mtime.toISOString(),
            fileSize: fileStat.size,
            gitBranch: meta.gitBranch,
            isActive: now - fileStat.mtime.getTime() <= ACTIVE_THRESHOLD_MS,
          };
        } catch { return null; }
      })
    );
    for (const item of items) {
      if (item) results.push(item);
    }
  }

  results.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
  return results;
}

/**
 * List only active (recently modified) CLI sessions — fast path.
 */
export async function listActiveSessions(projectPath: string): Promise<SessionListItem[]> {
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
        isActive: true,
      });
    } catch { /* skip */ }
  }

  results.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
  return results;
}

export async function getSessionDetail(projectPath: string, sessionId: string): Promise<SessionTimelineEntry[] | null> {
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
  const toolUseMap = new Map<string, SessionTimelineEntry>();

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line); } catch { continue; }

    const type = obj.type as string;
    if (type === 'queue-operation' || type === 'system') continue;

    const timestamp = obj.timestamp ? new Date(obj.timestamp as string).getTime() : 0;
    const message = obj.message as { content?: unknown } | undefined;
    if (!message) continue;

    if (type === 'user') {
      if (typeof message.content === 'string') {
        entries.push({ id: `user-${counter++}`, type: 'user_message', timestamp, content: message.content });
      } else if (Array.isArray(message.content)) {
        for (const block of message.content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result') {
            const toolUseId = block.tool_use_id as string;
            const bc = block.content;
            const resultText = typeof bc === 'string' ? bc
              : Array.isArray(bc) ? (bc as Array<Record<string, unknown>>).filter(b => b.type === 'text').map(b => b.text as string).join('\n')
              : JSON.stringify(bc);
            const match = toolUseMap.get(toolUseId);
            if (match) { match.toolResult = resultText; }
            else { entries.push({ id: `result-${counter++}`, type: 'tool_result', timestamp, content: '', toolResult: resultText }); }
          }
        }
      }
    } else if (type === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && (block.text as string).trim()) {
          entries.push({ id: `text-${counter++}`, type: 'output', timestamp, content: block.text as string });
        } else if (block.type === 'tool_use') {
          const entry: SessionTimelineEntry = {
            id: `tool-${block.id || counter++}`, type: 'tool_use', timestamp, content: '',
            toolName: block.name as string, toolInput: block.input,
          };
          entries.push(entry);
          if (block.id) toolUseMap.set(block.id as string, entry);
        }
      }
    }
  }

  return entries;
}
