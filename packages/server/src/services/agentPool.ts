import type { Socket, Namespace } from 'socket.io';
import { db } from './database.js';

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

  setNamespace(ns: Namespace): void {
    this.agentNamespace = ns;
    this.startHeartbeatMonitor();
  }

  register(socket: Socket, info: {
    agentId: string;
    agentName: string;
    capabilities: string[];
    executor: 'local' | 'docker';
  }): void {
    const agent: ConnectedAgent = {
      socket,
      agentId: info.agentId,
      agentName: info.agentName,
      capabilities: info.capabilities,
      executor: info.executor,
      status: 'online',
      runningTasks: [],
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
      info.executor
    );

    console.log(`Agent registered: ${info.agentName} (${info.agentId})`);
  }

  unregister(agentId: string): void {
    const agent = this.agents.get(agentId);
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
    worktreeBranch?: string;
    requiredCapabilities?: string[];
    continueSession?: boolean;
    sessionId?: string;
    postTaskHook?: string;
  }): boolean {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== 'online') {
      console.error(`Agent ${agentId} not available for task dispatch`);
      return false;
    }

    // Check capabilities match (Bug #15 fix)
    if (task.requiredCapabilities && task.requiredCapabilities.length > 0) {
      const missing = this.getMissingCapabilities(agentId, task.requiredCapabilities);
      if (missing.length > 0) {
        console.error(`Agent ${agentId} missing required capabilities: ${missing.join(', ')}`);
        return false;
      }
    }

    agent.socket.emit('task:execute', task);
    // Add task to running tasks list
    if (!agent.runningTasks.includes(task.taskId)) {
      agent.runningTasks.push(task.taskId);
    }
    return true;
  }

  sendInput(agentId: string, taskId: number, input: string): void {
    const agent = this.agents.get(agentId);
    if (agent && agent.runningTasks.includes(taskId)) {
      agent.socket.emit('task:input', { taskId, input });
    }
  }

  cancelTask(agentId: string, taskId: number): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.socket.emit('task:cancel', { taskId });
    }
  }

  private startHeartbeatMonitor(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const timeout = 60000; // 60 seconds

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
