// backend/src/routes.js — API route handlers exposing real Ruflo functionality.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { config, isConfigured } from './config.js';
import {
  rufloAvailable, getRufloVersion, runRuflo, runRufloJson,
  runDoctor, getCapabilities,
} from './ruflo-runtime.js';
import { taskManager } from './task-manager.js';
import { executeCommand } from './command-exec.js';
import { safePath, validateCommand, auditLog, PathValidationError, CommandValidationError } from './workspace.js';
import { readFileSync, existsSync } from 'node:fs';
import { listProviders, listModels, chatCompletion, ProviderError } from './provider.js';
import {
  listPlugins, getPlugin, jevPluginInfo, jevTools, executeJevTool, jevConfigured, JevError,
} from './jev-plugin.js';
import { autonomousBuilder } from './autonomous-builder.js';
import { taskStore } from './task-store.js';
import { getTaskStatusSummary, handleFailure, resumeFromCheckpoint } from './resilience.js';

const router = Router();

// --- Helpers ---

function apiError(res, code, message, status = 500, extra = {}) {
  logger.error('api.error', { code, message, ...extra });
  res.status(status).json({ error: { code, message, ...extra } });
}

// --- Health & version ---

router.get('/health', async (req, res) => {
  const ver = await getRufloVersion();
  res.json({
    status: rufloAvailable ? 'ok' : 'degraded',
    service: 'davteam-ruflos-ai-agents',
    ruflo: rufloAvailable,
    rufloVersion: ver.version,
    osiri: true,
    timestamp: new Date().toISOString(),
  });
});

router.get('/api/health', async (req, res) => {
  const ver = await getRufloVersion();
  const caps = await getCapabilities();
  res.json({
    status: rufloAvailable ? 'ok' : 'degraded',
    service: 'davteam-ruflos-ai-agents',
    ruflo: rufloAvailable,
    rufloVersion: ver.version,
    osiri: true,
    capabilities: caps,
    timestamp: new Date().toISOString(),
  });
});

router.get('/api/version', async (req, res) => {
  const ver = await getRufloVersion();
  res.json({
    service: 'davteam-ruflos-ai-agents',
    version: '1.0.0',
    ruflo: {
      version: ver.version,
      available: rufloAvailable,
    },
    node: process.version,
  });
});

router.get('/api/capabilities', async (req, res) => {
  const caps = await getCapabilities();
  const configured = isConfigured();
  res.json({
    ...caps,
    modelProviders: configured,
    workspace: config.workspace,
    streaming: true,
    security: { workspaceIsolation: true, pathValidation: true, commandValidation: true },
  });
});

// --- Models ---

router.get('/api/models', (req, res) => {
  // Never expose API keys
  res.json({ models: listModels(), providers: listProviders() });
});

// --- Chat (direct model proxy, server-side credentials only) ---

router.post('/api/chat', async (req, res) => {
  const { messages, model, stream } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return apiError(res, 'INVALID_REQUEST', 'messages array is required', 400);
  }
  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(`data: ${JSON.stringify({ type: 'chat.started', model: model || config.modelName })}\n\n`);
      const result = await chatCompletion({
        messages, model,
        onToken: (token) => res.write(`data: ${JSON.stringify({ type: 'chat.token', token })}\n\n`),
      });
      res.write(`data: ${JSON.stringify({ type: 'chat.done', model: result.model })}\n\n`);
      res.end();
    } else {
      const result = await chatCompletion({ messages, model });
      res.json({ content: result.content, model: result.model, usage: result.usage });
    }
  } catch (err) {
    if (err instanceof ProviderError) {
      return apiError(res, err.code, err.message, 502, { details: err.details });
    }
    return apiError(res, 'CHAT_FAILED', err.message, 500);
  }
});

// --- Agents ---

router.get('/api/agents', async (req, res) => {
  try {
    const result = await runRufloJson(['agent', 'list'], { timeout: 30000 });
    res.json(result.json || { agents: [], total: 0 });
  } catch (err) {
    apiError(res, 'AGENTS_LIST_FAILED', err.message, 500);
  }
});

