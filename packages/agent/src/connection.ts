import { io, Socket } from 'socket.io-client';
import { exec, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { gzipSync } from 'zlib';
import { validatePath } from './security.js';
import { WorktreeManager } from './worktree.js';
import { parseClaudeGrokSettings } from './runnerModels.js';
import { TaskRun, defaultAttachmentsRoot, defaultRunsRoot, type RunRecord } from './taskRun.js';
import type { AgentConfig, TaskRequest, AgentInfo } from './types.js';
import { listSessions, listActiveSessions, getSessionDetail, searchSessions } from './sessions.js';
import { getCursorSessionDetail, listCursorSessions, searchCursorSessions } from './cursorSessions.js';

const execAsync = promisify(exec);

type Executor = TaskRun;
type Runner = 'claude' | 'claude-grok' | 'codex' | 'cursor' | 'qwen' | 'tclaude' | 'tcodex';

interface BufferedEvent {
  event: string;
  args: unknown[];
}

const HEARTBEAT_INTERVAL_MS = 20000;
const URL_DISCOVERY_COOLDOWN_MS = 5000;
const URL_DISCOVERY_TIMEOUT_MS = 10000;
const HEARTBEAT_FILE = process.env.CCM_AGENT_HEARTBEAT_FILE || '/tmp/ccm-agent-heartbeat.json';
// Grace period for a superseded process to release its session file before a
// --resume starts. Only elapses if the old process is genuinely still running.
const SESSION_RESUME_GRACE_MS = 5000;
const STOPPING_EXECUTOR_TTL_MS = 30000;
const RUN_POLL_INTERVAL_MS = 200;
const RUN_HEARTBEAT_INTERVAL_MS = 15000;
const RUN_HEARTBEAT_MIN_GAP_MS = 1000;
const EVENT_ACK_TIMEOUT_MS = 30000;
// Keep batches small enough that a catch-up after a long disconnect does not
// starve Engine.IO heartbeats on slow links.
const EVENT_BATCH_MAX_RECORDS = 200;
const EVENT_BATCH_MAX_BYTES = 512 * 1024;
const IMAGE_DOWNLOAD_ATTEMPTS = 3;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const SESSION_UPLOAD_TIMEOUT_MS = 170_000;

function normalizeManagerUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported manager URL protocol: ${parsed.protocol}`);
  }
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname) + parsed.search;
}

function parseModelOutput(output: string, runner: Runner): string[] {
  const models = new Set<string>();
  const patterns = [
    /(?:claude|qwen|gemini|gpt|o[1-9])[-/][A-Za-z0-9_.:-]+/g,
    /(?:sonnet|opus|haiku)[-_][A-Za-z0-9_.:-]+/g,
  ];

  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      models.add(match[0].replace(/[,\])}]+$/, ''));
    }
  }

  if (models.size === 0) {
    for (const line of output.split('\n')) {
      const cleaned = line
        .replace(/^[\s>*-]+/, '')
        .replace(/\s+\(.*\)$/, '')
        .trim();
      if (
        cleaned &&
        cleaned.length <= 80 &&
        !/^(available|select|current|model|error|warning)/i.test(cleaned) &&
        (runner === 'qwen' ? /qwen|gemini|coder/i.test(cleaned) : /claude|codex|gpt|o[1-9]|sonnet|opus|haiku/i.test(cleaned))
      ) {
        models.add(cleaned.split(/\s+/)[0]);
      }
    }
  }

  return Array.from(models);
}

async function listCursorModels(): Promise<string[]> {
  const { Cursor } = await import('@cursor/sdk');
  const models = await Cursor.models.list();
  return models.map((model) => model.id);
}

async function listRunnerModels(runner: Runner): Promise<{ ok: boolean; runner: Runner; models?: string[]; raw?: string; error?: string }> {
  if (runner === 'cursor') {
    try {
      return { ok: true, runner, models: await listCursorModels() };
    } catch (error) {
      return {
        ok: false,
        runner,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const commandByRunner: Record<Runner, string> = {
    claude: 'claude',
    'claude-grok': 'claude-grok',
    codex: 'codex',
    cursor: 'agent',
    qwen: 'qwen',
    tclaude: 'tclaude',
    tcodex: 'tcodex',
  };
  const command = commandByRunner[runner];
  if (runner === 'claude-grok') {
    try {
      const { existsSync, readFileSync } = await import('fs');
      const { join } = await import('path');
      const settingsPath = process.env.CLAUDE_GROK_SETTINGS ||
        join(process.env.HOME || '', '.config', 'distill-grok', 'claude-settings.json');
      if (!existsSync(settingsPath)) return { ok: true, runner, models: [] };
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        modelOverrides?: Record<string, unknown>;
      };
      return {
        ok: true,
        runner,
        models: parseClaudeGrokSettings(settings),
      };
    } catch (error) {
      return {
        ok: false,
        runner,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const cmd = runner === 'codex' || runner === 'tcodex'
    ? `${command} exec "/model" --json`
    : `${command} -p "/model"`;

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env },
    });
    const raw = `${stdout}\n${stderr}`.trim();
    return { ok: true, runner, models: parseModelOutput(raw, runner), raw };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, runner, error: message };
  }
}

export class AgentConnection {
  private socket: Socket | null = null;
  private executors: Map<number, Executor> = new Map();
  /** Cancelled executors whose process may still be shutting down. */
  private stoppingExecutors: Map<number, Executor> = new Map();
  /** Every run with a live runner or undelivered events, keyed by run directory. */
  private runs: Map<string, TaskRun> = new Map();
  /** Dispatches still preparing (e.g. downloading images) before their runner exists. */
  private launching: Map<number, TaskRequest> = new Map();
  /** Runs with an event batch awaiting server acknowledgement. */
  private deliveriesInFlight: Set<string> = new Set();
  private runsRoot: string;
  private attachmentsRoot: string;
  private runPumpInterval: NodeJS.Timeout | null = null;
  /** Events are forwarded only after the server has reconciled this connection. */
  private registered = false;
  private config: AgentConfig;
  private currentUrl: string;
  private reconnectAttempts = 0;
  private consecutiveErrors = 0;
  private maxReconnectAttempts = Infinity;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private discoveryInFlight: Promise<void> | null = null;
  private lastDiscoveryAt = 0;
  private shuttingDown = false;
  private worktreeManager = new WorktreeManager();
  // Monotonic sequence per task to detect superseded follow-ups
  private followUpSeq: Map<number, number> = new Map();

  constructor(config: AgentConfig) {
    this.config = config;
    this.currentUrl = normalizeManagerUrl(config.managerUrl!);
    this.config.managerUrl = this.currentUrl;
    this.runsRoot = config.runsDir || defaultRunsRoot(config.agentId);
    this.attachmentsRoot = config.attachmentsDir || defaultAttachmentsRoot(config.agentId);
    this.adoptExistingRuns();
  }

  /** Take over runs whose runners outlived a previous agent process. */
  private adoptExistingRuns(): void {
    for (const run of TaskRun.attachAll(this.runsRoot)) {
      const alive = run.isRunning;
      run.poll();
      if (!alive && !run.terminal) {
        // The runner died too (e.g. machine reboot). Not reporting the task
        // lets the server resume its session.
        console.log(`Task ${run.taskId}: runner from a previous agent is gone; leaving recovery to the server`);
        run.remove();
        continue;
      }
      this.runs.set(run.dir, run);
      if (alive && !run.terminal && !run.cancelRequested) {
        const current = this.executors.get(run.taskId);
        if (!current || (run.runId ?? '') > (current.runId ?? '')) {
          this.executors.set(run.taskId, run);
        }
        console.log(`Task ${run.taskId}: re-attached to running runner (pid ${run.pid})`);
      }
    }
  }

  connect(): void {
    this.shuttingDown = false;
    this.startRunPump();
    if (this.socket) {
      if (!this.socket.connected) {
        this.socket.connect();
      }
      return;
    }
    this.openSocket();
  }

  private openSocket(bufferedEvents: BufferedEvent[] = []): void {
    console.log(`Connecting to manager: ${this.currentUrl}`);

    // Parse base path from URL (e.g. https://example.com/ccm → basePath="/ccm")
    const parsedUrl = new URL(this.currentUrl);
    const basePath = parsedUrl.pathname.replace(/\/$/, '');

    const socket = io(`${parsedUrl.origin}/agent`, {
      path: `${basePath}/socket.io`,
      auth: {
        token: this.config.authToken,
        agentId: this.config.agentId,
      },
      // Agents keep a long-lived connection and can receive multi-megabyte task
      // payloads. Starting with HTTP long-polling makes those payloads contend
      // with Engine.IO heartbeat requests on slow or NAT-changing links, which
      // can trigger a ping-timeout reconnect loop. Use the direct WebSocket
      // transport instead.
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      autoConnect: false,
    });
    this.socket = socket;

    socket.on('connect', () => {
      if (this.socket !== socket || this.shuttingDown) return;
      console.log('Connected to manager');
      this.reconnectAttempts = 0;
      this.consecutiveErrors = 0;
      this.lastDiscoveryAt = 0;
      this.registered = false;
      this.register(socket);
    });

    socket.on('disconnect', (reason) => {
      if (this.socket !== socket) return;
      console.log(`Disconnected from manager: ${reason}`);
      this.registered = false;
      this.stopHeartbeat();

      if (this.shuttingDown) return;

      // Socket.IO intentionally disables automatic reconnection after a
      // server-initiated namespace disconnect. The server uses this path when
      // its application heartbeat expires, so explicitly reopen the socket.
      if (reason === 'io server disconnect') {
        socket.connect();
        void this.reconnectWithDiscovery();
      }
    });

    socket.on('connect_error', (error) => {
      if (this.socket !== socket || this.shuttingDown) return;
      console.error(`Connection error: ${error.message}`);
      this.reconnectAttempts++;
      this.consecutiveErrors++;

      // Re-read server-url.txt on the first failed connection. Native
      // Socket.IO reconnection continues in parallel when the URL is unchanged.
      void this.reconnectWithDiscovery();
    });

    socket.on('task:execute', (task: TaskRequest) => {
      this.handleTask(task).catch((error) => {
        console.error(`Task ${task.taskId} execution error:`, error);
      });
    });

    socket.on('task:input', (data: { taskId: number; input: string }) => {
      const executor = this.executors.get(data.taskId);
      if (executor) {
        executor.sendInput(data.input);
      }
    });

    socket.on('task:cancel', (data: { taskId: number }) => {
      this.launching.delete(data.taskId);
      const executor = this.executors.get(data.taskId);
      if (executor) {
        executor.cancel();
        this.executors.delete(data.taskId);
        // A resume for this task may arrive before the process is gone.
        this.trackStoppingExecutor(data.taskId, executor);
      }
    });

    socket.on('task:merge', async (data: { taskId: number; projectPath: string; branch: string; deleteBranch?: boolean }) => {
      try {
        console.log(`Merging worktree branch ${data.branch} for task ${data.taskId}`);
        const result = await this.worktreeManager.merge(data.projectPath, data.branch, data.deleteBranch || false);
        this.socket?.emit('task:merge-result', {
          taskId: data.taskId,
          ...result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.socket?.emit('task:merge-result', {
          taskId: data.taskId,
          success: false,
          error: message,
        });
      }
    });

    socket.on('task:cleanup-worktree', async (data: { taskId: number; projectPath: string; branch: string }) => {
      try {
        console.log(`Cleaning up worktree branch ${data.branch} for task ${data.taskId}`);
        await this.worktreeManager.cleanup(data.projectPath, data.branch);
        await this.worktreeManager.deleteBranch(data.projectPath, data.branch);
        this.socket?.emit('task:worktree-cleaned', {
          taskId: data.taskId,
          branch: data.branch,
        });
      } catch (error) {
        console.error(`Failed to cleanup worktree for task ${data.taskId}:`, error);
      }
    });

    // Session browsing — server requests session data via callback
    socket.on('sessions:list', async (data: { projectPath: string; projectId?: string }, callback: (result: unknown) => void) => {
      try {
        console.log(`[sessions] list requested for projectPath: ${data.projectPath}`);
        const [fileSessions, cursorSessions] = await Promise.all([
          listSessions(data.projectPath, {
            projectId: data.projectId,
            dockerSessionsDir: this.config.dockerConfig?.sessionsDir,
          }),
          listCursorSessions(data.projectPath).catch(() => []),
        ]);
        const sessions = [...fileSessions, ...cursorSessions];
        console.log(`[sessions] list result: ${sessions.length} sessions found`);
        callback({ ok: true, sessions });
      } catch (error) {
        console.error(`[sessions] list error:`, error);
        callback({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on('sessions:active', async (data: { projectPath: string; projectId?: string }, callback: (result: unknown) => void) => {
      try {
        console.log(`[sessions] active requested for projectPath: ${data.projectPath}`);
        const [fileSessions, cursorSessions] = await Promise.all([
          listActiveSessions(data.projectPath, {
            projectId: data.projectId,
            dockerSessionsDir: this.config.dockerConfig?.sessionsDir,
          }),
          listCursorSessions(data.projectPath, true).catch(() => []),
        ]);
        const sessions = [...fileSessions, ...cursorSessions];
        console.log(`[sessions] active result: ${sessions.length} sessions found`);
        callback({ ok: true, sessions });
      } catch (error) {
        console.error(`[sessions] active error:`, error);
        callback({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on('sessions:detail', async (data: {
      projectPath: string;
      projectId?: string;
      runner: Runner;
      sessionId: string;
      relatedSessionIds?: string[];
      uploadId?: string;
    }, rawCallback: (result: unknown) => void) => {
      const callback = async (result: { ok: boolean; [key: string]: unknown }) => {
        if (!data.uploadId || !result.ok) return rawCallback(result);
        try {
          await this.uploadSessionDetail(data.uploadId, result);
          rawCallback({ ok: true, uploaded: true });
        } catch (error) {
          rawCallback({ ok: false, error: `Session upload failed: ${error instanceof Error ? error.message : String(error)}` });
        }
      };
      try {
        const runner = data.runner ?? 'claude';
        const sessions = data.runner === 'cursor'
          ? await listCursorSessions(data.projectPath)
          : await listSessions(data.projectPath, {
              projectId: data.projectId,
              dockerSessionsDir: this.config.dockerConfig?.sessionsDir,
            });
        const session = sessions.find((item) =>
          item.runner === runner && item.sessionId === data.sessionId
        );
        const entries = runner === 'cursor'
          ? await getCursorSessionDetail(data.projectPath, data.sessionId)
          : await getSessionDetail(
              data.projectPath,
              runner,
              data.sessionId,
              data.relatedSessionIds,
              {
                projectId: data.projectId,
                dockerSessionsDir: this.config.dockerConfig?.sessionsDir,
              },
            );
        callback({ ok: true, entries, model: session?.model });
      } catch (error) {
        callback({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on('sessions:search', async (data: { projectPath: string; projectId?: string; query: string }, callback: (result: unknown) => void) => {
      try {
        console.log(`[sessions] search requested for projectPath: ${data.projectPath}, query: "${data.query}"`);
        const [fileResults, cursorResults] = await Promise.all([
          searchSessions(data.projectPath, data.query, {
            projectId: data.projectId,
            dockerSessionsDir: this.config.dockerConfig?.sessionsDir,
          }),
          searchCursorSessions(data.projectPath, data.query).catch(() => []),
        ]);
        const results = [...fileResults, ...cursorResults]
          .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
        console.log(`[sessions] search result: ${results.length} sessions matched`);
        callback({ ok: true, results });
      } catch (error) {
        console.error(`[sessions] search error:`, error);
        callback({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on('models:list', async (data: { runner: Runner }, callback: (result: unknown) => void) => {
      if (data.runner !== 'claude' && data.runner !== 'claude-grok' && data.runner !== 'codex' && data.runner !== 'cursor' && data.runner !== 'qwen' && data.runner !== 'tclaude' && data.runner !== 'tcodex') {
        callback({ ok: false, error: 'Invalid runner' });
        return;
      }
      callback(await listRunnerModels(data.runner));
    });

    // Preserve events produced by running executors while the old URL was
    // offline. Socket.IO normally buffers these, but replacing the Socket
    // instance for a newly discovered URL would otherwise discard them.
    for (const { event, args } of bufferedEvents) {
      socket.emit(event, ...args);
    }
    socket.connect();
  }

  /**
   * Tasks the server must keep as running: active runs, plus runs that
   * finished while the server was unreachable but whose result has not been
   * delivered yet (it will be, right after registration).
   */
  private reportedRunningTasks(): NonNullable<AgentInfo['runningTasks']> {
    const reported = new Map<number, { taskId: number; sessionId?: string; startedAt?: string }>();
    for (const [taskId, executor] of this.executors) {
      reported.set(taskId, {
        taskId,
        sessionId: 'getSessionId' in executor ? executor.getSessionId() || undefined : undefined,
        startedAt: 'runId' in executor ? executor.runId : undefined,
      });
    }
    for (const [taskId, task] of this.launching) {
      if (!reported.has(taskId)) reported.set(taskId, { taskId, startedAt: task.startedAt });
    }
    for (const run of this.runs.values()) {
      if (reported.has(run.taskId) || run.cancelRequested || run.terminal?.event === 'runner:cancelled') continue;
      reported.set(run.taskId, {
        taskId: run.taskId,
        sessionId: run.getSessionId() || undefined,
        startedAt: run.runId,
      });
    }
    return Array.from(reported.values());
  }

  private register(socket: Socket): void {
    const info: AgentInfo = {
      agentId: this.config.agentId,
      agentName: this.config.agentName,
      capabilities: this.config.capabilities || [],
      status: 'online',
      runningTasks: this.reportedRunningTasks(),
    };

    socket.emit('register', info, (data?: {
      runningTasks?: Array<{ taskId: number; sessionId?: string; startedAt?: string }>;
      cancelTaskIds?: number[];
    }) => {
      if (socket !== this.socket) return;
      this.registered = true;
      // Tasks the user cancelled while this agent was unreachable.
      for (const taskId of data?.cancelTaskIds || []) {
        this.launching.delete(taskId);
        const executor = this.executors.get(taskId);
        if (!executor) continue;
        console.log(`Task ${taskId}: cancelled on the server while disconnected, stopping`);
        executor.cancel();
        this.executors.delete(taskId);
        this.trackStoppingExecutor(taskId, executor);
      }
      if (!data?.runningTasks) return;
      for (const task of data.runningTasks) {
        const executor = this.executors.get(task.taskId);
        if (!executor) continue;
        const sessionId = 'getSessionId' in executor ? executor.getSessionId() : null;
        if (!task.sessionId && sessionId) {
          this.socket?.emit('task:session_id', {
            taskId: task.taskId,
            sessionId,
            startedAt: task.startedAt,
          });
        }
      }
    });
    console.log(`Registered as: ${this.config.agentName}`);

    // Publish active executors immediately, then keep a comfortable margin
    // below the server's 60-second application heartbeat timeout.
    this.sendStatus(socket);
    this.startHeartbeat();
  }

  private sendStatus(socket = this.socket): void {
    if (!socket?.connected || socket !== this.socket) return;
    const runningTasks = Array.from(this.executors.keys());
    socket.emit('status', {
      status: 'online',
      runningTasks,
      taskCount: runningTasks.length,
    });
    try {
      fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({
        timestamp: new Date().toISOString(),
        connected: true,
        agentId: this.config.agentId,
        runningTasks,
      }));
    } catch (error) {
      console.warn('Failed to write agent heartbeat:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * Liveness-only events. They are dropped while offline instead of being
   * buffered, so a long disconnect does not flush a burst of stale heartbeats.
   */
  private emitVolatile(event: string, payload: unknown): void {
    this.socket?.volatile.emit(event, payload);
  }

  private startRunPump(): void {
    if (this.runPumpInterval) return;
    this.runPumpInterval = setInterval(() => {
      try {
        this.pumpRuns();
      } catch (error) {
        console.error('Run pump error:', error);
      }
    }, RUN_POLL_INTERVAL_MS);
  }

  private stopRunPump(): void {
    if (this.runPumpInterval) {
      clearInterval(this.runPumpInterval);
      this.runPumpInterval = null;
    }
  }

  /** Read runner output, forward it to the server, and retire finished runs. */
  private pumpRuns(): void {
    for (const run of this.runs.values()) {
      const alive = run.isRunning;
      for (const record of run.poll()) this.onRunRecord(run, record);
      if (!alive && !run.terminal && this.executors.get(run.taskId) === run) {
        console.error(`Task ${run.taskId}: runner exited without a result`);
        this.onRunRecord(run, run.failUnexpectedly('Task runner exited unexpectedly'));
      }
      this.sendRunHeartbeat(run, false);

      const delivering = this.deliveriesInFlight.has(run.dir);
      if (run.pending.length > 0 && !delivering && this.registered && this.socket?.connected) {
        this.deliverRunEvents(run, this.socket);
      } else if (!alive && run.pending.length === 0 && !delivering) {
        this.runs.delete(run.dir);
        run.remove();
      }
    }
  }

  private onRunRecord(run: TaskRun, record: RunRecord): void {
    if (record.event === 'task:output' || record.event === 'task:tool_result') {
      run.phase = 'thinking';
      this.sendRunHeartbeat(run, true);
    } else if (record.event === 'task:tool_use') {
      run.phase = 'tool';
      this.sendRunHeartbeat(run, true);
    }
    if (record === run.terminal && this.executors.get(run.taskId) === run) {
      this.executors.delete(run.taskId);
      this.sendStatus();
    }
  }

  private sendRunHeartbeat(run: TaskRun, phaseChanged: boolean): void {
    if (this.executors.get(run.taskId) !== run) return;
    const now = Date.now();
    const elapsed = now - run.lastHeartbeatAt;
    if (elapsed < RUN_HEARTBEAT_MIN_GAP_MS || (!phaseChanged && elapsed < RUN_HEARTBEAT_INTERVAL_MS)) return;
    run.lastHeartbeatAt = now;
    this.emitVolatile('task:stream', {
      version: 1,
      taskId: run.taskId,
      eventId: `agent:${run.taskId}:${run.runId || 'run'}:${run.phase}:${now}`,
      kind: 'phase',
      timestamp: new Date(now).toISOString(),
      runId: run.runId,
      phase: run.phase,
      heartbeat: true,
    });
  }

  private deliverRunEvents(run: TaskRun, socket: Socket): void {
    const events: RunRecord[] = [];
    let bytes = 0;
    for (const record of run.pending) {
      const size = JSON.stringify(record).length;
      if (events.length > 0 && (events.length >= EVENT_BATCH_MAX_RECORDS || bytes + size > EVENT_BATCH_MAX_BYTES)) break;
      events.push(record);
      bytes += size;
    }
    this.deliveriesInFlight.add(run.dir);
    socket.timeout(EVENT_ACK_TIMEOUT_MS).emit(
      'task:events',
      { taskId: run.taskId, runId: run.runId, events },
      (error: Error | null, result?: { seq?: number }) => {
        this.deliveriesInFlight.delete(run.dir);
        // Unacknowledged batches are resent; the server skips seen sequences.
        if (error || typeof result?.seq !== 'number') return;
        run.markDelivered(result.seq);
      }
    );
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Send heartbeat every 20 seconds
    this.heartbeatInterval = setInterval(() => {
      this.sendStatus();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /** Poll until the executor's process has exited, or the cap elapses. */
  private async waitForExecutorStop(executor: Executor, capMs: number): Promise<void> {
    const start = Date.now();
    while (executor.isRunning && Date.now() - start < capMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Wait out an executor that was cancelled but may still be shutting down, so
   * --resume does not collide with the old process over the session file.
   * Polling the tracked executor beats a blind sleep: a process that already
   * exited costs nothing, and one that is slow still gets the full grace period.
   */
  private async waitForStoppingExecutor(taskId: number, capMs: number): Promise<void> {
    const stopping = this.stoppingExecutors.get(taskId);
    if (!stopping) return;
    await this.waitForExecutorStop(stopping, capMs);
    if (this.stoppingExecutors.get(taskId) === stopping) {
      this.stoppingExecutors.delete(taskId);
    }
  }

  /** Remember a cancelled executor until its process is actually gone. */
  private trackStoppingExecutor(taskId: number, executor: Executor): void {
    this.stoppingExecutors.set(taskId, executor);
    void this.waitForExecutorStop(executor, STOPPING_EXECUTOR_TTL_MS).then(() => {
      if (this.stoppingExecutors.get(taskId) === executor) {
        this.stoppingExecutors.delete(taskId);
      }
    });
  }

  private async handleTask(task: TaskRequest): Promise<void> {
    console.log(`Received task ${task.taskId}: ${task.prompt.substring(0, 50)}...`);
    console.log(`Task ${task.taskId} projectPath: ${task.projectPath}`);

    if (this.launching.get(task.taskId)?.startedAt === task.startedAt) {
      console.log(`Task ${task.taskId}: Already starting this run, skipping duplicate dispatch`);
      return;
    }

    // If this task is already running, handle based on context
    if (this.executors.has(task.taskId)) {
      if (task.continueSession || task.isRetry) {
        // Follow-up or retry: kill current executor and start fresh
        console.log(`Task ${task.taskId}: ${task.isRetry ? 'Retry' : 'Follow-up'} received while running, replacing current executor`);
        const oldExecutor = this.executors.get(task.taskId)!;
        oldExecutor.cancel();
        this.executors.delete(task.taskId);
        // Wait for the old process to actually exit (up to 5s) rather than a blind
        // fixed sleep, so the follow-up starts promptly once the previous run is gone.
        await this.waitForExecutorStop(oldExecutor, 5000);
        if (oldExecutor.isRunning) this.trackStoppingExecutor(task.taskId, oldExecutor);
      } else {
        // Duplicate dispatch (e.g. reconnect recovery) — skip
        console.log(`Task ${task.taskId}: Already running, skipping duplicate dispatch`);
        return;
      }
    } else if (task.continueSession) {
      // Continue/retry with session resume but no active executor in map. The
      // previous executor was removed (by the cancel handler or on completion)
      // but its process may still be dying, and --resume would collide with it.
      // Wait only as long as that process actually needs.
      await this.waitForStoppingExecutor(task.taskId, SESSION_RESUME_GRACE_MS);
    }

    // The newest dispatch of a task wins if one arrives while this one starts.
    this.launching.set(task.taskId, task);
    try {
      if (task.imagesRef) {
        console.log(`Task ${task.taskId}: downloading ${task.imagesRef.count} image(s) (${task.imagesRef.bytes} bytes)`);
        task.images = await this.fetchDispatchImages(task.imagesRef);
        task.imagesRef = undefined;
      }
      if (this.launching.get(task.taskId) !== task) {
        console.log(`Task ${task.taskId}: superseded by a newer dispatch while starting`);
        return;
      }

      // Validate path (use project-level allowedPaths if provided)
      const effectiveConfig = task.allowedPaths?.length
        ? { ...this.config, allowedPaths: [...this.config.allowedPaths, ...task.allowedPaths] }
        : this.config;
      validatePath(task.projectPath, effectiveConfig);

      // Create worktree if branch is specified
      let executionPath = task.projectPath;
      if (task.worktreeBranch) {
        try {
          executionPath = await this.worktreeManager.create(task.projectPath, task.worktreeBranch);
          console.log(`Task ${task.taskId}: Using worktree at ${executionPath}`);
        } catch (wtError) {
          console.warn(`Task ${task.taskId}: Worktree creation failed, falling back to direct execution:`, wtError);
          // Fall back to direct execution
          executionPath = task.projectPath;
        }
      }

      const run = await TaskRun.launch(this.runsRoot, {
        task,
        executionPath,
        executor: task.executor ?? this.config.executor ?? 'local',
        dockerConfig: this.config.dockerConfig,
        attachmentsDir: path.join(this.attachmentsRoot, `task-${task.taskId}`),
      });
      this.runs.set(run.dir, run);
      this.executors.set(task.taskId, run);
      console.log(`Task ${task.taskId}: runner started (pid ${run.pid}) in ${executionPath}`);
      this.sendStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Task ${task.taskId} failed to start:`, message);
      this.socket?.emit('task:failed', {
        taskId: task.taskId,
        error: message,
        startedAt: task.startedAt,
      });
    } finally {
      if (this.launching.get(task.taskId) === task) this.launching.delete(task.taskId);
    }
  }

  /** Upload a session transcript over HTTP so a large one cannot stall the socket. */
  private async uploadSessionDetail(uploadId: string, result: unknown): Promise<void> {
    const response = await fetch(`${this.currentUrl}/api/agent/session-detail/${encodeURIComponent(uploadId)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.authToken}`,
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
      body: gzipSync(JSON.stringify(result)),
      signal: AbortSignal.timeout(SESSION_UPLOAD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  }

  /** Download images staged by the server for a dispatch, off the Socket.IO connection. */
  private async fetchDispatchImages(ref: NonNullable<TaskRequest['imagesRef']>): Promise<string[]> {
    const url = `${this.currentUrl}/api/agent/dispatch-images/${encodeURIComponent(ref.id)}`;
    let lastError = '';
    for (let attempt = 1; attempt <= IMAGE_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${this.config.authToken}` },
          signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
        });
        if (response.status === 404) throw new Error('images expired on the server');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as { images?: unknown };
        if (!Array.isArray(body.images) || body.images.length !== ref.count) {
          throw new Error('unexpected image payload');
        }
        return body.images as string[];
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        console.warn(`Image download attempt ${attempt} failed: ${lastError}`);
        if (lastError === 'images expired on the server') break;
        if (attempt < IMAGE_DOWNLOAD_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
    throw new Error(`Failed to download ${ref.count} attached image(s): ${lastError}`);
  }

  private async discoverUrl(): Promise<string | null> {
    const dataPath = this.config.dataPath;
    try {
      let text: string;
      if (dataPath.startsWith('http://') || dataPath.startsWith('https://')) {
        const url = `${dataPath.replace(/\/$/, '')}/server-url.txt`;
        const separator = url.includes('?') ? '&' : '?';
        const res = await fetch(`${url}${separator}t=${Date.now()}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(URL_DISCOVERY_TIMEOUT_MS),
        });
        if (!res.ok) {
          console.error(`URL discovery HTTP ${res.status}`);
          return null;
        }
        text = (await res.text()).trim();
      } else {
        // git pull to get latest server URL
        try {
          const { existsSync: gitExists } = await import('fs');
          const { join: gitJoin } = await import('path');
          if (gitExists(gitJoin(dataPath, '.git'))) {
            execSync('git pull --ff-only', { cwd: dataPath, timeout: 15000, stdio: 'pipe' });
            console.log('URL discovery: git pull updated dataPath');
          }
        } catch (e) {
          console.warn('URL discovery: git pull failed (non-fatal):', e instanceof Error ? e.message : e);
        }

        // Fall back to server-url.txt
        const { readFileSync, existsSync } = await import('fs');
        const { join } = await import('path');
        const filePath = join(dataPath, 'server-url.txt');
        if (!existsSync(filePath)) return null;
        text = readFileSync(filePath, 'utf-8').trim();
      }
      return normalizeManagerUrl(text);
    } catch (e) {
      console.error('URL discovery error:', e instanceof Error ? e.message : e);
      return null;
    }
  }

  private reconnectWithDiscovery(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    if (this.discoveryInFlight) return this.discoveryInFlight;

    const now = Date.now();
    if (now - this.lastDiscoveryAt < URL_DISCOVERY_COOLDOWN_MS) {
      return Promise.resolve();
    }
    this.lastDiscoveryAt = now;

    const discovery = (async () => {
      const newUrl = await this.discoverUrl();
      if (this.shuttingDown) return;
      if (!newUrl || newUrl === this.currentUrl) {
        console.log('URL discovery: no change, continuing default reconnect');
        return;
      }

      console.log(`URL discovery: new URL found: ${newUrl}`);
      const oldSocket = this.socket;
      const bufferedEvents = this.getBufferedEvents(oldSocket);

      this.currentUrl = newUrl;
      this.config.managerUrl = newUrl;
      this.stopHeartbeat();
      if (oldSocket) {
        oldSocket.removeAllListeners();
        oldSocket.disconnect();
      }
      this.socket = null;
      this.openSocket(bufferedEvents);
    })().catch((e) => {
      console.error('URL discovery failed:', e instanceof Error ? e.message : e);
    });

    this.discoveryInFlight = discovery;
    void discovery.finally(() => {
      if (this.discoveryInFlight === discovery) {
        this.discoveryInFlight = null;
      }
    });
    return discovery;
  }

  private getBufferedEvents(socket: Socket | null): BufferedEvent[] {
    if (!socket) return [];
    const events: BufferedEvent[] = [];
    for (const packet of socket.sendBuffer) {
      if (Array.isArray(packet.data) && typeof packet.data[0] === 'string') {
        events.push({
          event: packet.data[0],
          args: packet.data.slice(1),
        });
      }
    }
    return events;
  }

  disconnect(): void {
    this.shuttingDown = true;
    this.registered = false;
    this.stopHeartbeat();
    // Runners are detached on purpose: stopping or upgrading the agent must
    // not stop their work. The next agent process re-attaches to them.
    this.stopRunPump();
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    try {
      fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({
        timestamp: new Date().toISOString(),
        connected: false,
        agentId: this.config.agentId,
        runningTasks: [],
      }));
    } catch {
      // Best-effort shutdown marker.
    }
  }

  get isConnected(): boolean {
    return this.socket?.connected || false;
  }
}
