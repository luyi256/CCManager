import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { DockerConfig, TaskRequest } from './types.js';

/**
 * A task run is executed by a detached runner process (see taskRunner.ts) so
 * that restarting or upgrading the agent never interrupts it. The runner and
 * the agent communicate only through files in the run directory:
 *
 *   request.json   what to execute (written by the agent)
 *   runner.json    runner pid (written by the runner once it is alive)
 *   events.jsonl   append-only, sequence-numbered events (runner)
 *   control.jsonl  append-only cancel/input commands (agent)
 *   delivered.json highest sequence acknowledged by the server (agent)
 */

export interface RunRequest {
  task: TaskRequest;
  executionPath: string;
  executor?: 'local' | 'docker';
  dockerConfig?: DockerConfig;
}

export interface RunRecord {
  seq: number;
  event: string;
  data: Record<string, unknown>;
}

export type RunPhase = 'thinking' | 'tool' | 'recovering';

export const RUN_FILES = {
  request: 'request.json',
  runner: 'runner.json',
  events: 'events.jsonl',
  control: 'control.jsonl',
  delivered: 'delivered.json',
  log: 'runner.log',
} as const;

/** Records that end a run. `runner:cancelled` is internal and never forwarded. */
export const TERMINAL_EVENTS = new Set(['task:completed', 'task:failed', 'runner:cancelled']);

const RUNNER_START_TIMEOUT_MS = 15000;

export function defaultRunsRoot(agentId: string): string {
  return path.join(os.homedir(), '.ccm-agent', 'runs', agentId);
}

function runnerEntry(): { script: string; execArgv: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(here, 'taskRunner.js');
  if (fs.existsSync(compiled)) return { script: compiled, execArgv: [] };
  // Running from source under tsx: reuse this process's loader flags.
  return {
    script: path.join(here, 'taskRunner.ts'),
    execArgv: process.execArgv.filter((arg) => !arg.startsWith('--test') && !arg.startsWith('--watch')),
  };
}

export function writeFileAtomic(file: string, contents: string, mode = 0o600): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { mode });
  fs.renameSync(tmp, file);
}

export function isRunnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  // Guard against pid reuse. Zombies also have an empty cmdline.
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('taskRunner');
  } catch {
    return true; // No procfs (macOS): trust the signal probe.
  }
}

