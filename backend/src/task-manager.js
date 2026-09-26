// backend/src/task-manager.js — Task orchestration with real event streaming.
// Each task has a unique ID and emits genuine execution events from the Ruflo runtime.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger } from './logger.js';
import { runRuflo, runRufloJson } from './ruflo-runtime.js';
import { executeCommand } from './command-exec.js';
import { safePath, auditLog } from './workspace.js';
import { getWorkspaceRoot } from './workspace.js';

class TaskManager extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
    this.setMaxListeners(100);
  }

  createTask(initial = {}) {
    const taskId = initial.taskId || `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const task = {
      taskId,
      sessionId: initial.sessionId || null,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
      result: null,
      error: null,
      prompt: initial.prompt || '',
      type: initial.type || 'agent',
      agentId: null,
    };
    this.tasks.set(taskId, task);
    return task;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  listTasks() {
    return Array.from(this.tasks.values());
  }

  _emitEvent(taskId, event) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const fullEvent = {
      taskId,
      timestamp: new Date().toISOString(),
      ...event,
    };
    task.events.push(fullEvent);
    task.updatedAt = fullEvent.timestamp;
    this.emit(`event:${taskId}`, fullEvent);
    this.emit('event', fullEvent);
    logger.info('task.event', fullEvent);
  }

  _setStatus(taskId, status) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = status;
    task.updatedAt = new Date().toISOString();
  }

  /**
   * Run a real agent task: spawn an agent and execute it through Ruflo.
   * Emits genuine events from the subprocess execution.
   */
  async runAgentTask({ prompt, agentType = 'coder', sessionId, onEvent, signal }) {
    const task = this.createTask({ prompt, type: 'agent', sessionId });
    const { taskId } = task;

    const emit = (e) => {
      this._emitEvent(taskId, e);
      if (onEvent) onEvent(e);
    };

    try {
      this._setStatus(taskId, 'running');
      emit({ type: 'task.started', prompt, agentType });

      // 1. Spawn a real agent via Ruflo
      emit({ type: 'agent.selecting', agentType });
      const spawnResult = await runRufloJson(['agent', 'spawn', '-t', agentType], { timeout: 30000, signal });
      const agentId = spawnResult.json?.agentId;
      task.agentId = agentId;
      emit({ type: 'agent.spawned', agentId, agentType, details: spawnResult.json });

      // 2. Create a real task
      emit({ type: 'task.created', prompt });
      const taskResult = await runRufloJson(['task', 'create', '-t', 'implementation', '-d', prompt], { timeout: 30000, signal });
      const rufloTaskId = taskResult.json?.taskId;
      emit({ type: 'task.assigned', rufloTaskId, agentId });

      // 3. Attempt agent execution (requires a model provider key)
      // If no key is configured, report the actual limitation — never fake it.
      emit({ type: 'model.request', prompt: prompt.slice(0, 200) });
      const execResult = await runRuflo(
        ['agent', 'execute', agentId, prompt],
        { timeout: 120000, signal,
          onStdout: (d) => emit({ type: 'command.output', stream: 'stdout', data: d }),
          onStderr: (d) => emit({ type: 'command.output', stream: 'stderr', data: d }),
        }
      );

      if (execResult.exitCode === 0) {
        emit({ type: 'model.response', response: execResult.stdout });
        emit({ type: 'task.completed', exitCode: 0 });
        this._setStatus(taskId, 'completed');
        task.result = execResult.stdout;
      } else {
        // Real failure — report it honestly
        const errMsg = execResult.stderr || execResult.stdout || `Agent execution failed (exit ${execResult.exitCode})`;
        emit({ type: 'task.failed', exitCode: execResult.exitCode, error: errMsg });
        this._setStatus(taskId, 'failed');
        task.error = errMsg;
      }
    } catch (err) {
      if (signal?.aborted) {
        emit({ type: 'task.cancelled', reason: 'aborted' });
        this._setStatus(taskId, 'cancelled');
      } else {
        emit({ type: 'task.failed', error: err.message });
        this._setStatus(taskId, 'failed');
        task.error = err.message;
      }
    }
    return task;
  }

  /**
   * Run a real build task: execute build commands in the workspace.
   */
  async runBuildTask({ command = 'npm run build', cwd, sessionId, onEvent, signal }) {
    const task = this.createTask({ prompt: command, type: 'build', sessionId });
    const { taskId } = task;
    const emit = (e) => { this._emitEvent(taskId, e); if (onEvent) onEvent(e); };

    try {
      this._setStatus(taskId, 'running');
      emit({ type: 'build.started', command });

      const result = await executeCommand({
        command,
        cwd,
        onOutput: (o) => emit({ type: 'command.output', stream: o.stream, data: o.data }),
        signal,
      });

      emit({ type: 'build.result', exitCode: result.exitCode, timedOut: result.timedOut });
      if (result.exitCode === 0 && !result.timedOut) {
        emit({ type: 'task.completed', exitCode: 0 });
        this._setStatus(taskId, 'completed');
        task.result = result.stdout;
      } else {
        emit({ type: 'task.failed', exitCode: result.exitCode, error: result.stderr || 'Build failed' });
        this._setStatus(taskId, 'failed');
        task.error = result.stderr || 'Build failed';
      }
    } catch (err) {
      emit({ type: 'task.failed', error: err.message });
      this._setStatus(taskId, 'failed');
      task.error = err.message;
    }
    return task;
  }

  /**
   * Run a real test task.
   */
  async runTestTask({ command = 'npm test', cwd, sessionId, onEvent, signal }) {
    const task = this.createTask({ prompt: command, type: 'test', sessionId });
    const { taskId } = task;
    const emit = (e) => { this._emitEvent(taskId, e); if (onEvent) onEvent(e); };

    try {
      this._setStatus(taskId, 'running');
      emit({ type: 'test.started', command });

      const result = await executeCommand({
        command,
        cwd,
        onOutput: (o) => emit({ type: 'command.output', stream: o.stream, data: o.data }),
        signal,
      });

      emit({ type: 'test.result', exitCode: result.exitCode });
      if (result.exitCode === 0) {
        emit({ type: 'task.completed', exitCode: 0 });
        this._setStatus(taskId, 'completed');
        task.result = result.stdout;
      } else {
        emit({ type: 'task.failed', exitCode: result.exitCode, error: result.stderr || 'Tests failed' });
        this._setStatus(taskId, 'failed');
        task.error = result.stderr || 'Tests failed';
      }
    } catch (err) {
      emit({ type: 'task.failed', error: err.message });
      this._setStatus(taskId, 'failed');
      task.error = err.message;
    }
    return task;
  }

  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'running') {
      this._emitEvent(taskId, { type: 'task.cancelled', reason: 'user' });
      this._setStatus(taskId, 'cancelled');
    }
    return true;
  }
}

export const taskManager = new TaskManager();
