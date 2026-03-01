import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TaskRequest, DockerConfig } from './types.js';

// Default timeout: 4 hours (in milliseconds)
const DEFAULT_TASK_TIMEOUT = 4 * 60 * 60 * 1000;

// Minimum Linux capabilities required for Node.js / Claude Code to operate
const REQUIRED_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID'];

export class DockerExecutor extends EventEmitter {
  private process: ChildProcess | null = null;
  private containerName: string | null = null;
  private currentTaskId: number | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private taskTimeout: number;
  private sessionId: string | null = null;
  private hasStreamedDelta = false;

  constructor(private config: DockerConfig) {
    super();
    this.taskTimeout = config.timeout || DEFAULT_TASK_TIMEOUT;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async execute(task: TaskRequest, workingDir: string): Promise<void> {
    this.currentTaskId = task.taskId;
    this.sessionId = null;
    this.hasStreamedDelta = false;

    const containerName = `ccm-task-${task.taskId}-${Date.now()}`;
    this.containerName = containerName;

    const args: string[] = [
      'run',
      '--rm',
      '--name', containerName,
      '-i',
    ];

    // Security hardening: no privilege escalation
    args.push('--security-opt=no-new-privileges');

    // Drop all capabilities, then add back only the minimum required
    args.push('--cap-drop=ALL');
    for (const cap of REQUIRED_CAPS) {
      args.push('--cap-add', cap);
    }

    // Run as host user to avoid file permission issues
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid !== undefined && gid !== undefined) {
      args.push('--user', `${uid}:${gid}`);
    }

    // Resource limits
    if (this.config.memory) {
      args.push('--memory', this.config.memory);
    }
    if (this.config.cpus) {
      args.push('--cpus', this.config.cpus);
    }

    // Network
    if (this.config.network) {
      args.push('--network', this.config.network);
    }

    // Mount working directory — the ONLY writable business directory
    args.push('-v', `${workingDir}:/workspace:rw`);
    args.push('-w', '/workspace');

    // Container home directory: mount the per-project session dir as the entire
    // home so that both ~/.claude/ (sessions, credentials) and ~/.claude.json
    // (config) are writable by the host UID.
    const sessionsDir = this.getSessionsDir(task.projectId);
    const claudeSubdir = path.join(sessionsDir, '.claude');
    fs.mkdirSync(claudeSubdir, { recursive: true });
    args.push('-v', `${sessionsDir}:/home/ccm:rw`);
    args.push('-e', 'HOME=/home/ccm');

    // Copy host credentials so Claude CLI can authenticate inside the container
    const hostCredentials = path.join(os.homedir(), '.claude', '.credentials.json');
    if (fs.existsSync(hostCredentials)) {
      fs.copyFileSync(hostCredentials, path.join(claudeSubdir, '.credentials.json'));
    }

    // Extra mounts (user-configured)
    if (this.config.extraMounts) {
      for (const mount of this.config.extraMounts) {
        const mode = mount.readonly ? 'ro' : 'rw';
        args.push('-v', `${mount.source}:${mount.target}:${mode}`);
      }
    }

    // Credential injection via environment variables (fallback)
    if (process.env.ANTHROPIC_API_KEY) {
      args.push('-e', `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
    }
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`);
    }

    // Image
    args.push(this.config.image);

    // Claude CLI arguments (after the image, these become the CMD)
    args.push('-p', task.prompt, '--output-format', 'stream-json', '--verbose');

    if (task.isPlanMode) {
      args.push('--permission-mode', 'plan');
    }

    if (task.continueSession && task.sessionId) {
      args.push('--resume', task.sessionId);
    }

    args.push('--dangerously-skip-permissions');

    return this.runDocker(args);
  }

  private getSessionsDir(projectId: string): string {
    const base = this.config.sessionsDir || path.join(os.homedir(), '.ccm-sessions');
    const dir = path.join(base, projectId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async runDocker(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn('docker', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Set execution timeout
      this.timeoutHandle = setTimeout(() => {
        if (this.process) {
          console.error(`Docker task ${this.currentTaskId} timed out after ${this.taskTimeout}ms`);
          this.emit('error', new Error(`Task execution timed out after ${this.taskTimeout / 1000} seconds`));
          this.cancel();
        }
      }, this.taskTimeout);

      // Close stdin — we don't send interactive input
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
        this.emit('exit', code);
        this.process = null;
        this.currentTaskId = null;
        this.containerName = null;
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
                // Only emit from assistant if no content_block_delta was received
                // (prevents duplicate output)
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
          break;

        case 'user':
          if (event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_result') {
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
      // Non-JSON output, emit as raw text
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
    }
    // Stop container by name
    if (this.containerName) {
      spawn('docker', ['stop', this.containerName]).on('error', (err) => {
        console.error(`Failed to stop container ${this.containerName}:`, err);
      });
    }
  }

  get isRunning(): boolean {
    return this.process !== null;
  }

  get taskId(): number | null {
    return this.currentTaskId;
  }
}
