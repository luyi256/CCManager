import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TaskRequest } from './types.js';

// Default timeout: 4 hours (in milliseconds)
const DEFAULT_TASK_TIMEOUT = 4 * 60 * 60 * 1000;

export class CodexExecutor extends EventEmitter {
  private process: ChildProcess | null = null;
  private currentTaskId: number | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private sessionId: string | null = null;
  private tempImageFiles: string[] = [];

  constructor(private taskTimeout: number = DEFAULT_TASK_TIMEOUT) {
    super();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async execute(task: TaskRequest, workingDir: string): Promise<void> {
    this.currentTaskId = task.taskId;
    this.tempImageFiles = [];

    // Save base64 images to temp files
    const imageArgs: string[] = [];
    if (task.images && task.images.length > 0) {
      for (let i = 0; i < task.images.length; i++) {
        const dataUrl = task.images[i];
        const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) continue;
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const base64Data = match[2];
        const tmpPath = path.join(os.tmpdir(), `ccm-img-${task.taskId}-${i}-${Date.now()}.${ext}`);
        fs.writeFileSync(tmpPath, Buffer.from(base64Data, 'base64'));
        this.tempImageFiles.push(tmpPath);
        imageArgs.push('--image', tmpPath);
      }
    }

    let args: string[];

    if (task.continueSession && task.sessionId) {
      // Resume a previous session
      args = ['exec', 'resume', task.sessionId, '--json', '--dangerously-bypass-approvals-and-sandbox'];
    } else {
      args = ['exec', task.prompt, '--json', '--dangerously-bypass-approvals-and-sandbox', '-C', workingDir];
      args.push(...imageArgs);
    }

    try {
      await this.runCodex(args, workingDir);
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

  private async runCodex(args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };

      this.process = spawn('codex', args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Set execution timeout
      this.timeoutHandle = setTimeout(() => {
        if (this.process) {
          console.error(`Task ${this.currentTaskId} timed out after ${this.taskTimeout}ms`);
          this.emit('error', new Error(`Task execution timed out after ${this.taskTimeout / 1000} seconds`));
          this.cancel();
        }
      }, this.taskTimeout);

      // Close stdin
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
        // Filter out codex's own log lines (timestamps with ERROR/WARN/INFO)
        if (!text.match(/^\d{4}-\d{2}-\d{2}T.*(?:ERROR|WARN|INFO)/)) {
          this.emit('output', text);
        }
      });

      this.process.on('error', (error) => {
        this.emit('error', error);
        reject(error);
      });

      this.process.on('exit', (code) => {
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
        case 'thread.started':
          // Capture thread_id as session ID for resume support
          if (event.thread_id) {
            this.sessionId = event.thread_id;
            this.emit('session_id', event.thread_id);
          }
          break;

        case 'item.started':
          if (event.item) {
            if (event.item.type === 'command_execution') {
              this.emit('tool_use', {
                id: event.item.id || `codex-${Date.now()}`,
                name: 'bash',
                input: { command: event.item.command || '' },
              });
            }
          }
          break;

        case 'item.completed':
          if (event.item) {
            if (event.item.type === 'agent_message' && event.item.text) {
              this.emit('output', event.item.text);
            } else if (event.item.type === 'command_execution') {
              this.emit('tool_result', {
                id: event.item.id || `codex-${Date.now()}`,
                result: event.item.output || event.item.exit_code?.toString() || '',
              });
            }
          }
          break;

        case 'turn.completed':
          // Turn completed, could extract usage info if needed
          break;

        case 'turn.failed':
          if (event.error?.message) {
            this.emit('error', new Error(event.error.message));
          }
          break;

        case 'error':
          if (event.message) {
            this.emit('output', `[Codex Error] ${event.message}\n`);
          }
          break;
      }
    } catch {
      // Non-JSON output, emit as raw text
      if (line.startsWith('{') || line.startsWith('[')) {
        console.warn('Failed to parse codex JSON line:', line.slice(0, 100));
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
