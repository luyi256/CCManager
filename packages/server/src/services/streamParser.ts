import { EventEmitter } from 'events';
import type { StreamMessage, PlanQuestion, PermissionRequest } from '../types/index.js';

export interface ParsedEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'plan_question' | 'permission_request' | 'completed' | 'failed' | 'waiting';
  data: unknown;
}

export class StreamParser extends EventEmitter {
  private buffer = '';
  private currentText = '';

  processChunk(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    try {
      const msg: StreamMessage = JSON.parse(line);

      if (msg.type === 'stream_event' && msg.event) {
        this.processEvent(msg.event);
      }
    } catch {
      // Not JSON, might be raw output - check for WAITING pattern
      this.checkForWaiting(line);
    }
  }

  private processEvent(event: StreamMessage['event']): void {
    if (!event) return;

    // Text content
    if (event.delta?.type === 'text_delta' && event.delta.text) {
      this.currentText += event.delta.text;
      this.emit('event', { type: 'text', data: { text: event.delta.text } });

      // Check for WAITING marker in accumulated text
      this.checkForWaiting(this.currentText);

      // Check for plan question pattern
      this.checkForPlanQuestion(event.delta.text);
    }

    // Tool use
    if (event.content_block?.type === 'tool_use') {
      const { id, name, input } = event.content_block;

      // Check for AskUserQuestion (Plan mode)
      if (name === 'AskUserQuestion') {
        const question = this.parseAskUserQuestion(input);
        if (question) {
          this.emit('event', { type: 'plan_question', data: question });
        }
      } else {
        this.emit('event', {
          type: 'tool_use',
          data: { id, name, input },
        });
      }
    }

    // Message end
    if (event.delta?.stop_reason === 'end_turn') {
      this.emit('event', { type: 'completed', data: {} });
    }
  }

  private parseAskUserQuestion(input: unknown): PlanQuestion | null {
    if (!input || typeof input !== 'object') return null;

    const data = input as Record<string, unknown>;
    const questions = data.questions as Array<{
      question: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;

    if (!questions || !Array.isArray(questions) || questions.length === 0) return null;

    const q = questions[0];
    return {
      id: `q_${Date.now()}`,
      question: q.question,
      options: q.options || [],
      multiSelect: q.multiSelect,
    };
  }

  private checkForWaiting(text: string): void {
    const waitingPattern = /\[WAITING\]([\s\S]*?)\[\/WAITING\]/;
    const match = text.match(waitingPattern);

    if (match) {
      const content = match[1];
      const reason = content.match(/reason:\s*(.+)/)?.[1]?.trim();
      const checkAfter = content.match(/check_after:\s*(.+)/)?.[1]?.trim();
      const checkCommand = content.match(/check_command:\s*(.+)/)?.[1]?.trim();

      if (reason && checkAfter) {
        this.emit('event', {
          type: 'waiting',
          data: { reason, checkAfter, checkCommand },
        });
      }
    }
  }

  private checkForPlanQuestion(text: string): void {
    // Additional pattern matching for interactive questions
    // This handles cases where Claude asks questions without using AskUserQuestion tool
  }

  flush(): void {
    if (this.buffer.trim()) {
      this.parseLine(this.buffer);
      this.buffer = '';
    }
  }

  reset(): void {
    this.buffer = '';
    this.currentText = '';
  }
}

export function parseWaitDuration(duration: string): number {
  const match = duration.match(/^(\d+)(m|h|s)?$/);
  if (!match) return 5 * 60 * 1000; // Default 5 minutes

  const value = parseInt(match[1], 10);
  const unit = match[2] || 'm';

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    default:
      return value * 60 * 1000;
  }
}
