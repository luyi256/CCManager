import { Router } from 'express';
import { agentPool } from '../services/agentPool.js';
import * as storage from '../services/storage.js';
import { generateToken, hashToken } from '../services/auth.js';
import { db } from '../services/database.js';
import type { Runner } from '../types/index.js';

const router = Router();
const VALID_MODEL_RUNNERS = new Set<Runner>(['claude', 'codex', 'qwen', 'tclaude', 'tcodex']);

// Coding CLIs can't enumerate models non-interactively — `<cli> -p "/model"` just sends
// "/model" as a prompt and burns a full agent turn (codex literally replies "I'm Codex").
// So we serve a known, instant list per runner instead of a slow, costly, useless call.
// "Use default model" is always available in the UI. Values are what each CLI accepts for
// its --model flag; edit here as CLIs add or rename models.
const KNOWN_MODELS: Record<Runner, string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  tclaude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5-codex', 'gpt-5', 'o3'],
  tcodex: ['gpt-5-codex', 'gpt-5', 'o3'],
  qwen: ['qwen3-coder-plus', 'qwen3-coder-flash'],
};

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

// Get available models for a coding CLI. Served instantly from a known list —
// no agent round-trip (see KNOWN_MODELS above for why).
router.get('/:id/models', async (req, res) => {
  const runner = req.query.runner;
  if (typeof runner !== 'string' || !VALID_MODEL_RUNNERS.has(runner as Runner)) {
    return res.status(400).json({ message: 'Invalid runner' });
  }
  const typedRunner = runner as Runner;
  res.json({
    runner: typedRunner,
    models: KNOWN_MODELS[typedRunner] ?? [],
    cached: true,
    pending: false,
  });
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
