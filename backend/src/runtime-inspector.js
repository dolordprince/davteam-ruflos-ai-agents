// backend/src/runtime-inspector.js — Runtime inspection stage.
// Inspects: process status, server logs, HTTP responses, exceptions, port usage.
import { executeCommand } from './command-exec.js';
import { fileExists, readFile } from './file-ops.js';
import { logger } from './logger.js';

/**
 * Inspect the runtime state of a project.
 * Checks process status, server logs, HTTP responses, and configuration.
 *
 * @param {object} options - { projectDir, port, serverProcess }
 * @returns {Promise<object>} { status, checks, errors, warnings, evidence }
 */
export async function inspectRuntime(options = {}) {
  const { projectDir, port = 5173, serverProcess = null } = options;
  const result = {
    status: 'PASS',
    checks: [],
    errors: [],
    warnings: [],
    evidence: [],
  };

  // Check 1: Process status
  if (serverProcess) {
    const alive = serverProcess.exitCode === null && !serverProcess.killed;
    result.checks.push({ name: 'process-status', status: alive ? 'PASS' : 'FAIL', detail: alive ? 'process running' : 'process exited' });
    if (!alive) {
      result.status = 'FAIL';
      result.errors.push({ check: 'process-status', message: 'Server process is not running', exitCode: serverProcess.exitCode });
    }
    result.evidence.push({ check: 'process-status', evidence: `PID: ${serverProcess.pid}, exitCode: ${serverProcess.exitCode}` });
  }

  // Check 2: HTTP response (if server should be running)
  if (port) {
    try {
      const httpResult = await executeCommand({
        command: `curl -s -w "%{http_code}" http://localhost:${port}/ --max-time 5 -o /tmp/osiri-http-check.txt`,
        timeoutMs: 10000,
      });
      const httpCode = httpResult.stdout?.trim();
      const isOk = httpCode && httpCode !== '000' && parseInt(httpCode) < 500;
      result.checks.push({ name: 'http-response', status: isOk ? 'PASS' : 'FAIL', detail: `HTTP ${httpCode}` });
      result.evidence.push({ check: 'http-response', evidence: `HTTP status: ${httpCode}` });
      if (!isOk) {
        result.status = 'FAIL';
        result.errors.push({ check: 'http-response', message: `Server returned HTTP ${httpCode}`, port });
      }
    } catch (err) {
      result.checks.push({ name: 'http-response', status: 'FAIL', detail: err.message });
      result.status = 'FAIL';
      result.errors.push({ check: 'http-response', message: `Could not reach server on port ${port}: ${err.message}` });
    }
  }

  // Check 3: Port availability
  if (port) {
    try {
      const portResult = await executeCommand({
        command: `lsof -i :${port} 2>/dev/null | head -5 || echo "port not in use"`,
        timeoutMs: 5000,
      });
      const portInUse = !portResult.stdout?.includes('port not in use');
      result.checks.push({ name: 'port-availability', status: portInUse ? 'PASS' : 'FAIL', detail: portInUse ? `port ${port} in use` : `port ${port} not in use` });
      result.evidence.push({ check: 'port-availability', evidence: portResult.stdout?.slice(0, 200) });
    } catch (err) {
      result.checks.push({ name: 'port-availability', status: 'SKIP', detail: err.message });
    }
  }

  // Check 4: Server logs (if log file exists)
  const logPath = `${projectDir}/server.log`;
  if (fileExists(logPath)) {
    try {
      const logs = readFile(logPath);
      const hasErrors = /error|exception|fatal|crash/i.test(logs);
      result.checks.push({ name: 'server-logs', status: hasErrors ? 'WARN' : 'PASS', detail: hasErrors ? 'errors found in logs' : 'logs clean' });
      result.evidence.push({ check: 'server-logs', evidence: logs.slice(-500) });
      if (hasErrors) {
        result.warnings.push({ check: 'server-logs', message: 'Error patterns found in server logs' });
      }
    } catch (err) {
      result.checks.push({ name: 'server-logs', status: 'SKIP', detail: err.message });
    }
  } else {
    result.checks.push({ name: 'server-logs', status: 'SKIP', detail: 'no log file' });
  }

  // Check 5: Configuration validation
  const pkgPath = `${projectDir}/package.json`;
  if (fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(readFile(pkgPath));
      const hasScripts = pkg.scripts && typeof pkg.scripts === 'object';
      result.checks.push({ name: 'config-validation', status: hasScripts ? 'PASS' : 'FAIL', detail: hasScripts ? 'scripts defined' : 'no scripts' });
      result.evidence.push({ check: 'config-validation', evidence: `scripts: ${Object.keys(pkg.scripts || {}).join(', ')}` });
    } catch (err) {
      result.checks.push({ name: 'config-validation', status: 'FAIL', detail: 'invalid package.json' });
      result.status = 'FAIL';
      result.errors.push({ check: 'config-validation', message: 'package.json is invalid JSON' });
    }
  }

  // Check 6: Dependency failures
  try {
    const depCheck = await executeCommand({
      command: `cd ${projectDir} && npm ls --depth=0 2>&1 | grep -i "missing\|invalid\|unmet" | head -5 || echo "deps OK"`,
      timeoutMs: 10000,
    });
    const hasDepIssues = !depCheck.stdout?.includes('deps OK');
    result.checks.push({ name: 'dependency-check', status: hasDepIssues ? 'WARN' : 'PASS', detail: hasDepIssues ? 'dependency issues found' : 'all deps OK' });
    if (hasDepIssues) {
      result.warnings.push({ check: 'dependency-check', message: 'Dependency issues detected', detail: depCheck.stdout?.slice(0, 300) });
    }
  } catch (err) {
    result.checks.push({ name: 'dependency-check', status: 'SKIP', detail: err.message });
  }

  logger.info('runtime-inspector.complete', { status: result.status, checks: result.checks.length, errors: result.errors.length });
  return result;
}
