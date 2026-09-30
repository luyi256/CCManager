import type { RequestHandler } from 'express';
import { hashToken } from '../services/auth.js';
import { getStagedDispatchImages } from '../services/dispatchImages.js';
import { findAgentTokenByHash } from '../services/storage.js';

/** Agent-token authenticated download of images staged for a task dispatch. */
export const agentDispatchImagesHandler: RequestHandler = (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  const agentToken = findAgentTokenByHash(hashToken(authHeader.slice(7)));
  if (!agentToken) {
    return res.status(403).json({ error: 'Invalid agent token' });
  }
  const images = getStagedDispatchImages(String(req.params.id), agentToken.agentId);
  if (!images) {
    return res.status(404).json({ error: 'Dispatch images expired or not found' });
  }
  res.json({ images });
};
