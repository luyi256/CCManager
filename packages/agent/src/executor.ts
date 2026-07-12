import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sanitizeEnv } from './security.js';
import type { TaskRequest } from './types.js';

/**
 * Parse a skill/slash command from a prompt.
 * Detects /xxx [args] pattern at the start of the prompt.
 * Returns null if the prompt is not a skill command.
 */
export function parseSkillCommand(prompt: string): { skill: string; args?: string } | null {
  const trimmed = prompt.trim();
  const match = trimmed.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    skill: match[1],
    args: match[2]?.trim() || undefined,
  };
}

/**
 * If the prompt is a /skill command, convert it to an explicit Skill tool
 * invocation prompt so Claude reliably triggers the Skill tool in non-interactive mode.
 * Returns the original prompt unchanged if it's not a skill command.
 */
export function resolveSkillPrompt(prompt: string): string {
  const skill = parseSkillCommand(prompt);
  if (!skill) return prompt;
  return skill.args
    ? `Run the /${skill.skill} skill with args: ${skill.args}`
    : `Run the /${skill.skill} skill`;
}

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
  private tempImageFiles: string[] = [];
  private collectedOutput = ''; // Track all output for auth failure detection
  private fatalError: Error | null = null;
  private outputBuffer = '';
  private outputFlushTimer: NodeJS.Timeout | null = null;

  constructor(private taskTimeout: number = DEFAULT_TASK_TIMEOUT, private command = 'claude') {
    super();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async execute(task: TaskRequest, workingDir: string): Promise<void> {
    this.currentTaskId = task.taskId;
    this.tempImageFiles = [];
    this.collectedOutput = '';
    this.hasStreamedDelta = false;
    this.fatalError = null;
    this.outputBuffer = '';
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = null;
    }

    // Save base64 images to temp files so Claude Code can read them
    let prompt = task.prompt;
    if (task.images && task.images.length > 0) {
      const imagePaths: string[] = [];
      for (let i = 0; i < task.images.length; i++) {
        const dataUrl = task.images[i];
        const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) continue;
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const base64Data = match[2];
        const tmpPath = path.join(os.tmpdir(), `ccm-img-${task.taskId}-${i}-${Date.now()}.${ext}`);
        fs.writeFileSync(tmpPath, Buffer.from(base64Data, 'base64'));
        this.tempImageFiles.push(tmpPath);
        imagePaths.push(tmpPath);
      }
      if (imagePaths.length > 0) {
        const pathsList = imagePaths.map(p => `- ${p}`).join('\n');
        prompt = `${prompt}\n\nI've attached ${imagePaths.length} screenshot(s). Please read and analyze them:\n${pathsList}`;
      }
    }

    // Convert /skill commands to explicit skill invocation prompts
    prompt = resolveSkillPrompt(prompt);

    const isContinue = !!(task.continueSession && task.sessionId);

    const args: string[] = [];
    const isQwen = this.command === 'qwen';
    if (isQwen) {
      // Qwen Code deprecated -p/--prompt and rejects it when any positional
      // query is present. Use the positional prompt, and keep --resume attached
      // to its value so older parsers do not treat the session id as a query.
      args.push(prompt);
      args.push('-o', 'stream-json');
    } else {
      args.push('-p', prompt);
      args.push('--output-format', 'stream-json');
    }
    if (!isQwen) {
      args.push('--verbose');
    }

    if (task.model) {
      args.push('--model', task.model);
    }

    if (!isQwen && task.isPlanMode) {
      args.push('--permission-mode', 'plan');
    }

    if (isContinue) {
      if (isQwen) {
        args.push(`--resume=${task.sessionId!}`);
      } else {
        args.push('--resume', task.sessionId!);
      }
    }

    args.push(isQwen ? '--yolo' : '--dangerously-skip-permissions');

    try {
      await this.runClaudeCode(args, workingDir);
    } finally {
      this.cleanupTempImages();
    }
  }

  private cleanupTempImages(): void {
    for (const tmpFile of this.tempImageFiles) {
      try {
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
    this.tempImageFiles = [];
  }

  private async runClaudeCode(args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use full environment to ensure Claude Code can access credentials
      const env = { ...process.env };
      if (this.command === 'qwen') {
        env.QWEN_CODE_SUPPRESS_YOLO_WARNING = '1';
      }

      // Remove CLAUDECODE to prevent "nested session" detection
      delete env.CLAUDECODE;

      // If running as root via sudo, drop privileges to the original user
      // so claude doesn't reject --dangerously-skip-permissions
      const spawnOpts: Parameters<typeof spawn>[2] = {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      };

      if (process.getuid?.() === 0 && process.env.SUDO_UID) {
        const uid = parseInt(process.env.SUDO_UID, 10);
        const gid = parseInt(process.env.SUDO_GID || process.env.SUDO_UID, 10);
        spawnOpts.uid = uid;
        spawnOpts.gid = gid;
        console.log(`Dropping privileges to uid=${uid} gid=${gid} for claude subprocess`);
      }

      this.process = spawn(this.command, args, spawnOpts);

      // Set execution timeout (Bug #25 fix)
      this.timeoutHandle = setTimeout(() => {
        if (this.process) {
          console.error(`Task ${this.currentTaskId} timed out after ${this.taskTimeout}ms`);
          this.emit('error', new Error(`Task execution timed out after ${this.taskTimeout / 1000} seconds`));
          this.cancel();
        }
      }, this.taskTimeout);

      // Non-interactive print mode: close stdin immediately
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
        const text = data.toString();
        this.collectedOutput += text;
        this.emit('output', text);
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

        this.flushOutputBuffer();

        if (this.fatalError) {
          const error = this.fatalError;
          this.process = null;
          this.currentTaskId = null;
          this.fatalError = null;
          reject(error);
          return;
        }

        // Detect auth failure: CLI exited without establishing a session
        // and output contains "Not logged in" indicator
        if (!this.sessionId && /not logged in|please run \/login/i.test(this.collectedOutput)) {
          const authError = new Error(
            'Claude CLI is not logged in on this agent. ' +
            'Run "claude login" on the agent machine, or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN environment variable.'
          );
          this.emit('error', authError);
          this.process = null;
          this.currentTaskId = null;
          reject(authError);
          return;
        }

        if (code !== 0) {
          const error = new Error(`${this.command} exited with code ${code}`);
          this.emit('error', error);
          this.process = null;
          this.currentTaskId = null;
          reject(error);
          return;
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

      // Handle plain JSON string output (e.g. "Not logged in · Please run /login")
      if (typeof event === 'string') {
        this.collectedOutput += event;
        this.emitOutput(event);
        return;
      }

      if (event.type === 'stream_event' && event.event) {
        this.parseEvent(event.event);
        return;
      }

      this.parseEvent(event);
    } catch (error) {
      // Non-JSON output, emit as raw text (Bug #21: log parse failures for debugging)
      if (line.startsWith('{') || line.startsWith('[')) {
        console.warn('Failed to parse potential JSON line:', error);
      }
      this.collectedOutput += line;
      this.emitOutput(line + '\n');
    }
  }

  private emitOutput(text: string): void {
    if (this.command !== 'qwen') {
      this.emit('output', text);
      return;
    }

    this.outputBuffer += text;
    if (text.includes('\n') || this.outputBuffer.length >= 240) {
      this.flushOutputBuffer();
      return;
    }

    if (!this.outputFlushTimer) {
      this.outputFlushTimer = setTimeout(() => this.flushOutputBuffer(), 250);
    }
  }

  private flushOutputBuffer(): void {
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = null;
    }
    if (!this.outputBuffer) return;
    const text = this.outputBuffer;
    this.outputBuffer = '';
    this.emit('output', text);
  }

  private parseEvent(event: any): void {
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
                this.emitOutput(block.text);
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
          this.emitOutput(event.delta.text);
        }
        break;

      case 'content_block_stop':
      case 'message_stop':
        this.flushOutputBuffer();
        break;

      case 'result':
        // Capture session_id from result event
        if (event.session_id && !this.sessionId) {
          this.sessionId = event.session_id;
          this.emit('session_id', event.session_id);
        }
        if (event.is_error || event.subtype?.startsWith('error')) {
          const message =
            event.error?.message ||
            event.result ||
            `${this.command} returned an error result`;
          this.fatalError = new Error(message);
          this.collectedOutput += message;
          this.emitOutput(`[${this.command} Error] ${message}\n`);
          this.flushOutputBuffer();
          this.emit('error', this.fatalError);
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