router.post('/api/agents/spawn', async (req, res) => {
  const { type = 'coder' } = req.body || {};
  try {
    const result = await runRufloJson(['agent', 'spawn', '-t', type], { timeout: 30000 });
    if (result.exitCode !== 0 && !result.json) {
      return apiError(res, 'AGENT_SPAWN_FAILED', result.stderr || 'Spawn failed', 500);
    }
    res.json(result.json || { success: false, stderr: result.stderr });
  } catch (err) {
    apiError(res, 'AGENT_SPAWN_FAILED', err.message, 500);
  }
});

router.post('/api/agent/run', async (req, res) => {
  const { prompt, agentType = 'coder', sessionId } = req.body || {};
  if (!prompt) return apiError(res, 'INVALID_REQUEST', 'prompt is required', 400);
  try {
    const task = await taskManager.runAgentTask({ prompt, agentType, sessionId });
    res.json(task);
  } catch (err) {
    apiError(res, 'AGENT_RUN_FAILED', err.message, 500);
  }
});

// --- Tasks ---

router.post('/api/task', async (req, res) => {
  const { prompt, agentType, sessionId, type } = req.body || {};
  if (!prompt) return apiError(res, 'INVALID_REQUEST', 'prompt is required', 400);
  try {
    const task = await taskManager.runAgentTask({ prompt, agentType, sessionId });
    res.json(task);
  } catch (err) {
    apiError(res, 'TASK_FAILED', err.message, 500, {});
  }
});

router.get('/api/tasks/:id', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) return apiError(res, 'TASK_NOT_FOUND', `Task ${req.params.id} not found`, 404);
  res.json(task);
});

// --- Swarm ---

router.post('/api/swarm', async (req, res) => {
  const { objective, strategy = 'development', agents = 3 } = req.body || {};
  if (!objective) return apiError(res, 'INVALID_REQUEST', 'objective is required', 400);
  try {
    // Initialize swarm then start it — real Ruflo commands
    await runRuflo(['swarm', 'init', '--v3-mode'], { timeout: 30000 });
    const result = await runRuflo(
      ['swarm', 'start', '-o', objective, '-s', strategy],
      { timeout: 60000 }
    );
    res.json({
      success: result.exitCode === 0,
      objective,
      strategy,
      agents,
      output: result.stdout,
      exitCode: result.exitCode,
    });
  } catch (err) {
    apiError(res, 'SWARM_FAILED', err.message, 500);
  }
});

router.get('/api/swarm/:id', async (req, res) => {
  try {
    const result = await runRufloJson(['swarm', 'status'], { timeout: 30000 });
    res.json(result.json || { status: result.stdout, exitCode: result.exitCode });
  } catch (err) {
    apiError(res, 'SWARM_STATUS_FAILED', err.message, 500);
  }
});

// --- Memory ---

router.post('/api/memory/search', async (req, res) => {
  const { query, namespace } = req.body || {};
  if (!query) return apiError(res, 'INVALID_REQUEST', 'query is required', 400);
  try {
    const args = ['memory', 'search', '-q', query];
    if (namespace) args.push('--namespace', namespace);
    const result = await runRufloJson(args, { timeout: 60000 });
    res.json(result.json || { results: [], stdout: result.stdout, exitCode: result.exitCode });
  } catch (err) {
    apiError(res, 'MEMORY_SEARCH_FAILED', err.message, 500);
  }
});

router.post('/api/memory/store', async (req, res) => {
  const { key, value, namespace } = req.body || {};
  if (!key || value === undefined) return apiError(res, 'INVALID_REQUEST', 'key and value are required', 400);
  try {
    const args = ['memory', 'store', '-k', key, '-v', String(value)];
    if (namespace) args.push('--namespace', namespace);
    const result = await runRufloJson(args, { timeout: 30000 });
    res.json(result.json || { success: result.exitCode === 0, exitCode: result.exitCode });
  } catch (err) {
    apiError(res, 'MEMORY_STORE_FAILED', err.message, 500);
  }
});

// --- Tools ---

router.get('/api/tools', async (req, res) => {
  try {
    const result = await runRufloJson(['mcp', 'tools'], { timeout: 30000 });
    res.json(result.json || { tools: [], stdout: result.stdout, exitCode: result.exitCode });
  } catch (err) {
    apiError(res, 'TOOLS_LIST_FAILED', err.message, 500);
  }
});

