import { Router } from 'express';
import { agentPool } from '../services/agentPool.js';
import * as storage from '../services/storage.js';

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
