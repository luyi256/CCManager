/**
 * Agent-side coding CLI session reader.
 *
 * Supported stores:
 * - Claude / Claude Grok: ~/.claude/projects
 * - tClaude: ~/.tclaude/projects
 * - Codex: ~/.codex/sessions
 * - tCodex: ~/.tcodex/sessions
 * - Qwen Code: ~/.qwen/projects/<sanitized-cwd>/chats
 * - Docker Claude: <sessionsDir>/<projectId>/.claude/projects/-workspace
 */
import { createReadStream, existsSync } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import type { Runner } from './runnerModels.js';

export interface SessionListItem {
  sessionId: string;
  runner: Runner;
  model?: string;
  title?: string;
  firstPrompt: string;
  lastModified: string;
  fileSize: number;
  gitBranch?: string;
  isActive?: boolean;
  relatedSessionIds?: string[];
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

export interface SessionSearchMatch {
  message: string;
  entryId: string;
  context: Array<{ type: string; content: string }>;
}

export interface SessionSearchResult extends SessionListItem {
  matches: SessionSearchMatch[];
  matchedMessage: string;
  matchedEntryIndex: number;
  matchedEntryId: string;
}

export interface SessionQueryOptions {
  projectId?: string;
  dockerSessionsDir?: string;
  homeDir?: string;
}

type SessionFormat = 'claude' | 'codex' | 'qwen';

interface SessionFile {
  filePath: string;
  format: SessionFormat;
  runner?: Runner;
  acceptedCwds: string[];
}

interface SessionMetadata {
  sessionId: string;
  runner: Runner;
  model?: string;
  title?: string;
  firstPrompt: string;
  gitBranch?: string;
  cwd?: string;
}

const ACTIVE_THRESHOLD_MS = 120_000;
const SESSION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const TITLE_MAX_LENGTH = 72;
const CODEX_INTERNAL_USER_PREFIXES = [
  '# AGENTS.md instructions for ',
  '<permissions instructions>',
  '<collaboration_mode>',
  '<skills_instructions>',
  '<environment_context>',
];

function isSafeSessionId(sessionId: string): boolean {
  return SESSION_ID_REGEX.test(sessionId);
}

function projectPathToHash(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function cleanTitleText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[#>*\-\d.)\s]+/, '')
    .trim();
}

function buildSessionTitle(firstPrompt: string): string {
  const source = cleanTitleText(firstPrompt);
  if (!source) return 'Untitled session';
  const firstSentence = source.split(/(?<=[.!?。！？])\s+/)[0] || source;
  const withoutLeadIn = firstSentence
    .replace(/^(please|can you|could you|帮我|请|麻烦|我想要?|当前项目)\s*[:,，：-]?\s*/i, '')
    .trim();
  const title = withoutLeadIn || firstSentence;
  return title.length > TITLE_MAX_LENGTH
    ? `${title.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : title;
}

function isCommandMessage(content: string): boolean {
  return /<command-name>/.test(content.trim());
}

function isContinuationMessage(content: string): boolean {
  return content.trimStart().startsWith('This session is being continued from a previous conversation');
}

function cleanClaudeUserMessage(content: string): string | null {
  const trimmed = content.trim();
  if (/^<local-command-caveat>[\s\S]*<\/local-command-caveat>$/.test(trimmed)) return null;
  if (/^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/.test(trimmed)) return null;

  const cmdNameMatch = trimmed.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmdNameMatch) {
    const cmdMsgMatch = trimmed.match(/<command-message>([^<]+)<\/command-message>/);
    const rawCmd = cmdMsgMatch ? cmdMsgMatch[1].trim() : cmdNameMatch[1].trim();
    const cmd = rawCmd.replace(/^\/+/, '');
    const argsMatch = trimmed.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const args = argsMatch?.[1]?.trim();
    return args ? `/${cmd} ${args}` : `/${cmd}`;
  }

  const taskNotifMatch = trimmed.match(/<task-notification>[\s\S]*?<summary>([^<]+)<\/summary>[\s\S]*?<\/task-notification>/);
  if (taskNotifMatch) return `[Task] ${taskNotifMatch[1].trim()}`;
  if (isContinuationMessage(trimmed)) return '[Continued from previous session]';

  let cleaned = content;
  cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  cleaned = cleaned.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  cleaned = cleaned.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '');
  cleaned = cleaned.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '');
  cleaned = cleaned.replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g, '');
  cleaned = cleaned.replace(/<command-message>[\s\S]*?<\/command-message>/g, '');
  cleaned = cleaned.replace(/<command-name>[\s\S]*?<\/command-name>/g, '');
  cleaned = cleaned.replace(/<command-args>[\s\S]*?<\/command-args>/g, '');
  cleaned = cleaned.replace(/<([a-z][\w-]*)>[\s\S]*?<\/\1>/g, '');
  cleaned = cleaned.replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/g, '');
  cleaned = cleaned.trim();
  return cleaned || null;
}

function textFromParts(parts: unknown, role: 'user' | 'assistant'): string {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part): part is Record<string, unknown> => !!part && typeof part === 'object')
    .filter((part) => role === 'user' || part.thought !== true)
    .map((part) => typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

function normalizeGrokModel(model: string): string {
  return model.match(/(grok(?:-[A-Za-z0-9.]+)+)$/i)?.[1] || model;
}

function inferClaudeRunner(model: string | undefined, fixedRunner?: Runner): Runner {
  if (fixedRunner) return fixedRunner;
  return model && /(?:^|[/_-])(grok|xai)(?:[/_.-]|$)/i.test(model)
    ? 'claude-grok'
    : 'claude';
}

function belongsToProject(cwd: string | undefined, acceptedCwds: string[]): boolean {
  if (!cwd) return true;
  const resolvedCwd = resolve(cwd);
  return acceptedCwds.some((candidate) => {
    const root = resolve(candidate);
    return resolvedCwd === root ||
      resolvedCwd.startsWith(`${root}/.worktrees/`) ||
      resolvedCwd.startsWith(`${root}/.qwen/worktrees/`);
  });
}

async function readHeadLines(filePath: string, maxLines = 160): Promise<string[]> {
  return new Promise((resolveLines) => {
    const lines: string[] = [];
    const stream = createReadStream(filePath);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      rl.close();
      stream.destroy();
      resolveLines(lines);
    };
    rl.on('line', (line) => {
      lines.push(line);
      if (lines.length >= maxLines) finish();
    });
    rl.on('close', finish);
    rl.on('error', finish);
  });
}

function parseJsonLines(lines: string[]): Array<Record<string, any>> {
  const records: Array<Record<string, any>> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') records.push(parsed);
    } catch {
      // Ignore partially written or legacy malformed lines.
    }
  }
  return records;
}

function parseClaudeMetadata(records: Array<Record<string, any>>, fixedRunner?: Runner): SessionMetadata | null {
  let sessionId = '';
  let firstPrompt = '';
  let fallbackPrompt = '';
  let gitBranch: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let title: string | undefined;

  for (const obj of records) {
    sessionId ||= typeof obj.sessionId === 'string' ? obj.sessionId : '';
    cwd ||= typeof obj.cwd === 'string' ? obj.cwd : undefined;
    gitBranch ||= typeof obj.gitBranch === 'string' ? obj.gitBranch : undefined;
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') title = obj.aiTitle;
    if (obj.type === 'assistant') {
      const candidate = obj.message?.model ?? obj.model;
      if (typeof candidate === 'string' && candidate !== '<synthetic>') model ||= candidate;
    }
    if (obj.type === 'user' && typeof obj.message?.content === 'string') {
      const raw = obj.message.content as string;
      const cleaned = cleanClaudeUserMessage(raw);
      if (!cleaned) continue;
      if (isCommandMessage(raw) || isContinuationMessage(raw)) {
        fallbackPrompt ||= cleaned;
      } else {
        firstPrompt ||= cleaned;
      }
    }
  }

  firstPrompt ||= fallbackPrompt;
  if (!sessionId || !firstPrompt) return null;
  const runner = inferClaudeRunner(model, fixedRunner);
  return {
    sessionId,
    runner,
    model: runner === 'claude-grok' && model ? normalizeGrokModel(model) : model,
    title: title || buildSessionTitle(firstPrompt),
    firstPrompt: firstPrompt.slice(0, 200),
    gitBranch,
    cwd,
  };
}

function parseQwenMetadata(records: Array<Record<string, any>>): SessionMetadata | null {
  let sessionId = '';
  let firstPrompt = '';
  let gitBranch: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let title: string | undefined;

  for (const obj of records) {
    sessionId ||= typeof obj.sessionId === 'string' ? obj.sessionId : '';
    cwd ||= typeof obj.cwd === 'string' ? obj.cwd : undefined;
    gitBranch ||= typeof obj.gitBranch === 'string' ? obj.gitBranch : undefined;
    if (obj.type === 'system' && obj.subtype === 'custom_title' && typeof obj.systemPayload?.customTitle === 'string') {
      title = obj.systemPayload.customTitle;
    }
    if (obj.type === 'system' && obj.subtype === 'session_model' && typeof obj.systemPayload?.modelId === 'string') {
      model = obj.systemPayload.modelId;
    }
    if (obj.type === 'assistant' && typeof obj.model === 'string') model ||= obj.model;
    if (obj.type === 'user') {
      const prompt = obj.subtype === 'user_prompt' && typeof obj.systemPayload?.displayText === 'string'
        ? obj.systemPayload.displayText
        : textFromParts(obj.message?.parts, 'user');
      if (prompt.trim()) firstPrompt ||= prompt.trim();
    }
  }

  if (!sessionId || !firstPrompt) return null;
  return {
    sessionId,
    runner: 'qwen',
    model,
    title: title || buildSessionTitle(firstPrompt),
    firstPrompt: firstPrompt.slice(0, 200),
    gitBranch,
    cwd,
  };
}

function isCodexInternalUserMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return CODEX_INTERNAL_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function codexMessageText(payload: Record<string, any>): string {
  if (typeof payload.message === 'string') return payload.message;
  if (!Array.isArray(payload.content)) return '';
  return payload.content
    .filter((item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n');
}

function parseCodexMetadata(records: Array<Record<string, any>>, runner: 'codex' | 'tcodex'): SessionMetadata | null {
  let sessionId = '';
  let firstPrompt = '';
  let fallbackPrompt = '';
  let gitBranch: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;

  for (const obj of records) {
    const payload = obj.payload || {};
    if (obj.type === 'session_meta') {
      sessionId ||= payload.session_id || payload.id || '';
      cwd ||= typeof payload.cwd === 'string' ? payload.cwd : undefined;
      gitBranch ||= typeof payload.git?.branch === 'string' ? payload.git.branch : undefined;
    } else if (obj.type === 'turn_context') {
      model ||= typeof payload.model === 'string' ? payload.model : undefined;
    } else if (obj.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
      firstPrompt ||= payload.message.trim();
    } else if (obj.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      const text = codexMessageText(payload).trim();
      if (text && !isCodexInternalUserMessage(text)) fallbackPrompt ||= text;
    }
  }

  firstPrompt ||= fallbackPrompt;
  if (!sessionId || !firstPrompt) return null;
  return {
    sessionId,
    runner,
    model,
    title: buildSessionTitle(firstPrompt),
    firstPrompt: firstPrompt.slice(0, 200),
    gitBranch,
    cwd,
  };
}

function parseMetadata(format: SessionFormat, records: Array<Record<string, any>>, runner?: Runner): SessionMetadata | null {
  if (format === 'claude') return parseClaudeMetadata(records, runner);
  if (format === 'qwen') return parseQwenMetadata(records);
  return parseCodexMetadata(records, runner === 'tcodex' ? 'tcodex' : 'codex');
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

async function collectProjectStoreFiles(
  baseDir: string,
  projectPath: string,
  format: 'claude' | 'qwen',
  runner?: Runner,
  acceptedCwds = [projectPath],
): Promise<SessionFile[]> {
  if (!existsSync(baseDir)) return [];
  const hash = projectPathToHash(projectPath);
  const candidateDirs = (await listDirectories(baseDir)).filter((dir) => {
    const name = basename(dir);
    return name === hash || name.startsWith(`${hash}-`) || name.endsWith(hash.split('-').slice(-2).join('-'));
  });
  const results: SessionFile[] = [];
  for (const candidate of candidateDirs) {
    const sessionDir = format === 'qwen' ? join(candidate, 'chats') : candidate;
    try {
      const entries = await readdir(sessionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.endsWith('.ledger.jsonl')) {
          results.push({ filePath: join(sessionDir, entry.name), format, runner, acceptedCwds });
        }
      }
    } catch {
      // Optional store is absent or unreadable.
    }
  }
  return results;
}

async function collectCodexFiles(root: string, runner: 'codex' | 'tcodex', acceptedCwds: string[]): Promise<SessionFile[]> {
  const sessionsRoot = join(root, 'sessions');
  if (!existsSync(sessionsRoot)) return [];
  const results: SessionFile[] = [];
  const stack = [sessionsRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        results.push({ filePath: child, format: 'codex', runner, acceptedCwds });
      }
    }
  }
  return results;
}

async function discoverSessionFiles(projectPath: string, options: SessionQueryOptions = {}): Promise<SessionFile[]> {
  const home = options.homeDir || homedir();
  const acceptedCwds = [projectPath];
  const claudeHome = options.homeDir
    ? join(home, '.claude')
    : process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const qwenHome = options.homeDir
    ? join(home, '.qwen')
    : process.env.QWEN_RUNTIME_DIR || process.env.QWEN_HOME || join(home, '.qwen');
  // `tcodex` launchers commonly export CODEX_HOME themselves. The long-lived
  // manager agent must not let an inherited CODEX_HOME collapse the two stores.
  const codexHome = join(home, '.codex');
  const tcodexHome = options.homeDir
    ? join(home, '.tcodex')
    : process.env.TCODEX_HOME || join(home, '.tcodex');
  const files = [
    ...await collectProjectStoreFiles(join(claudeHome, 'projects'), projectPath, 'claude'),
    ...await collectProjectStoreFiles(join(home, '.tclaude', 'projects'), projectPath, 'claude', 'tclaude'),
    ...await collectProjectStoreFiles(join(qwenHome, 'projects'), projectPath, 'qwen', 'qwen'),
    ...await collectCodexFiles(codexHome, 'codex', acceptedCwds),
    ...await collectCodexFiles(tcodexHome, 'tcodex', acceptedCwds),
  ];

  if (options.projectId) {
    const dockerHome = join(
      options.dockerSessionsDir || join(home, '.ccm-sessions'),
      options.projectId,
    );
    files.push(...await collectProjectStoreFiles(
      join(dockerHome, '.claude', 'projects'),
      '/workspace',
      'claude',
      'claude',
      [projectPath, '/workspace'],
    ));
  }

  return files;
}

async function loadSessionMetadata(source: SessionFile): Promise<SessionMetadata | null> {
  const metadata = parseMetadata(source.format, parseJsonLines(await readHeadLines(source.filePath)), source.runner);
  if (!metadata || !isSafeSessionId(metadata.sessionId) || !belongsToProject(metadata.cwd, source.acceptedCwds)) return null;
  return metadata;
}

export async function listSessions(projectPath: string, options: SessionQueryOptions = {}): Promise<SessionListItem[]> {
  const files = await discoverSessionFiles(projectPath, options);
  const now = Date.now();
  const results: SessionListItem[] = [];
  const concurrency = 20;

  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const items = await Promise.all(batch.map(async (source) => {
      try {
        const [fileStat, metadata] = await Promise.all([
          stat(source.filePath),
          loadSessionMetadata(source),
        ]);
        if (!metadata) return null;
        return {
          sessionId: metadata.sessionId,
          runner: metadata.runner,
          model: metadata.model,
          title: metadata.title,
          firstPrompt: metadata.firstPrompt,
          lastModified: fileStat.mtime.toISOString(),
          fileSize: Number(fileStat.size),
          gitBranch: metadata.gitBranch,
          isActive: now - fileStat.mtime.getTime() <= ACTIVE_THRESHOLD_MS,
        } satisfies SessionListItem;
      } catch {
        return null;
      }
    }));
    for (const item of items) if (item) results.push(item);
  }

  const deduped = new Map<string, SessionListItem>();
  for (const item of results) {
    const key = `${item.runner}:${item.sessionId}`;
    const previous = deduped.get(key);
    if (!previous || new Date(item.lastModified).getTime() > new Date(previous.lastModified).getTime()) {
      deduped.set(key, item);
    }
  }
  return Array.from(deduped.values())
    .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
}

export async function listActiveSessions(projectPath: string, options: SessionQueryOptions = {}): Promise<SessionListItem[]> {
  const files = await discoverSessionFiles(projectPath, options);
  const cutoff = Date.now() - ACTIVE_THRESHOLD_MS;
  const recent: Array<{ source: SessionFile; mtime: Date; size: number }> = [];
  const statConcurrency = 50;

  for (let i = 0; i < files.length; i += statConcurrency) {
    const batch = files.slice(i, i + statConcurrency);
    const stats = await Promise.all(batch.map(async (source) => {
      try {
        const fileStat = await stat(source.filePath);
        return fileStat.mtime.getTime() >= cutoff
          ? { source, mtime: fileStat.mtime, size: fileStat.size }
          : null;
      } catch {
        return null;
      }
    }));
    for (const item of stats) if (item) recent.push(item);
  }

  const results: SessionListItem[] = [];
  for (const item of recent) {
    const metadata = await loadSessionMetadata(item.source);
    if (!metadata) continue;
    results.push({
      sessionId: metadata.sessionId,
      runner: metadata.runner,
      model: metadata.model,
      title: metadata.title,
      firstPrompt: metadata.firstPrompt,
      lastModified: item.mtime.toISOString(),
      fileSize: item.size,
      gitBranch: metadata.gitBranch,
      isActive: true,
    });
  }
  return results.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
}

function pushTextEntry(
  entries: SessionTimelineEntry[],
  id: string,
  type: 'output' | 'user_message',
  timestamp: number,
  content: string,
): void {
  const trimmed = content.trim();
  if (trimmed) entries.push({ id, type, timestamp, content: trimmed });
}

function parseClaudeTimeline(records: Array<Record<string, any>>, idPrefix: string): SessionTimelineEntry[] {
  const entries: SessionTimelineEntry[] = [];
  const toolUseMap = new Map<string, SessionTimelineEntry>();
  let counter = 0;
  for (const obj of records) {
    if (obj.type === 'queue-operation' || obj.type === 'system') continue;
    const timestamp = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
    const message = obj.message;
    if (!message) continue;
    if (obj.type === 'user') {
      if (typeof message.content === 'string') {
        const cleaned = cleanClaudeUserMessage(message.content);
        if (cleaned) pushTextEntry(entries, `${idPrefix}user-${counter++}`, 'user_message', timestamp, cleaned);
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type !== 'tool_result') continue;
          const result = typeof block.content === 'string'
            ? block.content
            : textFromParts(block.content, 'user') || JSON.stringify(block.content);
          const matching = toolUseMap.get(block.tool_use_id);
          if (matching) matching.toolResult = result;
          else entries.push({
            id: `${idPrefix}result-${counter++}`,
            type: 'tool_result',
            timestamp,
            content: '',
            toolName: 'tool',
            toolResult: result,
          });
        }
      }
    } else if (obj.type === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'text') {
          pushTextEntry(entries, `${idPrefix}text-${counter++}`, 'output', timestamp, block.text || '');
        } else if (block?.type === 'tool_use') {
          const entry: SessionTimelineEntry = {
            id: `${idPrefix}tool-${block.id || counter++}`,
            type: 'tool_use',
            timestamp,
            content: '',
            toolName: block.name,
            toolInput: block.input,
          };
          entries.push(entry);
          if (block.id) toolUseMap.set(block.id, entry);
        }
      }
    }
  }
  return entries;
}

function qwenToolResultText(obj: Record<string, any>): unknown {
  const display = obj.toolCallResult?.resultDisplay;
  if (display !== undefined) return display;
  const parts = obj.message?.parts;
  if (!Array.isArray(parts)) return '';
  const response = parts.find((part: Record<string, any>) => part?.functionResponse)?.functionResponse;
  return response?.response?.output ?? response?.response ?? response ?? '';
}

function parseQwenTimeline(records: Array<Record<string, any>>, idPrefix: string): SessionTimelineEntry[] {
  const entries: SessionTimelineEntry[] = [];
  const toolUseMap = new Map<string, SessionTimelineEntry>();
  let counter = 0;
  for (const obj of records) {
    const timestamp = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
    if (obj.type === 'user') {
      const text = obj.subtype === 'user_prompt' && typeof obj.systemPayload?.displayText === 'string'
        ? obj.systemPayload.displayText
        : textFromParts(obj.message?.parts, 'user');
      pushTextEntry(entries, `${idPrefix}user-${counter++}`, 'user_message', timestamp, text);
    } else if (obj.type === 'assistant') {
      for (const part of Array.isArray(obj.message?.parts) ? obj.message.parts : []) {
        if (typeof part?.text === 'string' && part.thought !== true) {
          pushTextEntry(entries, `${idPrefix}text-${counter++}`, 'output', timestamp, part.text);
        } else if (part?.functionCall) {
          const call = part.functionCall;
          const id = call.id || obj.uuid || `${idPrefix}qwen-${counter++}`;
          const entry: SessionTimelineEntry = {
            id: `${idPrefix}tool-${id}`,
            type: 'tool_use',
            timestamp,
            content: '',
            toolName: call.name,
            toolInput: call.args,
          };
          entries.push(entry);
          toolUseMap.set(id, entry);
        }
      }
    } else if (obj.type === 'tool_result') {
      const callId = obj.toolCallResult?.callId ||
        (Array.isArray(obj.message?.parts) ? obj.message.parts.find((part: Record<string, any>) => part?.functionResponse)?.functionResponse?.id : undefined);
      const result = qwenToolResultText(obj);
      const matching = callId ? toolUseMap.get(callId) : undefined;
      if (matching) matching.toolResult = result;
      else entries.push({
        id: `${idPrefix}result-${callId || counter++}`,
        type: 'tool_result',
        timestamp,
        content: '',
        toolName: 'tool',
        toolResult: result,
      });
    }
  }
  return entries;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseCodexTimeline(records: Array<Record<string, any>>, idPrefix: string): SessionTimelineEntry[] {
  const entries: SessionTimelineEntry[] = [];
  const eventUserMessages = new Set(records
    .filter((obj) => obj.type === 'event_msg' && obj.payload?.type === 'user_message' && typeof obj.payload.message === 'string')
    .map((obj) => obj.payload.message.trim()));
  const responseAssistantMessages = new Set(records
    .filter((obj) => obj.type === 'response_item' && obj.payload?.type === 'message' && obj.payload.role === 'assistant')
    .map((obj) => codexMessageText(obj.payload).trim())
    .filter(Boolean));
  const toolUseMap = new Map<string, SessionTimelineEntry>();
  let counter = 0;

  for (const obj of records) {
    const payload = obj.payload || {};
    const timestamp = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
    if (obj.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
      const text = payload.message.trim();
      if (text) {
        pushTextEntry(entries, `${idPrefix}user-${counter++}`, 'user_message', timestamp, text);
      }
    } else if (obj.type === 'response_item' && payload.type === 'message') {
      const text = codexMessageText(payload).trim();
      if (!text) continue;
      if (payload.role === 'assistant') {
        pushTextEntry(entries, `${idPrefix}text-${counter++}`, 'output', timestamp, text);
      } else if (
        payload.role === 'user' &&
        eventUserMessages.size === 0 &&
        !isCodexInternalUserMessage(text)
      ) {
        pushTextEntry(entries, `${idPrefix}user-${counter++}`, 'user_message', timestamp, text);
      }
    } else if (obj.type === 'event_msg' && payload.type === 'agent_message' && typeof payload.message === 'string') {
      if (!responseAssistantMessages.has(payload.message.trim())) {
        pushTextEntry(entries, `${idPrefix}text-${counter++}`, 'output', timestamp, payload.message);
      }
    } else if (obj.type === 'response_item' && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
      const callId = payload.call_id || payload.id || `codex-${counter++}`;
      const entry: SessionTimelineEntry = {
        id: `${idPrefix}tool-${callId}`,
        type: 'tool_use',
        timestamp,
        content: '',
        toolName: payload.name || 'tool',
        toolInput: parseMaybeJson(payload.arguments ?? payload.input),
      };
      entries.push(entry);
      toolUseMap.set(callId, entry);
    } else if (obj.type === 'response_item' && (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')) {
      const callId = payload.call_id || payload.id;
      const result = parseMaybeJson(payload.output);
      const matching = callId ? toolUseMap.get(callId) : undefined;
      if (matching) matching.toolResult = result;
      else {
        entries.push({
          id: `${idPrefix}result-${callId || counter++}`,
          type: 'tool_result',
          timestamp,
          content: '',
          toolName: payload.name || 'tool',
          toolResult: result,
        });
      }
    }
  }
  return entries;
}

function parseTimeline(source: SessionFile, content: string, idPrefix: string): SessionTimelineEntry[] {
  const records = parseJsonLines(content.split('\n'));
  if (source.format === 'claude') return parseClaudeTimeline(records, idPrefix);
  if (source.format === 'qwen') return parseQwenTimeline(records, idPrefix);
  return parseCodexTimeline(records, idPrefix);
}

async function findSessionFiles(
  projectPath: string,
  runner: Runner,
  sessionIds: string[],
  options: SessionQueryOptions,
): Promise<Map<string, SessionFile>> {
  const wanted = new Set(sessionIds);
  const result = new Map<string, SessionFile>();
  const sources = await discoverSessionFiles(projectPath, options);
  for (const source of sources) {
    if (source.runner && source.runner !== runner) continue;
    if (source.format !== 'codex') {
      const id = basename(source.filePath).replace(/\.jsonl$/, '');
      if (!wanted.has(id)) continue;
    }
    const metadata = await loadSessionMetadata(source);
    if (metadata?.runner === runner && wanted.has(metadata.sessionId)) result.set(metadata.sessionId, source);
  }
  return result;
}

export async function getSessionDetail(
  projectPath: string,
  runner: Runner,
  sessionId: string,
  relatedSessionIds?: string[],
  options: SessionQueryOptions = {},
): Promise<SessionTimelineEntry[] | null> {
  const idsToLoad = relatedSessionIds?.length ? relatedSessionIds : [sessionId];
  if (idsToLoad.some((id) => !isSafeSessionId(id))) return null;
  const sources = await findSessionFiles(projectPath, runner, idsToLoad, options);
  const allEntries: SessionTimelineEntry[] = [];
  for (const id of idsToLoad) {
    const source = sources.get(id);
    if (!source) continue;
    try {
      const content = await readFile(source.filePath, 'utf8');
      allEntries.push(...parseTimeline(source, content, idsToLoad.length > 1 ? `${id.slice(0, 8)}-` : ''));
    } catch {
      // Skip unreadable files in a merged chain.
    }
  }
  if (allEntries.length === 0) return null;
  allEntries.sort((a, b) => a.timestamp - b.timestamp);
  return allEntries;
}

export async function searchSessions(
  projectPath: string,
  query: string,
  options: SessionQueryOptions = {},
): Promise<SessionSearchResult[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const sources = await discoverSessionFiles(projectPath, options);
  const projectSources: Array<{
    source: SessionFile;
    metadata: SessionMetadata;
    fileStat: Awaited<ReturnType<typeof stat>>;
  }> = [];
  const metadataConcurrency = 20;
  for (let i = 0; i < sources.length; i += metadataConcurrency) {
    const batch = sources.slice(i, i + metadataConcurrency);
    const items = await Promise.all(batch.map(async (source) => {
      try {
        const [metadata, fileStat] = await Promise.all([
          loadSessionMetadata(source),
          stat(source.filePath),
        ]);
        return metadata ? { source, metadata, fileStat } : null;
      } catch {
        return null;
      }
    }));
    for (const item of items) if (item) projectSources.push(item);
  }

  const results: SessionSearchResult[] = [];
  const concurrency = 8;

  for (let i = 0; i < projectSources.length; i += concurrency) {
    const batch = projectSources.slice(i, i + concurrency);
    const matches = await Promise.all(batch.map(async ({ source, metadata, fileStat }) => {
      try {
        const content = await readFile(source.filePath, 'utf8');
        if (!content.toLowerCase().includes(q)) return null;
        const records = parseJsonLines(content.split('\n'));
        const entries = source.format === 'claude'
          ? parseClaudeTimeline(records, '')
          : source.format === 'qwen'
            ? parseQwenTimeline(records, '')
            : parseCodexTimeline(records, '');
        const found: SessionSearchMatch[] = [];
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];
          if (entry.type !== 'user_message' || !entry.content.toLowerCase().includes(q)) continue;
          const context: Array<{ type: string; content: string }> = [];
          for (let before = index - 1; before >= Math.max(0, index - 3); before--) {
            if (entries[before].type === 'tool_use' || entries[before].type === 'tool_result') continue;
            context.unshift({ type: entries[before].type, content: entries[before].content.slice(0, 200) });
            break;
          }
          for (let after = index + 1; after < Math.min(entries.length, index + 4); after++) {
            if (entries[after].type === 'tool_use' || entries[after].type === 'tool_result') continue;
            context.push({ type: entries[after].type, content: entries[after].content.slice(0, 200) });
            break;
          }
          found.push({ message: entry.content.slice(0, 300), entryId: entry.id, context });
        }
        if (found.length === 0) return null;
        return {
          sessionId: metadata.sessionId,
          runner: metadata.runner,
          model: metadata.model,
          title: metadata.title,
          firstPrompt: metadata.firstPrompt,
          lastModified: fileStat.mtime.toISOString(),
          fileSize: Number(fileStat.size),
          gitBranch: metadata.gitBranch,
          isActive: Date.now() - fileStat.mtime.getTime() <= ACTIVE_THRESHOLD_MS,
          matches: found,
          matchedMessage: found[0].message,
          matchedEntryIndex: 0,
          matchedEntryId: found[0].entryId,
        } satisfies SessionSearchResult;
      } catch {
        return null;
      }
    }));
    for (const match of matches) if (match) results.push(match);
  }
  const deduped = new Map<string, SessionSearchResult>();
  for (const result of results) {
    const key = `${result.runner}:${result.sessionId}`;
    const previous = deduped.get(key);
    if (!previous || new Date(result.lastModified).getTime() > new Date(previous.lastModified).getTime()) {
      deduped.set(key, result);
    }
  }
  return Array.from(deduped.values())
    .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
}