router.post('/api/tools/execute', async (req, res) => {
  const { tool, args = {} } = req.body || {};
  if (!tool) return apiError(res, 'INVALID_REQUEST', 'tool is required', 400);

  // JEV tools are handled by the JEV plugin (server-side credentials)
  if (tool.startsWith('jev_')) {
    try {
      const result = await executeJevTool(tool, args);
      return res.json({ tool, result });
    } catch (err) {
      if (err instanceof JevError) {
        return apiError(res, err.code, err.message, err.code === 'JEV_NOT_CONFIGURED' ? 503 : 502, { details: err.details });
      }
      return apiError(res, 'JEV_TOOL_FAILED', err.message, 500);
    }
  }

  try {
    const cliArgs = ['mcp', 'exec', tool];
    for (const [k, v] of Object.entries(args)) {
      cliArgs.push(`--${k}`, String(v));
    }
    const result = await runRufloJson(cliArgs, { timeout: 60000 });
    res.json(result.json || { result: result.stdout, exitCode: result.exitCode });
  } catch (err) {
    apiError(res, 'TOOL_EXECUTE_FAILED', err.message, 500);
  }
});

// --- Plugins ---

router.get('/api/plugins', (req, res) => {
  // Never expose plugin credentials
  res.json({ plugins: listPlugins() });
});

router.get('/api/plugins/jev', (req, res) => {
  // Never expose the API key
  res.json({
    ...jevPluginInfo,
    configured: jevConfigured,
    tools: jevTools,
  });
});

router.post('/api/plugins/jev/decide', async (req, res) => {
  const { state, questions, model } = req.body || {};
  try {
    const result = await executeJevTool('jev_decide', { state, questions, model });
    res.json(result);
  } catch (err) {
    if (err instanceof JevError) {
      return apiError(res, err.code, err.message, err.code === 'JEV_NOT_CONFIGURED' ? 503 : 502, { details: err.details });
    }
    apiError(res, 'JEV_DECIDE_FAILED', err.message, 500);
  }
});

router.post('/api/plugins/jev/classify', async (req, res) => {
  const { ruleset, items } = req.body || {};
  try {
    const result = await executeJevTool('jev_classify', { ruleset, items });
    res.json(result);
  } catch (err) {
    if (err instanceof JevError) {
      return apiError(res, err.code, err.message, err.code === 'JEV_NOT_CONFIGURED' ? 503 : 502, { details: err.details });
    }
    apiError(res, 'JEV_CLASSIFY_FAILED', err.message, 500);
  }
});

router.post('/api/plugins/jev/tool-guard', async (req, res) => {
  const params = req.body || {};
  try {
    const result = await executeJevTool('jev_tool_guard', params);
    res.json(result);
  } catch (err) {
    if (err instanceof JevError) {
      return apiError(res, err.code, err.message, err.code === 'JEV_NOT_CONFIGURED' ? 503 : 502, { details: err.details });
    }
    apiError(res, 'JEV_TOOL_GUARD_FAILED', err.message, 500);
  }
});

// --- MetaHarness ---

router.get('/api/metaharness/status', async (req, res) => {
  try {
    const result = await runDoctor('metaharness');
    const available = result.exitCode === 0 && /pass/i.test(result.stdout);
    res.json({
      available,
      exitCode: result.exitCode,
      output: result.stdout,
    });
  } catch (err) {
    res.json({ available: false, error: err.message });
  }
});

function metaharnessEndpoint(subcommand, resField) {
  return async (req, res) => {
    const { path = '.' } = req.body || {};
    try {
      const result = await runRuflo(['metaharness', '--subcommand', subcommand, '--path', path], { timeout: 90000 });
      res.json({
        subcommand,
        exitCode: result.exitCode,
        [resField || 'output']: result.stdout,
        stderr: result.stderr,
      });
    } catch (err) {
      apiError(res, 'METAHARNESS_FAILED', err.message, 500);
    }
  };
}

