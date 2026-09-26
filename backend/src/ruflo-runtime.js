// backend/src/ruflo-runtime.js — Wraps the REAL Ruflo runtime via subprocess.
// Executes actual `ruflo` CLI commands and captures genuine JSON output.
import { spawn } from 'child_process';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the real ruflo binary from the installed node_modules
function resolveRufloBin() {
  // Walk up from backend/src to find node_modules/ruflo
  let dir = resolve(__dirname, '..', '..'); // project root
  const candidate = join(dir, 'node_modules', 'ruflo', 'bin', 'ruflo.js');
  if (existsSync(candidate)) return candidate;
  // Fallback: search higher
  for (let i = 0; i < 6; i++) {
    const c = join(dir, 'node_modules', 'ruflo', 'bin', 'ruflo.js');
    if (existsSync(c)) return c;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export const rufloBin = resolveRufloBin();
export const rufloAvailable = Boolean(rufloBin);

let cachedVersion = null;

/**
 * Get the real Ruflo version by running `ruflo --version`.
 */
export async function getRufloVersion() {
  if (cachedVersion !== null) return cachedVersion;
  if (!rufloAvailable) {
    cachedVersion = { version: null, available: false };
    return cachedVersion;
  }
  try {
    const out = await runRuflo(['--version'], { timeout: 15000 });
    const match = out.stdout.match(/ruflo v?([\d.]+)/i);
    cachedVersion = { version: match ? match[1] : out.stdout.trim(), available: true };
  } catch (err) {
    logger.error('Failed to get ruflo version', { error: err.message });
    cachedVersion = { version: null, available: false, error: err.message };
  }
  return cachedVersion;
}

/**
 * Run a real Ruflo CLI command and capture stdout/stderr/exit code.
 * @param {string[]} args - CLI arguments (e.g. ['agent', 'spawn', '-t', 'coder', '--format', 'json'])
 * @param {object} opts - { timeout, cwd, env }
 * @returns {Promise<{stdout, stderr, exitCode}>}
 */
export function runRuflo(args, opts = {}) {
  const timeout = opts.timeout ?? 60000;
  const cwd = opts.cwd ?? process.cwd();
  const env = { ...process.env, ...opts.env };

  return new Promise((resolvePromise, reject) => {
    if (!rufloAvailable) {
      reject(new Error('Ruflo runtime not available (ruflo bin not found)'));
      return;
    }

    const child = spawn('node', [rufloBin, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stdoutChunks = [];
    let stderrChunks = [];

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(chunk);
      if (opts.onStdout) opts.onStdout(chunk.toString());
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
      if (opts.onStderr) opts.onStderr(chunk.toString());
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2000);
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      stdout = Buffer.concat(stdoutChunks).toString();
      stderr = Buffer.concat(stderrChunks).toString();
      if (timedOut) {
        reject(new Error(`Ruflo command timed out after ${timeout}ms`));
        return;
      }
      resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Allow stdin for commands that need input
    if (opts.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Extract a JSON object/array from Ruflo stdout (which may contain
 * table/log output before/after the JSON block).
 */
export function extractJson(stdout) {
  if (!stdout) return null;
  // Try to find a JSON block: {...} or [...]
  const jsonMatch = stdout.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      // fall through
    }
  }
  // Try parsing the whole thing
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Run a Ruflo command that produces JSON, returning the parsed result.
 */
export async function runRufloJson(args, opts = {}) {
  const fullArgs = [...args];
  // Ensure --format json is appended if not present
  if (!fullArgs.includes('--format') && !fullArgs.includes('-f')) {
    fullArgs.push('--format', 'json');
  }
  const result = await runRuflo(fullArgs, opts);
  const json = extractJson(result.stdout);
  return { ...result, json };
}

/**
 * Run `ruflo doctor` and return real health-check results.
 */
export async function runDoctor(component) {
  const args = component
    ? ['doctor', '--component', component]
    : ['doctor'];
  return runRuflo(args, { timeout: 90000 });
}

// --- Capability detection (lazy, cached) ---

let capabilitiesCache = null;

export async function getCapabilities() {
  if (capabilitiesCache) return capabilitiesCache;

  const caps = {
    ruflo: rufloAvailable,
    agents: false,
    swarm: false,
    memory: false,
    mcp: false,
    metaharness: false,
    terminal: false,
    model: false,
    neural: false,
    security: false,
    embeddings: false,
  };

  if (!rufloAvailable) {
    capabilitiesCache = caps;
    return caps;
  }

  // Detect by probing command help (fast, no heavy imports)
  const probes = [
    { key: 'agents', args: ['agent', '--help'] },
    { key: 'swarm', args: ['swarm', '--help'] },
    { key: 'memory', args: ['memory', '--help'] },
    { key: 'mcp', args: ['mcp', '--help'] },
    { key: 'metaharness', args: ['metaharness', '--help'] },
    { key: 'terminal', args: ['mcp', 'tools', '--format', 'json'] },
    { key: 'neural', args: ['neural', '--help'] },
    { key: 'security', args: ['security', '--help'] },
    { key: 'embeddings', args: ['embeddings', '--help'] },
  ];

  const results = await Promise.allSettled(
    probes.map((p) => runRuflo(p.args, { timeout: 15000 }).then((r) => ({ key: p.key, exitCode: r.exitCode })))
  );
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.exitCode === 0) {
      caps[r.value.key] = true;
    }
  }

  // Model capability depends on a configured key
  const { isConfigured } = await import('./config.js');
  const configured = isConfigured();
  caps.model = configured.model || configured.anthropic || configured.openai || configured.google;

  // JEV plugin capability (server-side)
  caps.jev = configured.jev;

  capabilitiesCache = caps;
  return caps;
}

export function resetCapabilitiesCache() {
  capabilitiesCache = null;
}
