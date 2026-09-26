// backend/src/file-ops.js — Controlled workspace file operations.
// All paths are validated through workspace security (no traversal, no system paths).
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { safePath, auditLog, PathValidationError } from './workspace.js';
import { getWorkspaceRoot } from './workspace.js';
import { logger } from './logger.js';

/**
 * Read a file from the workspace.
 */
export function readFile(relPath) {
  const abs = safePath(relPath);
  if (!existsSync(abs)) throw new FileOpError('File not found', 'NOT_FOUND', { path: relPath });
  auditLog('file.read', { path: relPath });
  return readFileSync(abs, 'utf-8');
}

/**
 * Write/create/update a file in the workspace. Emits nothing here —
 * the caller (autonomous builder) emits the file.created/file.updated event.
 */
export function writeFile(relPath, content) {
  const abs = safePath(relPath);
  const existed = existsSync(abs);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
  auditLog('file.write', { path: relPath, created: !existed, bytes: content.length });
  return { path: relPath, created: !existed, bytes: content.length };
}

/**
 * Delete a file from the workspace.
 */
export function deleteFile(relPath) {
  const abs = safePath(relPath);
  if (!existsSync(abs)) throw new FileOpError('File not found', 'NOT_FOUND', { path: relPath });
  unlinkSync(abs);
  auditLog('file.delete', { path: relPath });
  return { path: relPath, deleted: true };
}

/**
 * List files in a workspace directory (recursive, relative paths).
 */
export function listFiles(relDir = '.') {
  const abs = safePath(relDir);
  if (!existsSync(abs)) return [];
  const root = getWorkspaceRoot();
  const results = [];
  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        results.push(relative(root, full));
      }
    }
  }
  walk(abs);
  return results;
}

/**
 * Check if a file exists in the workspace.
 */
export function fileExists(relPath) {
  try {
    return existsSync(safePath(relPath));
  } catch {
    return false;
  }
}

/**
 * Get file stats.
 */
export function fileStat(relPath) {
  const abs = safePath(relPath);
  if (!existsSync(abs)) return null;
  const s = statSync(abs);
  return { size: s.size, modified: s.mtime.toISOString(), isDir: s.isDirectory() };
}

export class FileOpError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'FileOpError';
    this.code = code;
    this.details = details;
  }
}