router.post('/api/metaharness/score', metaharnessEndpoint('score', 'score'));
router.post('/api/metaharness/genome', metaharnessEndpoint('genome', 'genome'));
router.post('/api/metaharness/audit', metaharnessEndpoint('oia-audit', 'audit'));
router.post('/api/metaharness/mcp-scan', metaharnessEndpoint('mcp-scan', 'scan'));
router.post('/api/metaharness/threat-model', metaharnessEndpoint('threat-model', 'threatModel'));
router.post('/api/metaharness/similarity', metaharnessEndpoint('similarity', 'similarity'));

// --- Build / Test / Command ---

router.post('/api/build', async (req, res) => {
  const { command = 'npm run build', cwd, sessionId } = req.body || {};
  try {
    const task = await taskManager.runBuildTask({ command, cwd, sessionId });
    res.json(task);
  } catch (err) {
    apiError(res, 'BUILD_FAILED', err.message, 500);
  }
});

router.post('/api/test', async (req, res) => {
  const { command = 'npm test', cwd, sessionId } = req.body || {};
  try {
    const task = await taskManager.runTestTask({ command, cwd, sessionId });
    res.json(task);
  } catch (err) {
    apiError(res, 'TEST_FAILED', err.message, 500);
  }
});

// --- Read a workspace file (for visual spec / preview loading) ---
router.get('/api/files/read', (req, res) => {
  const { path: relPath } = req.query;
  if (!relPath) return apiError(res, 'INVALID_REQUEST', 'path query param is required', 400);
  try {
    const abs = safePath(relPath);
    if (!existsSync(abs)) return apiError(res, 'NOT_FOUND', 'File not found', 404);
    const content = readFileSync(abs, 'utf-8');
    res.json({ path: relPath, content, size: content.length });
  } catch (err) {
    if (err instanceof PathValidationError) return apiError(res, err.code, err.message, 400);
    apiError(res, 'FILE_READ_FAILED', err.message, 500);
  }
});

router.post('/api/command', async (req, res) => {
  const { command, cwd } = req.body || {};
  if (!command) return apiError(res, 'INVALID_REQUEST', 'command is required', 400);
  try {
    const result = await executeCommand({ command, cwd });
    res.json(result);
  } catch (err) {
    if (err instanceof CommandValidationError || err instanceof PathValidationError) {
      return apiError(res, err.code, err.message, 400);
    }
    apiError(res, 'COMMAND_FAILED', err.message, 500);
  }
});

// --- SSE streaming: start a streaming agent task via POST ---
router.post('/api/agent/stream', async (req, res) => {
  const { prompt, agentType = 'coder', sessionId } = req.body || {};
  if (!prompt) {
    return apiError(res, 'INVALID_REQUEST', 'prompt is required', 400);
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const task = taskManager.createTask({ prompt, type: 'agent', sessionId });
  res.write(`data: ${JSON.stringify({ type: 'task.created', taskId: task.taskId })}\n\n`);

  taskManager.runAgentTask({
    prompt, agentType, sessionId, taskId: task.taskId,
    onEvent: (e) => {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (e.type === 'task.completed' || e.type === 'task.failed' || e.type === 'task.cancelled') {
        res.write(`event: close\ndata: ${JSON.stringify({ type: 'stream.closed' })}\n\n`);
        res.end();
      }
    },
  }).catch((err) => {
    res.write(`data: ${JSON.stringify({ type: 'task.failed', error: err.message })}\n\n`);
    res.end();
  });
});

// --- SSE streaming: subscribe to an existing task by taskId ---
router.get('/api/task/stream', (req, res) => {
  const taskId = req.query.taskId || req.query.id;
  if (!taskId) {
    return apiError(res, 'INVALID_REQUEST', 'taskId query param required', 400);
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const task = taskManager.getTask(taskId);
  if (task) {
    for (const e of task.events) {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      res.write(`event: close\ndata: ${JSON.stringify({ type: 'stream.closed', status: task.status })}\n\n`);
      res.end();
      return;
    }
  }

  const onEvent = (event) => {
    if (event.taskId === taskId) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (['task.completed', 'task.failed', 'task.cancelled'].includes(event.type)) {
        res.write(`event: close\ndata: ${JSON.stringify({ type: 'stream.closed', status: event.type })}\n\n`);
        res.end();
      }
    }
  };
  taskManager.on('event', onEvent);
  req.on('close', () => taskManager.off('event', onEvent));
});

// --- Autonomous builder (Osiri) ---

// POST /api/autonomous/build — start an autonomous build (returns SSE stream)
router.post('/api/autonomous/build', async (req, res) => {
  const { prompt, sessionId } = req.body || {};
  if (!prompt) return apiError(res, 'INVALID_REQUEST', 'prompt is required', 400);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Stream events as they happen
  const onEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    const task = await autonomousBuilder.build({
      prompt,
      sessionId: sessionId || 'default',
      onEvent,
      signal: null,
      maxFixIterations: 3,
    });
    res.write(`event: close\ndata: ${JSON.stringify({ type: 'stream.closed', status: task.status, result: task.result, error: task.error })}\n\n`);
  } catch (err) {
    res.write(`event: close\ndata: ${JSON.stringify({ type: 'stream.closed', status: 'failed', error: err.message })}\n\n`);
  }
  res.end();
});

