import { Router } from 'express';
import * as storage from '../services/storage.js';

const router = Router();

// Get settings
router.get('/', async (req, res) => {
  try {
    const config = await storage.getConfig();
    // Don't expose full tokens
    res.json({
      ...config,
      oauthToken: config.oauthToken ? '***' + config.oauthToken.slice(-8) : undefined,
      anthropicApiKey: config.anthropicApiKey ? '***' + config.anthropicApiKey.slice(-8) : undefined,
      agentAuthToken: config.agentAuthToken ? '***' + config.agentAuthToken.slice(-8) : undefined,
    });
  } catch (error) {
    console.error('Failed to get settings:', error);
    res.status(500).json({ message: 'Failed to get settings' });
  }
});

// Update settings
router.put('/', async (req, res) => {
  try {
    const { defaultAuthType, defaultSecurityMode, oauthToken, anthropicApiKey, agentAuthToken } = req.body;

    const updates: Record<string, unknown> = {};
    if (defaultAuthType) updates.defaultAuthType = defaultAuthType;
    if (defaultSecurityMode) updates.defaultSecurityMode = defaultSecurityMode;
    if (oauthToken) updates.oauthToken = oauthToken;
    if (anthropicApiKey) updates.anthropicApiKey = anthropicApiKey;
    if (agentAuthToken) updates.agentAuthToken = agentAuthToken;

    const config = await storage.updateConfig(updates);

    res.json({
      ...config,
      oauthToken: config.oauthToken ? '***' + config.oauthToken.slice(-8) : undefined,
      anthropicApiKey: config.anthropicApiKey ? '***' + config.anthropicApiKey.slice(-8) : undefined,
      agentAuthToken: config.agentAuthToken ? '***' + config.agentAuthToken.slice(-8) : undefined,
    });
  } catch (error) {
    console.error('Failed to update settings:', error);
    res.status(500).json({ message: 'Failed to update settings' });
  }
});

// Validate auth
router.post('/validate-auth', async (req, res) => {
  try {
    const { type, token } = req.body;

    if (!type || !token) {
      return res.status(400).json({ message: 'Type and token are required' });
    }

    // For now, just validate format
    if (type === 'oauth' && !token.startsWith('sk-ant-')) {
      return res.json({ valid: false, error: 'Invalid OAuth token format' });
    }

    if (type === 'apikey' && !token.startsWith('sk-ant-')) {
      return res.json({ valid: false, error: 'Invalid API key format' });
    }

    res.json({ valid: true });
  } catch (error) {
    console.error('Failed to validate auth:', error);
    res.status(500).json({ message: 'Failed to validate auth' });
  }
});

export default router;
