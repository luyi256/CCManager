import { Router } from 'express';
import { agentPool } from '../services/agentPool.js';
import * as storage from '../services/storage.js';
import { generateToken, hashToken } from '../services/auth.js';
import { db } from '../services/database.js';
import type { Runner } from '../types/index.js';

const router = Router();
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface RunnerModelsResponse {
  ok?: boolean;
  runner: Runner;
  models: string[];
  raw?: string;
  cached?: boolean;
  updatedAt?: string;
}

function getCachedModels(agentId: string, runner: Runner): RunnerModelsResponse | null {
  const row = db.prepare(
    'SELECT models, raw, updated_at FROM model_cache WHERE agent_id = ? AND runner = ?'
  ).get(agentId, runner) as { models: string; raw: string | null; updated_at: string } | undefined;

  if (!row) return null;

  try {
    const updatedAtMs = new Date(row.updated_at).getTime();
    if (Number.isNaN(updatedAtMs) || Date.now() - updatedAtMs > MODEL_CACHE_TTL_MS) {
      return null;
    }

    return {
      runner,
      models: JSON.parse(row.models) as string[],
      raw: row.raw || undefined,
      cached: true,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

function saveModelCache(agentId: string, result: RunnerModelsResponse): RunnerModelsResponse {
  const updatedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO model_cache (agent_id, runner, models, raw, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, runner) DO UPDATE SET
      models = excluded.models,
      raw = excluded.raw,
      updated_at = excluded.updated_at
  `).run(agentId, result.runner, JSON.stringify(result.models), result.raw || null, updatedAt);

  return { ...result, cached: false, updatedAt };
}

// Get all agents (both connected and offline)
router.get('/', async (req, res) => {
  try {
    const agents = agentPool.getAllAgents();
    res.json(agents);
  } catch (error) {
    console.error('Failed to get agents:', error);
    res.status(500).json({ message: 'Failed to get agents' });
  }
});

// Get online agents only
router.get('/online', async (req, res) => {
  try {
    const agents = agentPool.getOnlineAgents().map((agent) => ({
      id: agent.agentId,
      name: agent.agentName,
      capabilities: agent.capabilities,
      executor: agent.executor,
      status: agent.status,
    }));
    res.json(agents);
  } catch (error) {
    console.error('Failed to get online agents:', error);
    res.status(500).json({ message: 'Failed to get online agents' });
  }
});

// Get available models for a coding CLI by asking the agent to run /model.
router.get('/:id/models', async (req, res) => {
  try {
    const runner = req.query.runner;
    if (runner !== 'claude' && runner !== 'codex' && runner !== 'qwen') {
      return res.status(400).json({ message: 'Invalid runner' });
    }

    const typedRunner = runner as Runner;
    const force = req.query.force === '1' || req.query.force === 'true';
    if (!force) {
      const cached = getCachedModels(req.params.id, typedRunner);
      if (cached) {
        return res.json(cached);
      }
    }

    const result = await agentPool.requestModels(req.params.id, typedRunner);
    if (
      typeof result === 'object' &&
      result !== null &&
      'ok' in result &&
      (result as { ok?: boolean }).ok === false
    ) {
      return res.status(502).json({
        message: (result as { error?: string }).error || 'Failed to load models',
      });
    }

    const modelResult = result as RunnerModelsResponse;
    res.json(saveModelCache(req.params.id, {
      runner: typedRunner,
      models: Array.isArray(modelResult.models) ? modelResult.models : [],
      raw: modelResult.raw,
    }));
  } catch (error) {
    console.error('Failed to get runner models:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to get runner models' });
  }
});

// Pre-register an agent and generate its token
router.post('/register', async (req, res) => {
  try {
    const { agentId, agentName } = req.body;

    if (!agentId || typeof agentId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      return res.status(400).json({ message: 'Invalid agent ID (alphanumeric, hyphens, underscores only)' });
    }

    const name = agentName || agentId;

    // Upsert agent record in DB
    db.prepare(`
      INSERT INTO agents (id, name, capabilities, executor, status)
      VALUES (?, ?, '[]', 'local', 'offline')
      ON CONFLICT(id) DO UPDATE SET name = excluded.name
    `).run(agentId, name);

    // Generate token
    const token = generateToken();
    const tokenHash = hashToken(token);
    storage.createAgentToken(agentId, tokenHash);

    res.json({
      agentId,
      agentName: name,
      token, // Plain-text token — shown only once
    });
  } catch (error) {
    console.error('Failed to register agent:', error);
    res.status(500).json({ message: 'Failed to register agent' });
  }
});

// Generate/regenerate token for an existing agent
router.post('/:id/token', async (req, res) => {
  try {
    const agentId = req.params.id;
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      return res.status(404).json({ message: 'Agent not found' });
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    storage.createAgentToken(agentId, tokenHash);

    res.json({ agentId, token }); // Plain-text token — shown only once
  } catch (error) {
    console.error('Failed to generate agent token:', error);
    res.status(500).json({ message: 'Failed to generate agent token' });
  }
});

// Get agent token status (no plain-text)
router.get('/:id/token', async (req, res) => {
  try {
    const agentId = req.params.id;
    const info = storage.getAgentTokenInfo(agentId);
    res.json({ agentId, ...info });
  } catch (error) {
    console.error('Failed to get agent token info:', error);
    res.status(500).json({ message: 'Failed to get agent token info' });
  }
});

// Revoke agent token
router.delete('/:id/token', async (req, res) => {
  try {
    const agentId = req.params.id;
    const deleted = storage.deleteAgentToken(agentId);
    if (!deleted) {
      return res.status(404).json({ message: 'No token found for this agent' });
    }
    res.json({ message: 'Token revoked' });
  } catch (error) {
    console.error('Failed to revoke agent token:', error);
    res.status(500).json({ message: 'Failed to revoke agent token' });
  }
});

// Get single agent
router.get('/:id', async (req, res) => {
  try {
    const agent = await storage.getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ message: 'Agent not found' });
    }

    // Check if connected
    const connected = agentPool.getAgent(req.params.id);
    if (connected) {
      agent.status = connected.status;
    }

    res.json(agent);
  } catch (error) {
    console.error('Failed to get agent:', error);
    res.status(500).json({ message: 'Failed to get agent' });
  }
});

export default router;
