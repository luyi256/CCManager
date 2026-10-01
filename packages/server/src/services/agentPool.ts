import type { Socket, Namespace } from 'socket.io';
import { db } from './database.js';
import { validateRunnerSelection } from './runnerModels.js';
import { INLINE_IMAGE_BYTES, imagesByteSize, stageDispatchImages } from './dispatchImages.js';
import { expectSessionDetailUpload } from './sessionDetailUploads.js';

// Long transcripts can take minutes to upload over slow agent links.
const SESSION_DETAIL_TIMEOUT_MS = 180_000;
import type { Runner } from '../types/index.js';

export interface ConnectedAgent {
  socket: Socket;
  agentId: string;
  agentName: string;
  capabilities: string[];
  executor: 'local' | 'docker';
  status: 'online' | 'offline';
  runningTasks: number[];
  lastHeartbeat: number;
}

class AgentPool {
  private agents: Map<string, ConnectedAgent> = new Map();
  private agentNamespace: Namespace | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  /** User input (plan answers, permission responses) sent while the agent was unreachable. */
  private pendingInputs: Map<string, Array<{ taskId: number; input: string }>> = new Map();

  setNamespace(ns: Namespace): void {
    this.agentNamespace = ns;
    this.startHeartbeatMonitor();
  }

  register(socket: Socket, info: {
    agentId: string;
    agentName: string;
    capabilities: string[];
    executor?: 'local' | 'docker';
    runningTasks?: Array<{ taskId: number; sessionId?: string; startedAt?: string }>;
  }): void {
    const agent: ConnectedAgent = {
      socket,
      agentId: info.agentId,
      agentName: info.agentName,
      capabilities: info.capabilities,
      executor: info.executor || 'local',
      status: 'online',
      runningTasks: info.runningTasks?.map((task) => task.taskId) || [],
      lastHeartbeat: Date.now(),
    };

    this.agents.set(info.agentId, agent);

    // Update database
    const stmt = db.prepare(`
      INSERT INTO agents (id, name, capabilities, executor, status, last_seen)
      VALUES (?, ?, ?, ?, 'online', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        capabilities = excluded.capabilities,
        executor = excluded.executor,
        status = 'online',
        last_seen = datetime('now')
    `);
    stmt.run(
      info.agentId,
      info.agentName,
      JSON.stringify(info.capabilities),
      info.executor || 'local'
    );

    console.log(`Agent registered: ${info.agentName} (${info.agentId})`);
  }

  unregister(agentId: string, socket?: Socket): void {
    const agent = this.agents.get(agentId);
    if (socket && agent?.socket !== socket) return;
    if (agent) {
      // Disconnect socket to release resources
      try {
        agent.socket.disconnect(true);
      } catch (err) {
        console.error(`Error disconnecting agent ${agentId}:`, err);
      }
    }
    this.agents.delete(agentId);

    // Update database
    const stmt = db.prepare(`UPDATE agents SET status = 'offline' WHERE id = ?`);
    stmt.run(agentId);

    console.log(`Agent unregistered: ${agentId}`);
  }

  updateStatus(agentId: string, status: 'online' | 'offline', runningTasks?: number[]): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.status = status;
      agent.runningTasks = runningTasks || [];
      agent.lastHeartbeat = Date.now();

