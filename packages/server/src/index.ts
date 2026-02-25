import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from cwd, then fallback to project root
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

import projectsRouter from './routes/projects.js';
import tasksRouter from './routes/tasks.js';
import settingsRouter from './routes/settings.js';
import agentsRouter from './routes/agents.js';
import transcribeRouter from './routes/transcribe.js';
import { setupWebSocket } from './websocket/index.js';
import { startWaitingTaskChecker } from './services/waitingTasks.js';
import { agentPool } from './services/agentPool.js';

// Initialize database (creates tables if needed)
import './services/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// Request logging for debugging
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// API Routes
app.use('/api/projects', projectsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api', tasksRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/transcribe', transcribeRouter);

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

server.listen(PORT, () => {
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
