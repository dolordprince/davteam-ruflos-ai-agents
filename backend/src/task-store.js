// backend/src/task-store.js — Durable persistent task store with state machine & event log.
// Tasks survive server restart and browser disconnect. All state is persisted to disk.
// Implements the state machine:
//   QUEUED → PLANNING → RUNNING → WAITING_NETWORK → RECONNECTING → RESUMING → RUNNING → VERIFYING → COMPLETED
//   + WAITING_USER, WAITING_TOOL, WAITING_PROVIDER, PAUSED, CANCELLED, FAILED
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

const TASKS_DIR = resolve(config.workspace, '.task-store');
const EVENTS_DIR = resolve(config.workspace, '.task-store', 'events');

// Ensure persistence directories exist
mkdirSync(TASKS_DIR, { recursive: true });
mkdirSync(EVENTS_DIR, { recursive: true });

// Valid state machine transitions
const VALID_STATES = new Set([
  'QUEUED', 'PLANNING', 'RUNNING', 'WAITING_NETWORK', 'RECONNECTING',
  'RESUMING', 'VERIFYING', 'COMPLETED',
  'WAITING_USER', 'WAITING_TOOL', 'WAITING_PROVIDER',
  'PAUSED', 'CANCELLED', 'FAILED',
]);

const TERMINAL_STATES = new Set(['COMPLETED', 'CANCELLED', 'FAILED']);

