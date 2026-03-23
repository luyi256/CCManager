import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// Load .env from repo root
// At runtime: __server_dir = packages/server/dist, repo root is 3 levels up
// At dev (tsx): __server_dir = packages/server/src, repo root is 3 levels up
const __server_dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__server_dir, '../../../.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config(); // fallback: cwd
}

// Load secrets from DATA_PATH/secrets.env (credentials centralized there)
const dataPath = process.env.DATA_PATH;
if (dataPath) {
  const secretsPath = resolve(dataPath, 'secrets.env');
  if (existsSync(secretsPath)) {
    dotenv.config({ path: secretsPath, override: false });
  }
}
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import path from 'path';
import rateLimit from 'express-rate-limit';

import projectsRouter from './routes/projects.js';
import tasksRouter from './routes/tasks.js';
import settingsRouter from './routes/settings.js';
import agentsRouter from './routes/agents.js';
import transcribeRouter from './routes/transcribe.js';
import sessionsRouter from './routes/sessions.js';
import authRouter from './routes/auth.js';
import { setupWebSocket } from './websocket/index.js';
import { startWaitingTaskChecker } from './services/waitingTasks.js';
import { agentPool } from './services/agentPool.js';
import { hashToken } from './services/auth.js';
import { findDeviceByHash, updateDeviceLastUsed } from './services/storage.js';

// Initialize database (creates tables if needed)
import './services/database.js';

const __dirname = __server_dir;

const app = express();
// Trust proxy (Cloudflare tunnel adds X-Forwarded-For)
app.set('trust proxy', 1);
const server = createServer(app);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
  },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// CORS — only allow same-origin requests
app.use(cors({ origin: false }));
app.use(express.json({ limit: '50mb' }));

// Rate limiting — 100 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api', apiLimiter);

// Request logging for debugging
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// API authentication middleware — device-token based
app.use('/api', (req, res, next) => {
  // Public endpoints: health check
  if (req.path === '/health') return next();

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

  // Update last_used_at with debounce
  updateDeviceLastUsed(tokenHash);
  next();
});

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api', tasksRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/transcribe', transcribeRouter);
app.use('/api', sessionsRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static files in production
const webDistPath = process.env.STATIC_PATH || path.resolve(__dirname, '../../web/dist');
if (process.env.NODE_ENV === 'production' || process.env.SERVE_STATIC === 'true') {
  console.log(`Serving static files from: ${webDistPath}`);
  // Disable caching for development
  app.use((req, res, next) => {
    if (req.path.endsWith('.js') || req.path.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    next();
  });
  app.use(express.static(webDistPath));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/socket.io')) {
      res.sendFile(path.join(webDistPath, 'index.html'));
    }
  });
}

// WebSocket (Socket.IO)
setupWebSocket(server);

// Start waiting task checker
startWaitingTaskChecker();

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';

server.listen(Number(PORT), HOST, () => {
  console.log(`CCManager server running on port ${PORT}`);
  console.log(`- API: http://localhost:${PORT}/api`);
  console.log(`- Socket.IO: http://localhost:${PORT}`);
  console.log(`  - Agent namespace: /agent`);
  console.log(`  - User namespace: /`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  agentPool.stop();
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  agentPool.stop();
  server.close(() => {
    process.exit(0);
  });
});
