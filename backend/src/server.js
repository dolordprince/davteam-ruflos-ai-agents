// backend/src/server.js — Production HTTP server around the real Ruflo runtime.
// DavTeam Ruflos AI Agents — backend entry point.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { logger } from './logger.js';
import { rufloAvailable, getRufloVersion, getCapabilities } from './ruflo-runtime.js';
import { taskManager } from './task-manager.js';
import { apiRouter } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

// --- Ensure workspace exists ---
const workspace = config.workspace;
if (!existsSync(workspace)) {
  try { mkdirSync(workspace, { recursive: true }); } catch { /* may be read-only */ }
}

const app = express();
const server = createServer(app);

// --- Security middleware ---
app.use(helmet({
  contentSecurityPolicy: false, // frontend is a separate static SPA
  crossOriginEmbedderPolicy: false,
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- Rate limiting ---
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// --- Auth middleware (optional token) ---
app.use((req, res, next) => {
  if (config.apiToken) {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (token !== config.apiToken) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API token' } });
    }
  }
  next();
});

// --- Request logging ---
app.use((req, _res, next) => {
  logger.info('http.request', { method: req.method, path: req.path });
  next();
});

// --- API routes (includes SSE streaming endpoints) ---
app.use(apiRouter);

// --- WebSocket server for bidirectional streaming ---
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  logger.info('ws.connected', { url: req.url });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    if (msg.type === 'agent.run') {
      const { prompt, agentType = 'coder', sessionId } = msg;
      const task = await taskManager.runAgentTask({
        prompt, agentType, sessionId,
        onEvent: (e) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
        },
      });
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'task.final', task }));
      }
    } else if (msg.type === 'subscribe') {
      const { taskId } = msg;
      const onEvent = (event) => {
        if (event.taskId === taskId && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(event));
        }
      };
      taskManager.on('event', onEvent);
      ws.on('close', () => taskManager.off('event', onEvent));
    }
  });
});

// --- Serve static frontend (if built) ---
const frontendDist = join(PROJECT_ROOT, 'frontend', 'dist');
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  // SPA fallback — Express 5 requires a named wildcard, not bare '*'
  app.get('{*path}', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.sendFile(join(frontendDist, 'index.html'));
  });
}

// --- Global error handler ---
app.use((err, req, res, _next) => {
  logger.error('unhandled.error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
});

// --- Start ---
async function start() {
  const ver = await getRufloVersion();
  const caps = await getCapabilities();
  logger.info('startup', {
    service: 'davteam-ruflos-ai-agents',
    ruflo: rufloAvailable,
    rufloVersion: ver.version,
    capabilities: caps,
    workspace: config.workspace,
  });

  server.listen(config.port, config.host, () => {
    logger.info('server.listening', { host: config.host, port: config.port });
    console.log(`\n  DavTeam Ruflos AI Agents`);
    console.log(`  ─────────────────────────`);
    console.log(`  Ruflo:  ${rufloAvailable ? `v${ver.version} ✓` : 'NOT FOUND ✗'}`);
    console.log(`  Osiri:  ready`);
    console.log(`  API:    http://${config.host}:${config.port}`);
    console.log(`  Health: http://${config.host}:${config.port}/health\n`);
  });

  // Graceful shutdown
  const shutdown = (sig) => {
    logger.info('shutdown', { signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error('fatal', { error: err.message, stack: err.stack });
  process.exit(1);
});

export { app, server };
