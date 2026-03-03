import { Router } from 'express';
import { hashToken } from '../services/auth.js';
import { findDeviceByHash, listDevices, deleteDevice } from '../services/storage.js';

const router = Router();

// GET /api/auth/me — return current device info based on Bearer token
router.get('/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const token = authHeader.slice(7);
  const tokenHash = hashToken(token);
  const device = findDeviceByHash(tokenHash);

  if (!device) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  res.json({
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastUsedAt: device.lastUsedAt,
  });
});

// GET /api/auth/devices — list all registered devices (authenticated)
router.get('/devices', (_req, res) => {
  const devices = listDevices();
  res.json(
    devices.map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      lastUsedAt: d.lastUsedAt,
    }))
  );
});

// DELETE /api/auth/devices/:id — revoke a device token (authenticated)
router.delete('/devices/:id', (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid device ID' });
  }
  const deleted = deleteDevice(id);
  if (!deleted) {
    return res.status(404).json({ error: 'Device not found' });
  }
  res.json({ ok: true });
});

export default router;
