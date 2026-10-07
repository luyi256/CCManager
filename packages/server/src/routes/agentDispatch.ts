import type { Request, RequestHandler, Response } from 'express';
import { hashToken } from '../services/auth.js';
import { getStagedDispatchImages } from '../services/dispatchImages.js';
import { completeAgentUpload } from '../services/agentUploads.js';
import { findAgentTokenByHash } from '../services/storage.js';

/** HTTP endpoints for agents, authenticated with agent tokens rather than device tokens. */
function authenticateAgent(req: Request, res: Response): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization required' });
    return null;
  }
  const agentToken = findAgentTokenByHash(hashToken(authHeader.slice(7)));
  if (!agentToken) {
    res.status(403).json({ error: 'Invalid agent token' });
    return null;
  }
  return agentToken.agentId;
}

/** Download of images staged for a task dispatch. */
export const agentDispatchImagesHandler: RequestHandler = (req, res) => {
  const agentId = authenticateAgent(req, res);
  if (!agentId) return;
  const images = getStagedDispatchImages(String(req.params.id), agentId);
  if (!images) {
    return res.status(404).json({ error: 'Dispatch images expired or not found' });
  }
  res.json({ images });
};

/** Upload of a requested result such as a session transcript or file preview (gzip-encoded JSON). */
export const agentUploadHandler: RequestHandler = (req, res) => {
  const agentId = authenticateAgent(req, res);
  if (!agentId) return;
  if (!completeAgentUpload(String(req.params.id), agentId, req.body)) {
    return res.status(404).json({ error: 'No pending request for this upload' });
  }
  res.json({ ok: true });
};