      // Update database
      const stmt = db.prepare(`UPDATE agents SET status = ?, last_seen = datetime('now') WHERE id = ?`);
      stmt.run(status, agentId);
    }
  }

  getAgent(agentId: string): ConnectedAgent | undefined {
    return this.agents.get(agentId);
  }

  getOnlineAgents(): ConnectedAgent[] {
    return Array.from(this.agents.values());
  }

  getAllAgents(): Array<{
    id: string;
    name: string;
    capabilities: string[];
    executor: string;
    status: string;
    lastSeen?: string;
  }> {
    const stmt = db.prepare('SELECT * FROM agents ORDER BY name');
    const rows = stmt.all() as Array<{
      id: string;
      name: string;
      capabilities: string;
      executor: string;
      status: string;
      last_seen: string | null;
    }>;

    return rows.map((row) => {
      const connected = this.agents.get(row.id);
      let capabilities: string[] = [];
      try {
        capabilities = JSON.parse(row.capabilities || '[]');
      } catch (e) {
        console.error(`Failed to parse capabilities for agent ${row.id}:`, e);
      }
      return {
        id: row.id,
        name: row.name,
        capabilities,
        executor: row.executor,
        status: connected ? connected.status : 'offline',
        lastSeen: row.last_seen || undefined,
      };
    });
  }

  // Check if agent has required capabilities (Bug #15 fix)
  hasCapabilities(agentId: string, requiredCapabilities: string[]): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (!requiredCapabilities || requiredCapabilities.length === 0) return true;

    return requiredCapabilities.every(cap => agent.capabilities.includes(cap));
  }

  // Get missing capabilities for an agent
  getMissingCapabilities(agentId: string, requiredCapabilities: string[]): string[] {
    const agent = this.agents.get(agentId);
    if (!agent) return requiredCapabilities;
    if (!requiredCapabilities || requiredCapabilities.length === 0) return [];

    return requiredCapabilities.filter(cap => !agent.capabilities.includes(cap));
  }

  dispatchTask(agentId: string, task: {
    taskId: number;
    projectId: string;
    projectPath: string;
    prompt: string;
    isPlanMode: boolean;
    runner?: Runner;
    model?: string;
    reasoningEffort?: string;
    executor?: 'local' | 'docker';
    dockerImage?: string;
    worktreeBranch?: string;
    requiredCapabilities?: string[];
    skipModelValidation?: boolean;
    continueSession?: boolean;
    sessionId?: string;
    postTaskHook?: string;
    extraMounts?: Array<{ source: string; target: string; readonly?: boolean }>;
    allowedPaths?: string[];
    images?: string[];
    startedAt?: string;
    isRetry?: boolean;
    attempt?: number;
    recovery?: boolean;
  }): boolean {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== 'online') {
      console.error(`Agent ${agentId} not available for task dispatch`);
      return false;
    }
    if (!task.skipModelValidation) {
      const selection = validateRunnerSelection(
        agent.capabilities,
        task.runner ?? 'claude',
        task.model
      );
      if (selection.error) {
        console.error(`Agent ${agentId} rejected task ${task.taskId} model selection: ${selection.error}`);
        return false;
      }
    }

    // Check capabilities match (Bug #15 fix)
    if (task.requiredCapabilities && task.requiredCapabilities.length > 0) {
      const missing = this.getMissingCapabilities(agentId, task.requiredCapabilities);
      if (missing.length > 0) {
        console.error(`Agent ${agentId} missing required capabilities: ${missing.join(', ')}`);
        return false;
      }
    }

    const payload: typeof task & { imagesRef?: { id: string; count: number; bytes: number } } = { ...task };
    if (task.images?.length) {
      const bytes = imagesByteSize(task.images);
      if (bytes > INLINE_IMAGE_BYTES) {
        payload.images = undefined;
        payload.imagesRef = {
          id: stageDispatchImages(agentId, task.taskId, task.images),
          count: task.images.length,
          bytes,
        };
      }
    }
    agent.socket.emit('task:execute', payload);
    // Add task to running tasks list
    if (!agent.runningTasks.includes(task.taskId)) {
      agent.runningTasks.push(task.taskId);
    }
    return true;
  }

  sendInput(agentId: string, taskId: number, input: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || !agent.socket.connected) {
      const queued = this.pendingInputs.get(agentId) || [];
      queued.push({ taskId, input });
      this.pendingInputs.set(agentId, queued);
      return;
    }
    if (agent.runningTasks.includes(taskId)) {
      agent.socket.emit('task:input', { taskId, input });
    }
  }

  /** Deliver input queued while offline to tasks that survived the disconnect. */
  flushPendingInputs(agentId: string, runningTaskIds: Set<number>): void {
    const queued = this.pendingInputs.get(agentId);
    this.pendingInputs.delete(agentId);
    const agent = this.agents.get(agentId);
    if (!queued || !agent) return;
    for (const { taskId, input } of queued) {
      if (runningTaskIds.has(taskId)) {
        agent.socket.emit('task:input', { taskId, input });
      }
    }
  }

  cancelTask(agentId: string, taskId: number): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.socket.emit('task:cancel', { taskId });
    }
  }

  mergeWorktree(agentId: string, data: { taskId: number; projectPath: string; branch: string; deleteBranch: boolean }): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.socket.emit('task:merge', data);
    return true;
  }

  cleanupWorktree(agentId: string, data: { taskId: number; projectPath: string; branch: string }): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.socket.emit('task:cleanup-worktree', data);
    return true;
  }

  /** Ask agent to list CLI sessions for a project path (10s timeout). */
  requestSessions(agentId: string, projectPath: string, projectId?: string): Promise<unknown> {
    const agent = this.agents.get(agentId);
    if (!agent) return Promise.reject(new Error('Agent not connected'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Agent timeout')), 10000);
      agent.socket.emit('sessions:list', { projectPath, projectId }, (result: unknown) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  /** Ask agent to list active (running) CLI sessions (5s timeout). */
  requestActiveSessions(agentId: string, projectPath: string, projectId?: string): Promise<unknown> {
    const agent = this.agents.get(agentId);
    if (!agent) return Promise.reject(new Error('Agent not connected'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Agent timeout')), 5000);
      agent.socket.emit('sessions:active', { projectPath, projectId }, (result: unknown) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  /** Ask agent to search sessions (20s timeout for scanning all files). */
  requestSessionSearch(agentId: string, projectPath: string, query: string, projectId?: string): Promise<unknown> {
    const agent = this.agents.get(agentId);
    if (!agent) return Promise.reject(new Error('Agent not connected'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Agent timeout')), 20000);
      agent.socket.emit('sessions:search', { projectPath, query, projectId }, (result: unknown) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  /**
   * Ask agent to get session detail. The transcript itself is uploaded over
   * HTTP; the Socket.IO acknowledgement only reports whether that worked.
   * Agents without HTTP upload support still return it in the acknowledgement.
   */
  requestSessionDetail(
    agentId: string,
    projectPath: string,
    runner: Runner,
    sessionId: string,
    relatedSessionIds?: string[],
    projectId?: string,
  ): Promise<unknown> {
    const agent = this.agents.get(agentId);
    if (!agent) return Promise.reject(new Error('Agent not connected'));
    const upload = expectSessionDetailUpload(agentId);
    return new Promise((resolve, reject) => {
      const finish = (result: unknown) => {
        clearTimeout(timer);
        upload.cancel();
        resolve(result);
      };
      const timer = setTimeout(() => {
        upload.cancel();
        reject(new Error('Agent timeout'));
      }, SESSION_DETAIL_TIMEOUT_MS);
      void upload.promise.then(finish);
      agent.socket.emit('sessions:detail', {
        projectPath,
        projectId,
        runner,
        sessionId,
        relatedSessionIds,
        uploadId: upload.id,
      }, (result: unknown) => {
        const marker = result as { ok?: boolean; uploaded?: boolean } | null;
        if (marker?.ok && marker.uploaded) return; // the HTTP upload resolves it
        finish(result);
      });
    });
  }

  private startHeartbeatMonitor(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      // Keep this above the agent's 20-second status interval and Engine.IO's
      // transport timeout. A transient slow transfer must not turn every
      // running task into an orphan and start a recovery storm.
      const timeout = 180000; // 3 minutes

      for (const [agentId, agent] of this.agents.entries()) {
        if (now - agent.lastHeartbeat > timeout) {
          console.log(`Agent ${agentId} heartbeat timeout`);
          this.unregister(agentId);
        }
      }
    }, 30000); // Check every 30 seconds
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
}

export const agentPool = new AgentPool();
