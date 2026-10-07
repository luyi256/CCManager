import type { StoredTaskLog } from './storage.js';
import type { Runner, Task } from '../types/index.js';

const RUNNER_LABELS: Record<Runner, string> = {
  claude: 'Claude',
  'claude-grok': 'Claude Grok',
  codex: 'Codex',
  cursor: 'Cursor',
  qwen: 'Qwen',
  tclaude: 'tClaude',
  tcodex: 'tCodex',
};

/** Keeps the handed-off prompt well inside every runner's context window. */
const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_FIRST_TURN_CHARS = 8_000;
const MAX_TURN_CHARS = 20_000;

/** The web UI recognizes handed-off prompts by this line. */
export const HANDOFF_CONTEXT_PREFIX = 'Context: this continues CCManager task #';

interface Turn {
  role: 'User' | 'Assistant';
  text: string;
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  return '';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[... truncated ...]` : text;
}

export function conversationTurns(task: Pick<Task, 'prompt'>, logs: StoredTaskLog[]): Turn[] {
  const turns: Turn[] = [{ role: 'User', text: task.prompt }];
  for (const log of logs) {
    if (log.type === 'user_message') {
      const text = userText(log.content).trim();
      if (text) turns.push({ role: 'User', text });
    } else if (log.type === 'output' && typeof log.content === 'string' && log.content.trim()) {
      const last = turns[turns.length - 1];
      // Streamed output is stored in chunks; one assistant turn reads better.
      if (last.role === 'Assistant') last.text += log.content;
      else turns.push({ role: 'Assistant', text: log.content });
    }
  }
  return turns;
}

function renderTurn(turn: Turn, max: number): string {
  return `[${turn.role}]\n${clip(turn.text.trim(), max)}`;
}

/** Renders the conversation, keeping the first request and the latest turns. */
export function renderTranscript(turns: Turn[], maxChars = MAX_TRANSCRIPT_CHARS): string {
  const first = renderTurn(turns[0], MAX_FIRST_TURN_CHARS);
  const rest = turns.slice(1).map((turn) => renderTurn(turn, MAX_TURN_CHARS));
  const kept: string[] = [];
  // Leave room for the "earlier messages omitted" line.
  let used = first.length + 64;
  for (let index = rest.length - 1; index >= 0; index--) {
    if (used + rest[index].length + 2 > maxChars) break;
    kept.unshift(rest[index]);
    used += rest[index].length + 2;
  }
  const omitted = rest.length - kept.length;
  return [
    first,
    ...(omitted > 0 ? [`[... ${omitted} earlier message${omitted === 1 ? '' : 's'} omitted ...]`] : []),
    ...kept,
  ].join('\n\n');
}

export function buildHandoffPrompt(
  task: Pick<Task, 'id' | 'prompt' | 'runner' | 'model'>,
  logs: StoredTaskLog[],
  message: string,
): string {
  const source = `${RUNNER_LABELS[task.runner ?? 'claude']}${task.model ? ` (${task.model})` : ''}`;
  return [
    message,
    '',
    '---',
    `${HANDOFF_CONTEXT_PREFIX}${task.id}, which ran on ${source}. ` +
      'The earlier conversation is below with tool calls omitted. Treat it as background: ' +
      're-check the repository instead of assuming its claims still hold, then respond to the message above.',
    '',
    '<previous_conversation>',
    renderTranscript(conversationTurns(task, logs)),
    '</previous_conversation>',
  ].join('\n');
}
