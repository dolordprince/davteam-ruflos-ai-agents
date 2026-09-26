// backend/src/config.js — Configuration loading with secret redaction
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

function loadEnvFile() {
  const envPath = process.env.NODE_ENV === 'test' ? null : resolve(process.cwd(), '.env');
  if (!envPath || !existsSync(envPath)) return;
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // ignore
  }
}

loadEnvFile();

function intEnv(key, def) {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

export const config = {
  port: intEnv('PORT', 7860),
  host: process.env.HOST || '0.0.0.0',

  workspace: process.env.WORKSPACE || join(process.cwd(), 'workspace'),

  // Model provider (OpenAI-compatible) — server-side only
  modelBaseUrl: process.env.MODEL_BASE_URL || 'https://api.openai.com/v1',
  modelName: process.env.MODEL_NAME || 'gpt-4o',
  modelApiKey: process.env.MODEL_API_KEY || '',

  // Optional upstream provider keys
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  googleApiKey: process.env.GOOGLE_API_KEY || '',

  // JEV Decision API plugin (server-side only)
  jevApiKey: process.env.JEV_API_KEY || '',
  jevBaseUrl: process.env.JEV_BASE_URL || 'https://jev-agent.com',

  // Voice/TTS (server-side only — never exposed to browser)
  ttsProvider: process.env.TTS_PROVIDER || 'browser',
  ttsApiKey: process.env.TTS_API_KEY || '',
  ttsVoice: process.env.TTS_VOICE || 'alloy',

  // MCP tool groups
  mcpGroups: {
    agents: process.env.MCP_GROUP_AGENTS !== 'false',
    memory: process.env.MCP_GROUP_MEMORY !== 'false',
    devtools: process.env.MCP_GROUP_DEVTOOLS !== 'false',
    security: process.env.MCP_GROUP_SECURITY === 'true',
    browser: process.env.MCP_GROUP_BROWSER === 'true',
    neural: process.env.MCP_GROUP_NEURAL === 'true',
  },

  // Auth
  apiToken: process.env.DAVTEAM_API_TOKEN || '',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Command execution limits
  commandTimeoutMs: intEnv('COMMAND_TIMEOUT_MS', 60000),
  commandMaxOutput: intEnv('COMMAND_MAX_OUTPUT', 200000),
};

// Keys whose values must never be logged
export const SECRET_KEYS = new Set([
  'MODEL_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'GOOGLE_API_KEY', 'DAVTEAM_API_TOKEN', 'MODEL_BASE_URL',
  'JEV_API_KEY', 'JEV_BASE_URL', 'TTS_API_KEY',
]);

export function isConfigured() {
  return {
    model: Boolean(config.modelApiKey),
    anthropic: Boolean(config.anthropicApiKey),
    openai: Boolean(config.openaiApiKey),
    google: Boolean(config.googleApiKey),
    jev: Boolean(config.jevApiKey),
  };
}