// POST /api/autonomous/build/sync — start an autonomous build (returns JSON result)
router.post('/api/autonomous/build/sync', async (req, res) => {
  const { prompt, sessionId } = req.body || {};
  if (!prompt) return apiError(res, 'INVALID_REQUEST', 'prompt is required', 400);

  try {
    const task = await autonomousBuilder.build({
      prompt,
      sessionId: sessionId || 'default',
      onEvent: null,
      signal: null,
      maxFixIterations: 3,
    });
    // Include events from the durable event log
    if (task && task.taskId) {
      task.events = taskStore.getEvents(task.taskId);
    }
    res.json(task);
  } catch (err) {
    apiError(res, 'AUTONOMOUS_BUILD_FAILED', err.message, 500);
  }
});

// GET /api/autonomous/plan — preview the plan for a prompt without executing
router.post('/api/autonomous/plan', (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return apiError(res, 'INVALID_REQUEST', 'prompt is required', 400);
  try {
    const plan = autonomousBuilder.createPlan(prompt);
    res.json({
      projectName: plan.projectName,
      projectType: plan.projectType,
      summary: plan.summary,
      files: plan.files.map(f => ({ path: f.path, size: f.content.length })),
      buildCommand: plan.buildCommand,
      testCommand: plan.testCommand,
    });
  } catch (err) {
    apiError(res, 'PLAN_FAILED', err.message, 500);
  }
});

// --- Durable task management (interactive during build) ---

// GET /api/tasks — list all tasks
router.get('/api/tasks', (req, res) => {
  res.json({ tasks: taskStore.listTasks() });
});

// GET /api/tasks/active — list active (non-terminal) tasks
router.get('/api/tasks/active', (req, res) => {
  res.json({ tasks: taskStore.listActiveTasks() });
});

// GET /api/tasks/:taskId — get task state
router.get('/api/tasks/:taskId', (req, res) => {
  const task = taskStore.getTask(req.params.taskId);
  if (!task) return apiError(res, 'NOT_FOUND', 'Task not found', 404);
  res.json(task);
});

// GET /api/tasks/:taskId/status — get human-readable status summary (for "what are you doing?")
router.get('/api/tasks/:taskId/status', (req, res) => {
  const summary = getTaskStatusSummary(req.params.taskId);
  if (!summary) return apiError(res, 'NOT_FOUND', 'Task not found', 404);
  res.json(summary);
});

// GET /api/tasks/:taskId/events — get events (with optional afterEventId for reconnection)
router.get('/api/tasks/:taskId/events', (req, res) => {
  const { after } = req.query;
  const events = taskStore.getEvents(req.params.taskId, after || null);
  if (events === null || events === undefined) {
    const task = taskStore.getTask(req.params.taskId);
    if (!task) return apiError(res, 'NOT_FOUND', 'Task not found', 404);
  }
  res.json({ taskId: req.params.taskId, events, count: events.length });
});

