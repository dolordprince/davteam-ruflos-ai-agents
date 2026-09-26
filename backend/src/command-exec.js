// backend/src/command-exec.js — Controlled command execution with streaming
import { spawn } from 'child_process';
import { config } from './config.js';
import { logger } from './logger.js';
import { safePath, validateCommand, auditLog } from './workspace.js';

/**
 * Execute a shell command in the workspace with timeouts, streaming,
 * output limits, and cancellation support.
 *
 * @param {object} params
 * @param {string} params.command - The command to run
 * @param {string} [params.cwd] - Working directory (within workspace)
 * @param {number} [params.timeoutMs] - Timeout in ms
 * @param {function} [params.onOutput] - Callback for stdout/stderr chunks
 * @param {AbortSignal} [params.signal] - AbortSignal for cancellation
 * @returns {Promise<{stdout, stderr, exitCode, timedOut, cancelled}>}
 */
export function executeCommand({ command, cwd, timeoutMs, onOutput, signal }) {
  const timeout = timeoutMs ?? config.commandTimeoutMs;
  const maxOutput = config.commandMaxOutput;
  const workCwd = cwd ? safePath(cwd) : safePath('.');

  validateCommand(command);
  auditLog('command.execute', { command, cwd: workCwd });

  return new Promise((resolvePromise, reject) => {
    let cancelled = false;
    let timedOut = false;
    let stdoutLen = 0;
    let stderrLen = 0;
    const stdoutChunks = [];
    const stderrChunks = [];

    const child = spawn('bash', ['-c', command], {
      cwd: workCwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2000);
    }, timeout);

    if (signal) {
      signal.addEventListener('abort', () => {
        cancelled = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 2000);
      }, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      const str = chunk.toString();
      if (stdoutLen < maxOutput) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
      if (onOutput) onOutput({ stream: 'stdout', data: str });
    });

    child.stderr.on('data', (chunk) => {
      const str = chunk.toString();
      if (stderrLen < maxOutput) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
      if (onOutput) onOutput({ stream: 'stderr', data: str });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        exitCode: code ?? (timedOut ? -1 : 0),
        timedOut,
        cancelled,
        truncated: stdoutLen >= maxOutput || stderrLen >= maxOutput,
      };
      auditLog('command.complete', { command, exitCode: result.exitCode, timedOut, cancelled });
      resolvePromise(result);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      logger.error('Command execution error', { command, error: err.message });
      reject(err);
    });
  });
}
