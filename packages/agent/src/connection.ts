import { io, Socket } from 'socket.io-client';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { ClaudeExecutor } from './executor.js';
import { CodexExecutor } from './codexExecutor.js';
import { DockerExecutor } from './docker.js';
import { validatePath } from './security.js';
import { WorktreeManager } from './worktree.js';
import { parseClaudeGrokSettings } from './runnerModels.js';
import type { AgentConfig, TaskRequest, AgentInfo } from './types.js';
import { listSessions, listActiveSessions, getSessionDetail, searchSessions } from './sessions.js';

const execAsync = promisify(exec);

type Executor = ClaudeExecutor | CodexExecutor | DockerExecutor;
type Runner = 'claude' | 'claude-grok' | 'codex' | 'qwen' | 'tclaude' | 'tcodex';

interface BufferedEvent {
  event: string;
  args: unknown[];
}

const HEARTBEAT_INTERVAL_MS = 20000;
const URL_DISCOVERY_COOLDOWN_MS = 5000;
const URL_DISCOVERY_TIMEOUT_MS = 10000;

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

async function listRunnerModels(runner: Runner): Promise<{ ok: boolean; runner: Runner; models?: string[]; raw?: string; error?: string }> {
  const commandByRunner: Record<Runner, string> = {
    claude: 'claude',
    'claude-grok': 'claude-grok',
    codex: 'codex',
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
  }

  connect(): void {
    this.shuttingDown = false;
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
      this.register(socket);
    });

    socket.on('disconnect', (reason) => {
      if (this.socket !== socket) return;
      console.log(`Disconnected from manager: ${reason}`);
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
      const executor = this.executors.get(data.taskId);
      if (executor) {
        executor.cancel();
        this.executors.delete(data.taskId);
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
    socket.on('sessions:list', async (data: { projectPath: string }, callback: (result: unknown) => void) => {
      try {
        console.log(`[sessions] list requested for projectPath: ${data.projectPath}`);
        const sessions = await listSessions(data.projectPath);
        console.log(`[sessions] list result: ${sessions.length} sessions found`);
        callback({ ok: true, sessions });
      } catch (error) {
        console.error(`[sessions] list error:`, error);
        callback({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on('sessions:active', async (data: { projectPath: string }, callback: (result: unknown) => void) => {
      try {
        console.log(`[sessions] active requested for projectPath: ${data.projectPath}`);
        const sessions = await listActiveSessions(data.projectPath);
        console.log(`[sessions] active result: ${sessions.length} sessions found`);
        callback({ ok: true, sessions });
      } catch (error) {
        console.error(`[sessions] active error:`, error);
        callback({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on('sessions:detail', async (data: { projectPath: string; sessionId: string }, callback: (result: unknown) => void) => {
      try {
        const entries = await getSessionDetail(data.projectPath, data.sessionId);
        callback({ ok: true, entries });
      } catch (error) {
        callback({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on('sessions:search', async (data: { projectPath: string; query: string }, callback: (result: unknown) => void) => {
      try {
        console.log(`[sessions] search requested for projectPath: ${data.projectPath}, query: "${data.query}"`);
        const results = await searchSessions(data.projectPath, data.query);
        console.log(`[sessions] search result: ${results.length} sessions matched`);
        callback({ ok: true, results });
      } catch (error) {
        console.error(`[sessions] search error:`, error);
        callback({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on('models:list', async (data: { runner: Runner }, callback: (result: unknown) => void) => {
      if (data.runner !== 'claude' && data.runner !== 'claude-grok' && data.runner !== 'codex' && data.runner !== 'qwen' && data.runner !== 'tclaude' && data.runner !== 'tcodex') {
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

  private register(socket: Socket): void {
    const info: AgentInfo = {
      agentId: this.config.agentId,
      agentName: this.config.agentName,
      capabilities: this.config.capabilities || [],
      status: 'online',
    };

    socket.emit('register', info);
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

  private async handleTask(task: TaskRequest): Promise<void> {
    console.log(`Received task ${task.taskId}: ${task.prompt.substring(0, 50)}...`);
    console.log(`Task ${task.taskId} projectPath: ${task.projectPath}`);

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
      } else {
        // Duplicate dispatch (e.g. reconnect recovery) — skip
        console.log(`Task ${task.taskId}: Already running, skipping duplicate dispatch`);
        return;
      }
    } else if (task.continueSession) {
      // Continue/retry with session resume but no active executor in map.
      // This means the previous executor was removed (by cancel handler or completion).
      // The old process might still be dying (SIGTERM sent, not yet exited).
      // Wait to avoid session file conflicts with --resume.
      console.log(`Task ${task.taskId}: Session resume without active executor, waiting for old process cleanup`);
      await new Promise<void>((resolve) => setTimeout(resolve, 3000));
    }

    let executor: Executor | undefined;
    let executionPath = task.projectPath;

    try {
      // Validate path (use project-level allowedPaths if provided)
      console.log(`Task ${task.taskId}: Validating path...`);
      const effectiveConfig = task.allowedPaths?.length
        ? { ...this.config, allowedPaths: [...this.config.allowedPaths, ...task.allowedPaths] }
        : this.config;
      validatePath(task.projectPath, effectiveConfig);
      console.log(`Task ${task.taskId}: Path validated, creating executor...`);

      // Create worktree if branch is specified
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

      // Create executor based on task runner first, then project executor.
      // Docker execution currently wraps Claude Code only, so Codex uses the
      // local Codex CLI even when the project executor is docker.
      const taskExecutor = task.executor ?? this.config.executor ?? 'local';
      if (task.runner === 'codex' || task.runner === 'tcodex') {
        executor = new CodexExecutor(undefined, task.runner === 'tcodex' ? 'tcodex' : 'codex');
      } else if (task.runner === 'claude-grok') {
        // claude-grok is a host-side Claude Code wrapper with its own local
        // router/config, so it must not be replaced by the plain Docker image.
        executor = new ClaudeExecutor(undefined, 'claude-grok');
      } else if (task.runner === 'qwen') {
        executor = new ClaudeExecutor(undefined, 'qwen');
      } else if (task.runner === 'tclaude') {
        executor = new ClaudeExecutor(undefined, 'tclaude');
      } else if (taskExecutor === 'docker' && this.config.dockerConfig) {
        const dockerConfig = task.dockerImage
          ? { ...this.config.dockerConfig, image: task.dockerImage }
          : this.config.dockerConfig;
        executor = new DockerExecutor(dockerConfig);
      } else {
        executor = new ClaudeExecutor();
      }

      // Store executor for this task
      this.executors.set(task.taskId, executor);

      // Notify running tasks count
      this.socket?.emit('status', {
        status: 'online',
        runningTasks: Array.from(this.executors.keys()),
        taskCount: this.executors.size
      });

      // Set up event handlers
      executor.on('output', (text: string) => {
        this.socket?.emit('task:output', { taskId: task.taskId, text });
      });

      executor.on('tool_use', (data) => {
        this.socket?.emit('task:tool_use', { taskId: task.taskId, ...data });
      });

      executor.on('tool_result', (data) => {
        this.socket?.emit('task:tool_result', { taskId: task.taskId, ...data });
      });

      executor.on('plan_question', (data) => {
        this.socket?.emit('task:plan_question', { taskId: task.taskId, question: data });
      });

      executor.on('permission_request', (data) => {
        this.socket?.emit('task:permission_request', { taskId: task.taskId, request: data });
      });

      executor.on('error', (error: Error) => {
        this.socket?.emit('task:error', { taskId: task.taskId, error: error.message });
      });

      executor.on('session_id', (sessionId: string) => {
        this.socket?.emit('task:session_id', { taskId: task.taskId, sessionId });
      });

      // Execute task (use worktree path if available)
      console.log(`Task ${task.taskId}: Starting execution in ${executionPath}...`);
      await executor.execute(task, executionPath);

      // Check if this execution was superseded by a newer follow-up.
      // If another handleTask call cancelled our executor and replaced it,
      // we must NOT emit task:completed (the newer execution owns the lifecycle).
      if (this.executors.get(task.taskId) !== executor) {
        console.log(`Task ${task.taskId}: Execution superseded by follow-up, skipping completion`);
        return;
      }

      console.log(`Task ${task.taskId}: Execution completed`);

      // Run post-task hook if configured
      if (task.postTaskHook) {
        console.log(`Task ${task.taskId}: Running post-task hook...`);
        this.socket?.emit('task:output', {
          taskId: task.taskId,
          text: `\n[Post-Task Hook] Running: ${task.postTaskHook}\n`,
        });
        try {
          const { stdout, stderr } = await execAsync(task.postTaskHook, {
            cwd: executionPath,
            timeout: 30000,
          });
          if (stdout) {
            this.socket?.emit('task:output', { taskId: task.taskId, text: `[Post-Task Hook] ${stdout}` });
          }
          if (stderr) {
            this.socket?.emit('task:output', { taskId: task.taskId, text: `[Post-Task Hook] ${stderr}` });
          }
          console.log(`Task ${task.taskId}: Post-task hook completed`);
        } catch (hookError) {
          const msg = hookError instanceof Error ? hookError.message : String(hookError);
          console.error(`Task ${task.taskId}: Post-task hook failed:`, msg);
          this.socket?.emit('task:output', {
            taskId: task.taskId,
            text: `[Post-Task Hook] Failed: ${msg}\n`,
          });
        }
      }

      // Task completed - include sessionId so server can preserve it
      const sessionId = 'getSessionId' in executor ? executor.getSessionId() : undefined;
      this.socket?.emit('task:completed', {
        taskId: task.taskId,
        status: 'completed',
        sessionId,
        startedAt: task.startedAt,
      });
    } catch (error) {
      // Don't report failure if this execution was superseded
      if (executor && this.executors.get(task.taskId) !== executor) {
        console.log(`Task ${task.taskId}: Superseded execution errored (ignored)`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Task ${task.taskId} failed:`, message);
      this.socket?.emit('task:failed', {
        taskId: task.taskId,
        error: message,
        startedAt: task.startedAt,
      });
    } finally {
      // Only clean up if this is still the current executor for this task
      if (executor && this.executors.get(task.taskId) === executor) {
        this.executors.delete(task.taskId);
        this.socket?.emit('status', {
          status: 'online',
          runningTasks: Array.from(this.executors.keys()),
          taskCount: this.executors.size
        });
      }
    }
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
    this.stopHeartbeat();
    // Cancel all running tasks
    for (const executor of this.executors.values()) {
      executor.cancel();
    }
    this.executors.clear();
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
  }

  get isConnected(): boolean {
    return this.socket?.connected || false;
  }
}
