// backend/src/resilience.js — Network resilience, failure classification, and reconnect logic.
// Ensures tasks survive browser disconnect, provider failures, and network interruptions.
// Implements: checkpoint → classify failure → pause → retry with backoff → resume from checkpoint.
import { taskStore } from './task-store.js';
import { logger } from './logger.js';

// Failure classifications
export const FailureType = {
  NETWORK: 'NETWORK',
  PROVIDER: 'PROVIDER',
  TOOL: 'TOOL',
  CODE: 'CODE',
  BUILD: 'BUILD',
  TEST: 'TEST',
  SECURITY: 'SECURITY',
  RESOURCE: 'RESOURCE',
  USER_INPUT: 'USER_INPUT',
  UNKNOWN: 'UNKNOWN',
};

// Exponential backoff schedule with jitter
const BACKOFF_SCHEDULE = [1000, 2000, 4000, 8000, 16000, 30000, 60000]; // ms

/**
 * Calculate the next backoff delay with jitter.
 * @param {number} retryCount - current retry count (0-based)
 * @returns {number} delay in ms
 */
export function getBackoffDelay(retryCount) {
  const idx = Math.min(retryCount, BACKOFF_SCHEDULE.length - 1);
  const base = BACKOFF_SCHEDULE[idx];
  // Add jitter: ±25% of base
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(base + jitter));
}

/**
 * Classify a failure based on the error.
 * @param {Error} err
 * @returns {string} FailureType
 */
export function classifyFailure(err) {
  if (!err) return FailureType.UNKNOWN;
  const msg = (err.message || '').toLowerCase();
  const code = err.code || '';

  // Network failures
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ECONNABORTED' ||
      code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' ||
      code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ||
      msg.includes('network') || msg.includes('connection') || msg.includes('timeout') ||
      msg.includes('fetch failed') || msg.includes('socket hang up')) {
    return FailureType.NETWORK;
  }

  // Provider failures (API key, rate limit, model errors)
  if (code === 401 || code === 403 || code === 429 ||
      msg.includes('api key') || msg.includes('unauthorized') || msg.includes('forbidden') ||
      msg.includes('rate limit') || msg.includes('quota') || msg.includes('model') ||
      msg.includes('provider')) {
    return FailureType.PROVIDER;
  }

  // Build failures
  if (msg.includes('build') || msg.includes('vite') || msg.includes('webpack') ||
      msg.includes('esbuild') || msg.includes('rollup') || msg.includes('compile') ||
      msg.includes('syntax error') || msg.includes('unexpected token')) {
    return FailureType.BUILD;
  }

  // Test failures
  if (msg.includes('test') || msg.includes('assert') || msg.includes('vitest') ||
      msg.includes('jest') || msg.includes('expect')) {
    return FailureType.TEST;
  }

  // Security failures
  if (msg.includes('security') || msg.includes('forbidden path') || msg.includes('traversal') ||
      msg.includes('permission') || msg.includes('denied')) {
    return FailureType.SECURITY;
  }

  // Resource failures
  if (code === 137 || msg.includes('oom') || msg.includes('out of memory') ||
      msg.includes('disk full') || msg.includes('enoent') || msg.includes('resource')) {
    return FailureType.RESOURCE;
  }

  // Tool failures
  if (msg.includes('tool') || msg.includes('mcp') || msg.includes('command')) {
    return FailureType.TOOL;
  }

  return FailureType.UNKNOWN;
}

/**
 * Determine if a failure is retryable.
 * Network and provider failures are retryable.
 * Build, test, and code failures require fixes, not retries.
 */
export function isRetryable(failureType) {
  return [FailureType.NETWORK, FailureType.PROVIDER, FailureType.RESOURCE].includes(failureType);
}

/**
 * Handle a failure during task execution.
 * This checkpoints the task, classifies the failure, and decides whether to retry or fail.
 *
 * @param {string} taskId
 * @param {Error} err
 * @param {object} context - extra context about where the failure occurred
 * @returns {object} { shouldRetry, failureType, delay, retryCount }
 */