/** Parse complete newline-terminated JSON lines; returns the bytes consumed. */
export function readJsonLines<T>(file: string, offset: number): { items: T[]; offset: number } {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { items: [], offset };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { items: [], offset };
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return { items: [], offset };
    const items: T[] = [];
    for (const line of buffer.subarray(0, lastNewline).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        items.push(JSON.parse(line) as T);
      } catch {
        // A torn line can only come from a crashed writer; skip it.
      }
    }
    return { items, offset: offset + lastNewline + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TaskRun {
  pid: number | null = null;
  /** Records with a sequence above `deliveredSeq` that still have to reach the server. */
  pending: RunRecord[] = [];
  deliveredSeq = 0;
  lastSeq = 0;
  terminal: RunRecord | null = null;
  cancelRequested = false;
  phase: RunPhase;
  lastHeartbeatAt = 0;
  private readOffset = 0;
  private sessionId: string | null = null;

  private constructor(readonly dir: string, readonly taskId: number, readonly runId: string | undefined, recovery?: boolean) {
    this.phase = recovery ? 'recovering' : 'thinking';
  }

  static async launch(root: string, request: RunRequest): Promise<TaskRun> {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const runLabel = (request.task.startedAt || 'run').replace(/[^A-Za-z0-9-]/g, '');
    const dir = fs.mkdtempSync(path.join(root, `${request.task.taskId}-${runLabel}-`));
    writeFileAtomic(path.join(dir, RUN_FILES.request), JSON.stringify(request));

    const { script, execArgv } = runnerEntry();
    await new Promise<void>((resolve, reject) => {
      const launcher = spawn(process.execPath, [...execArgv, script, '--daemonize', dir], {
        stdio: 'ignore',
        env: process.env,
      });
      launcher.once('error', reject);
      launcher.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Task runner launcher exited with code ${code}`));
      });
    });

    const run = new TaskRun(dir, request.task.taskId, request.task.startedAt, request.task.recovery);
    const deadline = Date.now() + RUNNER_START_TIMEOUT_MS;
    while (!run.readPid()) {
      if (Date.now() > deadline) {
        let log = '';
        try {
          log = fs.readFileSync(path.join(dir, RUN_FILES.log), 'utf8').trim().slice(-2000);
        } catch { /* no log */ }
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error(`Task runner did not start${log ? `: ${log}` : ''}`);
      }
      await sleep(50);
    }
    return run;
  }

  /** Re-attach to every run left behind by a previous agent process. */
  static attachAll(root: string): TaskRun[] {
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return [];
    }
    const runs: TaskRun[] = [];
    for (const name of names) {
      const dir = path.join(root, name);
      try {
        const request = JSON.parse(fs.readFileSync(path.join(dir, RUN_FILES.request), 'utf8')) as RunRequest;
        const run = new TaskRun(dir, request.task.taskId, request.task.startedAt, request.task.recovery);
        run.readPid();
        try {
          run.deliveredSeq = Number(JSON.parse(fs.readFileSync(path.join(dir, RUN_FILES.delivered), 'utf8')).seq) || 0;
        } catch { /* nothing delivered yet */ }
        const control = readJsonLines<{ type?: string }>(path.join(dir, RUN_FILES.control), 0).items;
        run.cancelRequested = control.some((command) => command.type === 'cancel');
        runs.push(run);
      } catch {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    return runs;
  }

  private readPid(): number | null {
    if (this.pid) return this.pid;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(this.dir, RUN_FILES.runner), 'utf8')) as { pid?: number };
      this.pid = typeof info.pid === 'number' ? info.pid : null;
    } catch {
      this.pid = null;
    }
    return this.pid;
  }

  get isRunning(): boolean {
    return this.pid !== null && isRunnerAlive(this.pid);
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Read records appended since the last poll. */
  poll(): RunRecord[] {
    const { items, offset } = readJsonLines<RunRecord>(path.join(this.dir, RUN_FILES.events), this.readOffset);
    this.readOffset = offset;
    for (const record of items) this.accept(record);
    return items;
  }

  /** Terminate a run whose runner vanished without reporting a result. */
  failUnexpectedly(error: string): RunRecord {
    const record: RunRecord = {
      seq: this.lastSeq + 1,
      event: 'task:failed',
      data: { taskId: this.taskId, error, startedAt: this.runId },
    };
    this.accept(record);
    return record;
  }

  private accept(record: RunRecord): void {
    this.lastSeq = Math.max(this.lastSeq, record.seq);
    if (record.event === 'task:session_id' && typeof record.data.sessionId === 'string') {
      this.sessionId = record.data.sessionId;
    }
    if (TERMINAL_EVENTS.has(record.event)) this.terminal = record;
    if (record.seq > this.deliveredSeq && record.event.startsWith('task:')) this.pending.push(record);
  }

  markDelivered(seq: number): void {
    if (seq <= this.deliveredSeq) return;
    this.deliveredSeq = seq;
    this.pending = this.pending.filter((record) => record.seq > seq);
    try {
      writeFileAtomic(path.join(this.dir, RUN_FILES.delivered), JSON.stringify({ seq }));
    } catch (error) {
      console.warn(`Task ${this.taskId}: failed to persist delivery cursor:`, error instanceof Error ? error.message : error);
    }
  }

  cancel(): void {
    this.cancelRequested = true;
    this.appendControl({ type: 'cancel' });
  }

  sendInput(input: string): void {
    this.appendControl({ type: 'input', input });
  }

  remove(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private appendControl(command: Record<string, unknown>): void {
    try {
      fs.appendFileSync(path.join(this.dir, RUN_FILES.control), JSON.stringify(command) + '\n', { mode: 0o600 });
    } catch (error) {
      console.warn(`Task ${this.taskId}: failed to send ${String(command.type)} to runner:`, error instanceof Error ? error.message : error);
    }
  }
}
