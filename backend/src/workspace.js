// backend/src/workspace.js — Workspace isolation and path validation
// Prevents path traversal outside the configured workspace.
import { resolve, normalize, join, relative, isAbsolute } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { config } from './config.js';
import { logger } from './logger.js';

const WORKSPACE_ROOT = resolve(config.workspace);

// Forbidden host paths that must never be accessible
const FORBIDDEN_PREFIXES = [
  '/etc', '/root', '/proc', '/sys', '/dev',
  '/boot', '/lib', '/lib64', '/usr/lib',
  '/var/log', '/var/run',
];

export function getWorkspaceRoot() {
  return WORKSPACE_ROOT;
}

/**
 * Validate that a path resolves inside the configured workspace.
 * Returns the safe absolute path or throws on traversal.
 */
export function safePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new PathValidationError('Path is required');
  }

  const base = isAbsolute(inputPath) ? inputPath : join(WORKSPACE_ROOT, inputPath);
  const normalized = normalize(base);

  // Block forbidden system paths explicitly
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix + '/')) {
      throw new PathValidationError(`Access to system path denied: ${prefix}`);
    }
  }

  // Resolve against workspace root
  const resolved = resolve(WORKSPACE_ROOT, relative(WORKSPACE_ROOT, normalized));

  // Ensure the resolved path is within the workspace
  const rel = relative(WORKSPACE_ROOT, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathValidationError(`Path traversal detected: ${inputPath}`);
  }

  return resolved;
}

/**
 * Check if a path is within the workspace (does not throw).
 */
export function isWithinWorkspace(inputPath) {
  try {
    safePath(inputPath);
    return true;
  } catch {
    return false;
  }
}

export class PathValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathValidationError';
    this.code = 'PATH_VALIDATION_FAILED';
  }
}

/**
 * Validate a shell command against a denylist of dangerous patterns.
 * Returns the command or throws.
 */
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\/(\s|$)/i,          // rm -rf /
  /\bmkfs\b/i,                        // filesystem format
  /\bdd\s+if=\/dev\//i,              // dd from device
  /\b:\(\)\s*\{\s*:\|:&\s*\};:/i,    // fork bomb
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\b>\s*\/dev\/sd[a-z]/i,           // write to disk device
  /\bchmod\s+-R\s+777\s+\/\b/i,      // recursive chmod root
];

// Patterns that reference forbidden host paths in a command
const FORBIDDEN_PATH_PATTERNS = [
  /(^|[\s;&|<>])\/etc\b/,
  /(^|[\s;&|<>])\/root\b/,
  /(^|[\s;&|<>])\/proc\b/,
  /(^|[\s;&|<>])\/sys\b/,
  /(^|[\s;&|<>])\/dev\b/,
  /(^|[\s;&|<>])\/boot\b/,
  /(^|[\s;&|<>])\/lib\b/,
  /(^|[\s;&|<>])\/lib64\b/,
  /\.\.\//, // parent-directory traversal
];

export function validateCommand(command) {
  if (!command || typeof command !== 'string') {
    throw new CommandValidationError('Command is required');
  }
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      throw new CommandValidationError(`Command contains forbidden pattern: ${pattern.source}`);
    }
  }
  for (const pattern of FORBIDDEN_PATH_PATTERNS) {
    if (pattern.test(command)) {
      throw new CommandValidationError(`Command references forbidden system path: ${pattern.source}`);
    }
  }
  return command;
}

export class CommandValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommandValidationError';
    this.code = 'COMMAND_VALIDATION_FAILED';
  }
}

/**
 * Audit log entry for filesystem/command actions.
 */
export function auditLog(action, details) {
  logger.info('AUDIT', {
    action,
    workspace: WORKSPACE_ROOT,
    ...details,
  });
}
