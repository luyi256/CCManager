import { Router } from 'express';
import { agentPool } from '../services/agentPool.js';
import * as storage from '../services/storage.js';
import { generateToken, hashToken } from '../services/auth.js';
import { db } from '../services/database.js';

const router = Router();

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