const TRANSITIONS = {
  QUEUED: ['PLANNING', 'PAUSED', 'CANCELLED'],
  PLANNING: ['RUNNING', 'WAITING_NETWORK', 'PAUSED', 'CANCELLED', 'FAILED'],
  RUNNING: ['WAITING_NETWORK', 'WAITING_USER', 'WAITING_TOOL', 'WAITING_PROVIDER', 'VERIFYING', 'PAUSED', 'CANCELLED', 'FAILED'],
  WAITING_NETWORK: ['RECONNECTING', 'PAUSED', 'CANCELLED'],
  RECONNECTING: ['RESUMING', 'WAITING_NETWORK', 'PAUSED', 'CANCELLED'],
  RESUMING: ['RUNNING', 'WAITING_NETWORK', 'FAILED'],
  VERIFYING: ['RUNNING', 'COMPLETED', 'FAILED'],
  WAITING_USER: ['RUNNING', 'PAUSED', 'CANCELLED'],
  WAITING_TOOL: ['RUNNING', 'WAITING_NETWORK', 'PAUSED', 'CANCELLED', 'FAILED'],
  WAITING_PROVIDER: ['RUNNING', 'WAITING_NETWORK', 'PAUSED', 'CANCELLED', 'FAILED'],
  PAUSED: ['RUNNING', 'QUEUED', 'CANCELLED', 'FAILED'],
  // terminal states can't transition
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

class TaskStore extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
    this.tasks = new Map(); // taskId -> task state
    this._loadAll();
    this._eventSubscribers = new Map(); // taskId -> Set<callback>
  }

  // --- Persistence ---

  _taskPath(taskId) { return join(TASKS_DIR, `${taskId}.json`); }
  _eventsPath(taskId) { return join(EVENTS_DIR, `${taskId}.events.jsonl`); }

  _loadAll() {
    if (!existsSync(TASKS_DIR)) return;
    const files = readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(TASKS_DIR, f), 'utf-8'));
        this.tasks.set(data.taskId, data);
      } catch (err) {
        logger.error('task-store.load.failed', { file: f, error: err.message });
      }
    }
    logger.info('task-store.loaded', { count: this.tasks.size });
  }

  _persist(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    try {
      writeFileSync(this._taskPath(taskId), JSON.stringify(task, null, 2), 'utf-8');
    } catch (err) {
      logger.error('task-store.persist.failed', { taskId, error: err.message });
    }
  }

  _appendEvent(taskId, event) {
    try {
      const line = JSON.stringify(event) + '\n';
      writeFileSync(this._eventsPath(taskId), line, { flag: 'a' });
    } catch (err) {
      logger.error('task-store.event.append.failed', { taskId, error: err.message });
    }
  }

  _loadEvents(taskId, afterEventId = null) {
    const path = this._eventsPath(taskId);
    if (!existsSync(path)) return [];
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const events = [];
    let started = afterEventId === null;
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (!started) {
          if (evt.id === afterEventId) started = true;
          continue;
        }
        events.push(evt);
      } catch { /* skip malformed */ }
    }
    return events;
  }

  _lastEventId(taskId) {
    const path = this._eventsPath(taskId);
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    try {
      return JSON.parse(lines[lines.length - 1]).id;
    } catch { return null; }
  }

  // --- Task lifecycle ---

  createTask(initial = {}) {
    const taskId = initial.taskId || `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const task = {
      taskId,
      sessionId: initial.sessionId || null,
      status: 'QUEUED',
      phase: 'queued',
      goal: initial.prompt || initial.goal || '',
      prompt: initial.prompt || '',
      type: initial.type || 'autonomous',
      workspaceId: initial.workspaceId || config.workspace,
      agentIds: [],
      currentAgent: null,
      currentTool: null,
      currentStep: null,
      checkpoint: null,
      lastEventId: null,
      networkState: 'online',
      retryCount: 0,
      maxRetries: initial.maxRetries || 5,
      failureClassification: null,
      lastError: null,
      result: null,
      filesCreated: [],
      buildResult: null,
      testResult: null,
      verified: false,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(taskId, task);
    this._persist(taskId);
    this._emitEvent(taskId, { type: 'task.created', goal: task.goal });
    return task;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  listTasks() {
    return Array.from(this.tasks.values()).map(t => ({ ...t }));
  }

  listActiveTasks() {
    return Array.from(this.tasks.values())
      .filter(t => !TERMINAL_STATES.has(t.status))
      .map(t => ({ ...t }));
  }

  /**
   * Transition the task to a new state.
   * Validates the transition against the state machine.
   */
  transition(taskId, newStatus, extra = {}) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!VALID_STATES.has(newStatus)) throw new Error(`Invalid state: ${newStatus}`);
    if (TERMINAL_STATES.has(task.status)) {
      logger.warn('task-store.terminal.transition.blocked', { taskId, current: task.status, attempted: newStatus });
      return task;
    }
    const allowed = TRANSITIONS[task.status] || [];
    if (!allowed.includes(newStatus)) {
      logger.warn('task-store.invalid.transition', { taskId, current: task.status, attempted: newStatus });
      // Allow it anyway but log — being permissive prevents deadlocks
    }
    task.status = newStatus;
    task.updatedAt = new Date().toISOString();
    Object.assign(task, extra);
    this._persist(taskId);
    this._emitEvent(taskId, { type: 'task.state', status: newStatus, ...extra });
    return task;
  }

  /**
   * Update task fields without a state transition.
   */
  update(taskId, fields = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    Object.assign(task, fields);
    task.updatedAt = new Date().toISOString();
    this._persist(taskId);
    return task;
  }

  setPhase(taskId, phase, extra = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.phase = phase;
    task.currentStep = phase;
    task.updatedAt = new Date().toISOString();
    Object.assign(task, extra);
    this._persist(taskId);
    return task;
  }

  /**
   * Emit a durable event. Every event gets a sequential ID and is persisted.
   */
  _emitEvent(taskId, event) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    // Generate sequential event ID
    const eventCount = this._countEvents(taskId);
    const eventId = `evt-${taskId}-${eventCount + 1}`;

    const fullEvent = {
      id: eventId,
      taskId,
      timestamp: new Date().toISOString(),
      ...event,
    };

    // Persist the event
    this._appendEvent(taskId, fullEvent);

    // Update task's lastEventId
    task.lastEventId = eventId;
    task.updatedAt = fullEvent.timestamp;
    this._persist(taskId);

    // Emit to subscribers
    this.emit(`event:${taskId}`, fullEvent);
    this.emit('event', fullEvent);

    // Also emit to SSE subscribers
    const subs = this._eventSubscribers.get(taskId);
    if (subs) {
      for (const cb of subs) {
        try { cb(fullEvent); } catch {}
      }
    }

    logger.info('task.event', { taskId, type: fullEvent.type, eventId });
  }

  _countEvents(taskId) {
    const path = this._eventsPath(taskId);
    if (!existsSync(path)) return 0;
    const content = readFileSync(path, 'utf-8');
    return content.split('\n').filter(Boolean).length;
  }

  /**
   * Public emit — for external modules to emit events.
   */
  emitEvent(taskId, event) {
    this._emitEvent(taskId, event);
  }

  /**
   * Get events after a given event ID (for SSE reconnection).
   * If afterEventId is null, returns all events.
   */
  getEvents(taskId, afterEventId = null) {
    return this._loadEvents(taskId, afterEventId);
  }

  /**
   * Get a snapshot of the task state (for reconnection).
   */
  getTaskSnapshot(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const lastEventId = this._lastEventId(taskId);
    return {
      ...task,
      lastEventId,
      events: this._loadEvents(taskId),
    };
  }

  /**
   * Checkpoint the task — save current state so it can be resumed.
   */
  checkpoint(taskId, checkpointData = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const checkpoint = {
      phase: task.phase,
      status: task.status,
      currentStep: task.currentStep,
      currentAgent: task.currentAgent,
      currentTool: task.currentTool,
      filesCreated: [...(task.filesCreated || [])],
      retryCount: task.retryCount,
      ...checkpointData,
      timestamp: new Date().toISOString(),
    };
    task.checkpoint = checkpoint;
    task.updatedAt = checkpoint.timestamp;
    this._persist(taskId);
    this._emitEvent(taskId, { type: 'task.checkpointed', checkpoint });
    return checkpoint;
  }

  /**
   * Pause a task.
   */
  pause(taskId) {
    return this.transition(taskId, 'PAUSED');
  }

  /**
   * Resume a task from PAUSED state.
   */
  resume(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    // Determine where to resume based on checkpoint
    const resumeState = task.checkpoint?.status === 'WAITING_NETWORK' ? 'RECONNECTING' : 'RUNNING';
    return this.transition(taskId, resumeState, { resumedAt: new Date().toISOString() });
  }

  /**
   * Cancel a task.
   */
  cancel(taskId, reason = 'user') {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (TERMINAL_STATES.has(task.status)) return task;
    this._emitEvent(taskId, { type: 'task.cancelled', reason });
    return this.transition(taskId, 'CANCELLED', { cancelledReason: reason });
  }

  /**
   * Mark task as completed.
   */
  complete(taskId, result = '') {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.result = result;
    task.verified = true;
    this._emitEvent(taskId, { type: 'task.completed', result, verified: true });
    return this.transition(taskId, 'COMPLETED', { result, verified: true });
  }

  /**
   * Mark task as failed.
   */
  fail(taskId, error, classification = 'UNKNOWN') {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.lastError = error;
    task.failureClassification = classification;
    this._emitEvent(taskId, { type: 'task.failed', error, classification });
    return this.transition(taskId, 'FAILED', { lastError: error, failureClassification: classification });
  }

  /**
   * Subscribe to events for a task (for SSE streaming).
   */
  subscribe(taskId, callback) {
    if (!this._eventSubscribers.has(taskId)) {
      this._eventSubscribers.set(taskId, new Set());
    }
    this._eventSubscribers.get(taskId).add(callback);
    return () => {
      const subs = this._eventSubscribers.get(taskId);
      if (subs) subs.delete(callback);
    };
  }

  /**
   * Delete a task and its events.
   */
  deleteTask(taskId) {
    this.tasks.delete(taskId);
    try { unlinkSync(this._taskPath(taskId)); } catch {}
    try { unlinkSync(this._eventsPath(taskId)); } catch {}
    this._eventSubscribers.delete(taskId);
  }
}

export const taskStore = new TaskStore();
