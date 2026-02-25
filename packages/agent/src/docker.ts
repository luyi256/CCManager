import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { TaskRequest, DockerConfig } from './types.js';

// Default timeout: 4 hours (in milliseconds)
const DEFAULT_TASK_TIMEOUT = 4 * 60 * 60 * 1000;

export class DockerExecutor extends EventEmitter {
  private process: ChildProcess | null = null;
  private containerName: string | null = null;
  private currentTaskId: number | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private taskTimeout: number;

  constructor(private config: DockerConfig) {
    super();
    this.taskTimeout = config.timeout || DEFAULT_TASK_TIMEOUT;
  }

  async execute(task: TaskRequest, workingDir: string): Promise<void> {
    this.currentTaskId = task.taskId;

    const containerName = `ccm-task-${task.taskId}-${Date.now()}`;
    this.containerName = containerName;

    const args: string[] = [
      'run',
      '--rm',
      '--name', containerName,
      '-i',
    ];

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

    // Mount working directory
    args.push('-v', `${workingDir}:/workspace:rw`);
    args.push('-w', '/workspace');

    // Extra mounts
    if (this.config.extraMounts) {
      for (const mount of this.config.extraMounts) {
        const mode = mount.readonly ? 'ro' : 'rw';
        args.push('-v', `${mount.source}:${mount.target}:${mode}`);
      }
    }

    // Image
    args.push(this.config.image);

    // Claude command
    args.push('claude', '-p', task.prompt, '--output-format', 'stream-json');

    if (task.isPlanMode) {
      args.push('--plan');
    }

    args.push('--dangerously-skip-permissions');

    return this.runDocker(args);
  }

  private async runDocker(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn('docker', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Set execution timeout (Bug #25 fix)
      this.timeoutHandle = setTimeout(() => {
        if (this.process) {
          console.error(`Docker task ${this.currentTaskId} timed out after ${this.taskTimeout}ms`);
          this.emit('error', new Error(`Task execution timed out after ${this.taskTimeout / 1000} seconds`));
          this.cancel();
        }
      }, this.taskTimeout);

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
        // Docker progress messages
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
                this.emit('output', block.text);
              } else if (block.type === 'tool_use') {
                this.emit('tool_use', {
                  id: block.id,
                  name: block.name,
                  input: block.input,
                });
              }
            }
          }
          break;

        case 'content_block_delta':
          if (event.delta?.type === 'text_delta') {
            this.emit('output', event.delta.text);
          }
          break;

        case 'result':
          if (event.result) {
            this.emit('tool_result', {
              id: event.tool_use_id || 'unknown',
              result: event.result,
            });
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
    }
    // Stop container by name (Bug #13 fix)
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
