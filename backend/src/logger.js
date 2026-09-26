// backend/src/logger.js — Structured logging with secret redaction
import { config, SECRET_KEYS } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[config.logLevel] ?? LEVELS.info;

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/g,
  /sk-ant-[A-Za-z0-9-_]{20,}/g,
  /AIza[A-Za-z0-9_-]{30,}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
];

function redactValue(val) {
  if (typeof val !== 'string') return val;
  let redacted = val;
  for (const re of SECRET_PATTERNS) {
    redacted = redacted.replace(re, '[REDACTED]');
  }
  return redacted;
}

function redact(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactValue(obj);
  if (Array.isArray(obj)) return obj.map(redact);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEYS.has(k)) {
        out[k] = v ? '[REDACTED]' : v;
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return obj;
}

export function log(level, message, meta = {}) {
  if ((LEVELS[level] ?? LEVELS.info) < MIN_LEVEL) return;
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...redact(meta),
  };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  debug: (m, meta) => log('debug', m, meta),
  info: (m, meta) => log('info', m, meta),
  warn: (m, meta) => log('warn', m, meta),
  error: (m, meta) => log('error', m, meta),
};

export { redact };