export function handleFailure(taskId, err, context = {}) {
  const task = taskStore.getTask(taskId);
  if (!task) return { shouldRetry: false, failureType: FailureType.UNKNOWN, delay: 0, retryCount: 0 };

  const failureType = classifyFailure(err);
  const retryable = isRetryable(failureType);
  const retryCount = (task.retryCount || 0);
  const maxRetries = task.maxRetries || 5;

  // Checkpoint current state
  taskStore.checkpoint(taskId, {
    failureType,
    failureContext: context,
    lastError: err.message,
  });

  taskStore.update(taskId, {
    lastError: err.message,
    failureClassification: failureType,
  });

  taskStore.emitEvent(taskId, {
    type: 'failure.classified',
    failureType,
    retryable,
    retryCount,
    error: err.message,
    context,
  });

  if (retryable && retryCount < maxRetries) {
    const delay = getBackoffDelay(retryCount);
    const newRetryCount = retryCount + 1;
    taskStore.update(taskId, { retryCount: newRetryCount });

    if (failureType === FailureType.NETWORK) {
      taskStore.transition(taskId, 'WAITING_NETWORK', { networkState: 'offline' });
      taskStore.emitEvent(taskId, {
        type: 'network.lost',
        message: 'Network connection lost. Task state has been checkpointed. Will retry automatically.',
        retryIn: delay,
        retryCount: newRetryCount,
      });
    } else if (failureType === FailureType.PROVIDER) {
      taskStore.transition(taskId, 'WAITING_PROVIDER', { networkState: 'degraded' });
      taskStore.emitEvent(taskId, {
        type: 'provider.unavailable',
        message: 'Model provider is unavailable. Task state preserved. Retrying with backoff.',
        retryIn: delay,
        retryCount: newRetryCount,
      });
    }

    logger.info('resilience.retry', { taskId, failureType, retryCount: newRetryCount, delay });
    return { shouldRetry: true, failureType, delay, retryCount: newRetryCount };
  }

  // Not retryable or max retries exceeded
  if (failureType === FailureType.NETWORK || failureType === FailureType.PROVIDER) {
    taskStore.emitEvent(taskId, {
      type: 'task.failed',
      error: `Max retries (${maxRetries}) exceeded for ${failureType} failure: ${err.message}`,
      classification: failureType,
    });
    taskStore.transition(taskId, 'FAILED', { lastError: err.message, failureClassification: failureType });
  } else {
    // For build/test/code failures, the fix loop handles them — don't fail the task
    taskStore.emitEvent(taskId, {
      type: 'failure.detected',
      failureType,
      message: `${failureType} failure detected. Agent will attempt to fix and retry.`,
      error: err.message,
    });
  }

  return { shouldRetry: false, failureType, delay: 0, retryCount };
}

/**
 * Attempt to reconnect after a network/provider failure.
 * Waits for the backoff delay, then transitions to RECONNECTING.
 *
 * @param {string} taskId
 * @param {number} delay - ms to wait
 * @param {function} checkFn - async function that returns true if connection is restored
 * @returns {Promise<boolean>} true if reconnected
 */
export async function attemptReconnect(taskId, delay, checkFn = null) {
  const task = taskStore.getTask(taskId);
  if (!task) return false;

  taskStore.transition(taskId, 'RECONNECTING', { networkState: 'reconnecting' });
  taskStore.emitEvent(taskId, {
    type: 'network.reconnecting',
    retryIn: delay,
    message: 'Attempting to reconnect…',
  });

  // Wait for backoff delay
  await sleep(delay);

  // Check if connection is restored
  let connected = true;
  if (checkFn) {
    try {
      connected = await checkFn();
    } catch {
      connected = false;
    }
  }

  if (connected) {
    taskStore.transition(taskId, 'RESUMING', { networkState: 'online' });
    taskStore.emitEvent(taskId, {
      type: 'network.restored',
      message: 'Connection restored. Resuming task from checkpoint.',
    });
    return true;
  }

  // Still not connected — will be retried by the caller
  taskStore.transition(taskId, 'WAITING_NETWORK', { networkState: 'offline' });
  taskStore.emitEvent(taskId, {
    type: 'network.still.offline',
    message: 'Connection still unavailable. Will retry.',
  });
  return false;
}

