import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { sanitizeEnv } from './security.js';
import type { TaskRequest } from './types.js';

export interface ExecutorEvents {
  output: (text: string) => void;
  tool_use: (data: { id: string; name: string; input: unknown }) => void;
  tool_result: (data: { id: string; result: unknown }) => void;
  plan_question: (data: unknown) => void;
  permission_request: (data: unknown) => void;
  error: (error: Error) => void;
  exit: (code: number | null) => void;
  session_id: (sessionId: string) => void;
}

// Default timeout: 4 hours (in milliseconds)
const DEFAULT_TASK_TIMEOUT = 4 * 60 * 60 * 1000;

export class ClaudeExecutor extends EventEmitter {
  private process: ChildProcess | null = null;
  private currentTaskId: number | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private sessionId: string | null = null;
  private hasStreamedDelta = false; // Track if content_block_delta has emitted text

  constructor(private taskTimeout: number = DEFAULT_TASK_TIMEOUT) {
    super();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async execute(task: TaskRequest, workingDir: string): Promise<void> {
    this.currentTaskId = task.taskId;

    const args = ['-p', task.prompt, '--output-format', 'stream-json', '--verbose'];

    if (task.isPlanMode) {
      args.push('--permission-mode', 'plan');
    }

    if (task.continueSession && task.sessionId) {
      args.push('--resume', task.sessionId);
    }

    args.push('--dangerously-skip-permissions');

    await this.runClaudeCode(args, workingDir);
  }

  private async runClaudeCode(args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use full environment to ensure Claude Code can access credentials
      const env = { ...process.env };

      this.process = spawn('claude', args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Set execution timeout (Bug #25 fix)
      this.timeoutHandle = setTimeout(() => {
        if (this.process) {
          console.error(`Task ${this.currentTaskId} timed out after ${this.taskTimeout}ms`);
          this.emit('error', new Error(`Task execution timed out after ${this.taskTimeout / 1000} seconds`));
          this.cancel();
        }
      }, this.taskTimeout);

      // Close stdin to signal no more input
      this.process.stdin?.end();

      let buffer = '';

      this.process.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          this.parseLine(line);
        }
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        this.emit('output', data.toString());
      });

      this.process.on('error', (error) => {
        this.emit('error', error);
        reject(error);
      });

      this.process.on('exit', (code) => {
        // Clear timeout on exit
        if (this.timeoutHandle) {
          clearTimeout(this.timeoutHandle);
          this.timeoutHandle = null;
        }
        if (buffer.trim()) {
          this.parseLine(buffer);
        }
        this.emit('exit', code);
        this.process = null;
        this.currentTaskId = null;
        resolve();
      });
    });
  }

  private parseLine(line: string): void {
    try {
      const event = JSON.parse(line);

      switch (event.type) {
        case 'assistant':
          if (event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') {
                // Only emit text from assistant if no content_block_delta was received.
                // Normally text comes via content_block_delta (streaming); emitting from
                // both causes duplicate output. This is a fallback for formats that
                // only emit assistant events.
                if (!this.hasStreamedDelta) {
                  this.emit('output', block.text);
                }
              } else if (block.type === 'tool_use') {
                this.emit('tool_use', {
                  id: block.id,
                  name: block.name,
                  input: block.input,
                });
              }
            }
          }
          // Reset delta flag after processing assistant message
          this.hasStreamedDelta = false;
          break;

        case 'content_block_delta':
          if (event.delta?.type === 'text_delta') {
            this.hasStreamedDelta = true;
            this.emit('output', event.delta.text);
          }
          break;

        case 'result':
          // Capture session_id from result event
          if (event.session_id && !this.sessionId) {
            this.sessionId = event.session_id;
            this.emit('session_id', event.session_id);
          }
          // Don't emit result text as output - it duplicates what was already
          // streamed via 'assistant' events
          break;

        case 'user':
          // User input request (plan question, permission, etc.)
          if (event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_result') {
                // Could be a plan question or permission request
                if (block.content?.includes('plan')) {
                  this.emit('plan_question', block);
                } else if (block.content?.includes('permission')) {
                  this.emit('permission_request', block);
                }
              }
            }
          }
          break;

        case 'system':
          // Extract session_id from init message
          if (event.subtype === 'init' && event.session_id) {
            this.sessionId = event.session_id;
            this.emit('session_id', event.session_id);
          }
          break;
      }
    } catch (error) {
      // Non-JSON output, emit as raw text (Bug #21: log parse failures for debugging)
      if (line.startsWith('{') || line.startsWith('[')) {
        console.warn('Failed to parse potential JSON line:', error);
      }
      this.emit('output', line + '\n');
    }
  }

  sendInput(input: string): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(input + '\n');
    }
  }

  cancel(): void {
    // Clear timeout when cancelling
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    if (this.process) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }
  }

  get isRunning(): boolean {
    return this.process !== null;
  }

  get taskId(): number | null {
    return this.currentTaskId;
  }
}