// GET /api/tasks/:taskId/stream — SSE stream with reconnection support
// Uses Last-Event-ID header to recover missed events on reconnect
router.get('/api/tasks/:taskId/stream', (req, res) => {
  const taskId = req.params.taskId;
  const task = taskStore.getTask(taskId);
  if (!task) return apiError(res, 'NOT_FOUND', 'Task not found', 404);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Recover missed events using Last-Event-ID header (SSE standard)
  const lastEventId = req.headers['last-event-id'] || req.query.after || null;

  // Send current task state first
  const snapshot = taskStore.getTaskSnapshot(taskId);
  res.write(`data: ${JSON.stringify({ type: 'task.state', taskId, status: task.status, phase: task.phase, ...snapshot })}\n\n`);

  // Replay missed events
  if (lastEventId) {
    const missed = taskStore.getEvents(taskId, lastEventId);
    for (const evt of missed) {
      res.write(`id: ${evt.id}\n`);
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }
  } else {
    // No Last-Event-ID — send all events
    const allEvents = taskStore.getEvents(taskId);
    for (const evt of allEvents) {
      res.write(`id: ${evt.id}\n`);
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }
  }

  // If task is terminal, close the stream
  if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(task.status)) {
    res.write(`event: close\ndata: ${JSON.stringify({ type: 'stream.closed', status: task.status })}\n\n`);
    res.end();
    return;
  }

  // Subscribe to live events
  const unsubscribe = taskStore.subscribe(taskId, (event) => {
    res.write(`id: ${event.id}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);

    if (['task.completed', 'task.failed', 'task.cancelled'].includes(event.type)) {
      res.write(`event: close\ndata: ${JSON.stringify({ type: 'stream.closed', status: event.type })}\n\n`);
      res.end();
    }
  });

  req.on('close', () => {
    unsubscribe();
  });
});

// POST /api/tasks/:taskId/pause — pause a running task
router.post('/api/tasks/:taskId/pause', (req, res) => {
  const task = taskStore.getTask(req.params.taskId);
  if (!task) return apiError(res, 'NOT_FOUND', 'Task not found', 404);
  if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(task.status)) {
    return apiError(res, 'INVALID_STATE', `Cannot pause task in ${task.status} state`, 400);
  }
  taskStore.checkpoint(req.params.taskId, { reason: 'user-pause' });
  const paused = taskStore.pause(req.params.taskId);
  res.json({ taskId: req.params.taskId, status: paused.status, message: 'Task paused. State checkpointed.' });
});

// POST /api/tasks/:taskId/resume — resume a paused task
router.post('/api/tasks/:taskId/resume', async (req, res) => {
  const task = taskStore.getTask(req.params.taskId);
  if (!task) return apiError(res, 'NOT_FOUND', 'Task not found', 404);
  if (task.status !== 'PAUSED') {
    return apiError(res, 'INVALID_STATE', `Cannot resume task in ${task.status} state`, 400);
  }
  const resumed = taskStore.resume(req.params.taskId);
  res.json({ taskId: req.params.taskId, status: resumed.status, message: 'Task resumed from checkpoint.' });

  // Actually restart the build in the background (independent of browser)
  if (task.goal) {
    autonomousBuilder.build({
      prompt: task.goal,
      sessionId: task.sessionId,
      onEvent: null,
      taskId: req.params.taskId,
      maxFixIterations: 3,
    }).catch(err => logger.error('resume.build.failed', { taskId: req.params.taskId, error: err.message }));
  }
});

// POST /api/tasks/:taskId/cancel — cancel a task
router.post('/api/tasks/:taskId/cancel', (req, res) => {
  const task = taskStore.getTask(req.params.taskId);
  if (!task) return apiError(res, 'NOT_FOUND', 'Task not found', 404);
  if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(task.status)) {
    return apiError(res, 'INVALID_STATE', `Task is already ${task.status}`, 400);
  }
  const cancelled = taskStore.cancel(req.params.taskId, req.body?.reason || 'user');
  res.json({ taskId: req.params.taskId, status: cancelled.status, message: 'Task cancelled.' });
});

// POST /api/tasks/:taskId/retry — retry a failed/waiting task now
router.post('/api/tasks/:taskId/retry', async (req, res) => {
  const task = taskStore.getTask(req.params.taskId);
  if (!task) return apiError(res, 'NOT_FOUND', 'Task not found', 404);
  if (!['FAILED', 'WAITING_NETWORK', 'WAITING_PROVIDER', 'PAUSED'].includes(task.status)) {
    return apiError(res, 'INVALID_STATE', `Cannot retry task in ${task.status} state`, 400);
  }
  taskStore.update(req.params.taskId, { retryCount: 0, lastError: null, networkState: 'online' });
  taskStore.transition(req.params.taskId, 'RUNNING');
  res.json({ taskId: req.params.taskId, status: 'RUNNING', message: 'Retrying task now.' });

  // Restart the build in the background
  autonomousBuilder.build({
    prompt: task.goal,
    sessionId: task.sessionId,
    onEvent: null,
    taskId: req.params.taskId,
    maxFixIterations: 3,
  }).catch(err => logger.error('retry.build.failed', { taskId: req.params.taskId, error: err.message }));
});

// POST /api/tasks/:taskId/conversation — conversation during build
// User can ask "what are you doing?" and get a real state-based response
router.post('/api/tasks/:taskId/conversation', (req, res) => {
  const { message } = req.body || {};
  const taskId = req.params.taskId;
  const task = taskStore.getTask(taskId);
  if (!task) return apiError(res, 'NOT_FOUND', 'Task not found', 404);

  const msg = (message || '').toLowerCase();
  let response = '';

  if (/what are you doing|status|how far|progress|what's happening/.test(msg)) {
    const summary = getTaskStatusSummary(taskId);
    response = summary.summary;
  } else if (/stop|cancel|abort/.test(msg)) {
    taskStore.cancel(taskId, 'user-request');
    response = 'I have stopped the current task. The task state has been saved.';
  } else if (/pause|wait|hold/.test(msg)) {
    taskStore.checkpoint(taskId, { reason: 'user-pause' });
    taskStore.pause(taskId);
    response = 'I have paused the current task. You can resume by saying "continue".';
  } else if (/continue|resume|go on|keep going/.test(msg)) {
    taskStore.resume(taskId);
    response = 'I am resuming the task from where it was paused.';
    // Restart in background
    if (task.goal) {
      autonomousBuilder.build({
        prompt: task.goal, sessionId: task.sessionId, onEvent: null, taskId, maxFixIterations: 3,
      }).catch(err => logger.error('conversation.resume.failed', { taskId, error: err.message }));
    }
  } else if (/change|modify|update|use|switch|different/.test(msg)) {
    // User wants to modify the build — store as a note
    taskStore.emitEvent(taskId, { type: 'user.modification', message });
    response = `Understood. I'll incorporate "${message}" into the current build. The change will be applied when appropriate.`;
  } else if (/error|fail|wrong|broken/.test(msg)) {
    response = task.lastError
      ? `The last error was: ${task.lastError}. Failure type: ${task.failureClassification || 'UNKNOWN'}. Retry count: ${task.retryCount}/${task.maxRetries}.`
      : 'No errors have been recorded for this task.';
  } else if (/file|what files|show files/.test(msg)) {
    const files = task.filesCreated || [];
    response = files.length > 0
      ? `I have created ${files.length} files so far: ${files.slice(0, 10).join(', ')}${files.length > 10 ? '...' : ''}`
      : 'No files have been created yet.';
  } else if (/test/.test(msg)) {
    response = task.testResult
      ? `Tests ${task.testResult.exitCode === 0 ? 'passed' : 'failed'} (exit code ${task.testResult.exitCode}).`
      : 'Tests have not been run yet.';
  } else if (/build/.test(msg)) {
    response = task.buildResult
      ? `Build ${task.buildResult.exitCode === 0 ? 'succeeded' : 'failed'} (exit code ${task.buildResult.exitCode}).`
      : 'Build has not been run yet.';
  } else {
    const summary = getTaskStatusSummary(taskId);
    response = `${summary.summary} You can ask me about progress, files, build status, or tell me to pause/stop/continue.`;
  }

  taskStore.emitEvent(taskId, { type: 'conversation', role: 'user', message });
  taskStore.emitEvent(taskId, { type: 'conversation', role: 'osiri', message: response });

  res.json({ taskId, response, taskStatus: task.status, phase: task.phase });
});

// --- Error handler for unknown routes ---
router.use((req, res) => {
  apiError(res, 'NOT_FOUND', `Route not found: ${req.method} ${req.path}`, 404);
});

export { router as apiRouter };