/**
 * Resume a task from its checkpoint.
 * Returns the checkpoint data so the executor knows where to continue.
 */
export function resumeFromCheckpoint(taskId) {
  const task = taskStore.getTask(taskId);
  if (!task || !task.checkpoint) return null;

  taskStore.transition(taskId, 'RUNNING', { networkState: 'online' });
  taskStore.emitEvent(taskId, {
    type: 'task.resumed',
    checkpoint: task.checkpoint,
    message: `Resuming from: "${task.checkpoint.currentStep || task.checkpoint.phase}"`,
  });

  return task.checkpoint;
}

/**
 * Get a human-readable status summary of a task for interactive queries.
 */
export function getTaskStatusSummary(taskId) {
  const task = taskStore.getTask(taskId);
  if (!task) return null;

  const elapsed = Date.now() - new Date(task.createdAt).getTime();
  const elapsedStr = formatDuration(elapsed);

  let summary = '';
  switch (task.status) {
    case 'QUEUED':
      summary = `Task is queued. Goal: "${task.goal}". Waiting to start.`;
      break;
    case 'PLANNING':
      summary = `I'm planning the implementation. Goal: "${task.goal}".`;
      break;
    case 'RUNNING':
      summary = `I'm currently ${task.currentStep || task.phase || 'working'}.`;
      if (task.currentAgent) summary += ` Agent: ${task.currentAgent}.`;
      if (task.currentTool) summary += ` Tool: ${task.currentTool}.`;
      if (task.filesCreated?.length) summary += ` ${task.filesCreated.length} files created so far.`;
      break;
    case 'WAITING_NETWORK':
      summary = `Network connection lost. I've saved the current build state (${task.currentStep || task.phase}) and will continue when the connection is restored. Retry ${task.retryCount}/${task.maxRetries}.`;
      break;
    case 'RECONNECTING':
      summary = `Reconnecting… Attempting to restore connection. Retry ${task.retryCount}/${task.maxRetries}.`;
      break;
    case 'RESUMING':
      summary = `Connection restored. Resuming from: "${task.checkpoint?.currentStep || task.currentStep}". No work was lost.`;
      break;
    case 'VERIFYING':
      summary = `I'm verifying the completed build. Running final checks.`;
      break;
    case 'WAITING_USER':
      summary = `I'm waiting for your input. Current step: ${task.currentStep || task.phase}.`;
      break;
    case 'WAITING_TOOL':
      summary = `Waiting for a tool to become available. Current step: ${task.currentStep || task.phase}.`;
      break;
    case 'WAITING_PROVIDER':
      summary = `The model provider is temporarily unavailable. Task state is preserved. Retry ${task.retryCount}/${task.maxRetries}.`;
      break;
    case 'PAUSED':
      summary = `Task is paused. Current state: ${task.currentStep || task.phase}. You can resume when ready.`;
      break;
    case 'COMPLETED':
      summary = `Task completed successfully. ${task.result || ''}`;
      break;
    case 'CANCELLED':
      summary = `Task was cancelled.`;
      break;
    case 'FAILED':
      summary = `Task failed: ${task.lastError || 'unknown error'}. Classification: ${task.failureClassification || 'UNKNOWN'}.`;
      break;
    default:
      summary = `Task status: ${task.status}. Phase: ${task.phase}.`;
  }

  return {
    taskId,
    status: task.status,
    phase: task.phase,
    currentStep: task.currentStep,
    currentAgent: task.currentAgent,
    currentTool: task.currentTool,
    elapsed: elapsedStr,
    retryCount: task.retryCount || 0,
    maxRetries: task.maxRetries || 5,
    networkState: task.networkState,
    lastCheckpoint: task.checkpoint?.timestamp || null,
    filesCreated: task.filesCreated?.length || 0,
    verified: task.verified,
    summary,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}
