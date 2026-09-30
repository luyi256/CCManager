#!/usr/bin/env node
/**
 * Detached per-task runner. Owns the runner CLI process and records every
 * event to the run directory, so the agent process can restart, upgrade, or
 * lose its server connection without affecting execution.
 *
 *   taskRunner --daemonize <runDir>   spawn a detached runner and exit
 *   taskRunner <runDir>               execute the run described in request.json
 */
import { exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { createExecutor, type Executor } from './executors.js';
import { RUN_FILES, readJsonLines, writeFileAtomic, type RunRequest } from './taskRun.js';

const execAsync = promisify(exec);
const CONTROL_POLL_MS = 200;
const TERMINATE_GRACE_MS = 6000;

/**
 * Double-spawn so the runner is re-parented away from the agent. Process
 * managers such as PM2 kill the agent's whole process tree on restart; a
 * runner that is no longer a descendant survives that.
 */
function daemonize(dir: string): void {
  const log = fs.openSync(path.join(dir, RUN_FILES.log), 'a', 0o600);
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], dir], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  process.exit(0);
}

async function run(dir: string): Promise<void> {
  const request = JSON.parse(fs.readFileSync(path.join(dir, RUN_FILES.request), 'utf8')) as RunRequest;
  const { task, executionPath } = request;
  const eventsPath = path.join(dir, RUN_FILES.events);
  const controlPath = path.join(dir, RUN_FILES.control);

  let seq = 0;
  let finished = false;
  let cancelled = false;
  let terminating = false;

  const record = (event: string, data: Record<string, unknown>): void => {
    fs.appendFileSync(eventsPath, JSON.stringify({ seq: ++seq, event, data }) + '\n', { mode: 0o600 });
  };
  const finish = (event: string, data: Record<string, unknown>): void => {
    if (finished) return;
    finished = true;
    // A runner stopped by a signal leaves no result; the agent then treats
    // the run as lost and the server resumes the session.
    if (terminating) return;
    if (cancelled) record('runner:cancelled', { taskId: task.taskId });
    else record(event, data);
  };

  process.on('uncaughtException', (error) => {
    console.error(`Task ${task.taskId}: runner crashed:`, error);
    finish('task:failed', { taskId: task.taskId, error: error.message, startedAt: task.startedAt });
    process.exit(1);
  });

  writeFileAtomic(path.join(dir, RUN_FILES.runner), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  const executor: Executor = createExecutor(task, request);

  const onSignal = (): void => {
    terminating = true;
    executor.cancel();
    setTimeout(() => process.exit(1), TERMINATE_GRACE_MS).unref();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('SIGHUP', () => { /* no controlling terminal; ignore */ });

  let controlOffset = 0;
  const controlTimer = setInterval(() => {
    const { items, offset } = readJsonLines<{ type?: string; input?: string }>(controlPath, controlOffset);
    controlOffset = offset;
    for (const command of items) {
      if (command.type === 'cancel' && !cancelled) {
        cancelled = true;
        executor.cancel();
      } else if (command.type === 'input' && typeof command.input === 'string') {
        executor.sendInput(command.input);
      }
    }
  }, CONTROL_POLL_MS);

  const base = { taskId: task.taskId, startedAt: task.startedAt };
  executor.on('output', (text: string) => record('task:output', { ...base, text }));
  executor.on('tool_use', (data: Record<string, unknown>) => record('task:tool_use', { taskId: task.taskId, ...data, startedAt: task.startedAt }));
  executor.on('tool_result', (data: Record<string, unknown>) => record('task:tool_result', { taskId: task.taskId, ...data, startedAt: task.startedAt }));
  executor.on('plan_question', (data: unknown) => record('task:plan_question', { ...base, question: data }));
  executor.on('permission_request', (data: unknown) => record('task:permission_request', { ...base, request: data }));
  executor.on('error', (error: Error) => record('task:error', { ...base, error: error.message }));
  executor.on('session_id', (sessionId: string) => record('task:session_id', {
    ...base,
    sessionId,
    runner: task.runner ?? 'claude',
    attempt: task.attempt,
  }));

  record('task:stream', {
    version: 1,
    taskId: task.taskId,
    eventId: `agent:${task.taskId}:${task.startedAt || 'run'}:start`,
    kind: 'phase',
    timestamp: new Date().toISOString(),
    runId: task.startedAt,
    phase: task.recovery ? 'recovering' : 'thinking',
  });

  try {
    console.log(`Task ${task.taskId}: executing in ${executionPath}`);
    await executor.execute(task, executionPath);
    if (task.postTaskHook && !cancelled && !terminating) {
      await runPostTaskHook(task.postTaskHook, executionPath, (text) => record('task:output', { ...base, text }));
    }
    finish('task:completed', {
      ...base,
      status: 'completed',
      sessionId: executor.getSessionId() || undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finish('task:failed', { ...base, error: message });
  } finally {
    clearInterval(controlTimer);
  }
  process.exit(0);
}

async function runPostTaskHook(hook: string, cwd: string, output: (text: string) => void): Promise<void> {
  output(`\n[Post-Task Hook] Running: ${hook}\n`);
  try {
    const { stdout, stderr } = await execAsync(hook, { cwd, timeout: 30000 });
    if (stdout) output(`[Post-Task Hook] ${stdout}`);
    if (stderr) output(`[Post-Task Hook] ${stderr}`);
  } catch (error) {
    output(`[Post-Task Hook] Failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

const args = process.argv.slice(2);
if (args[0] === '--daemonize' && args[1]) {
  daemonize(args[1]);
} else if (args[0]) {
  run(args[0]).catch((error) => {
    console.error('Task runner failed:', error);
    process.exit(1);
  });
} else {
  console.error('Usage: taskRunner [--daemonize] <runDir>');
  process.exit(2);
}
