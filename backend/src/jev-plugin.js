// backend/src/jev-plugin.js — JEV Decision API integration as a server-side plugin.
// JEV (Jev by TypeSafe AI) provides typed AI decisions: choice / score / noul.
// All credentials are server-side only. The browser never sees JEV_API_KEY.
// Docs: https://jev-agent.com/api-reference 【web-jevagent-0bd53b26】
//       https://www.jevai.org/docs 【web-jevai-ab229794】
import { config } from './config.js';
import { logger } from './logger.js';
import { redact } from './logger.js';

// The JEV API key is read from env (server-side only, never exposed to frontend).
const JEV_API_KEY = process.env.JEV_API_KEY || '';
const JEV_BASE_URL = process.env.JEV_BASE_URL || 'https://jev-agent.com';

export const jevConfigured = Boolean(JEV_API_KEY);

/**
 * JEV plugin metadata — exposed through /api/plugins so the frontend and
 * Ruflo agents can discover JEV as a capability/tool without any client-side secret.
 */
export const jevPluginInfo = {
  id: 'jev',
  name: 'JEV Decision API',
  type: 'decision',
  source: 'jev-agent',
  description:
    'Typed AI decisions for routing, guardrails, scoring, and gating. ' +
    'Provides choice / score / noul question types via the Jev Decision API. ' +
    'Credentials are server-side only — the browser never receives the API key.',
  configured: jevConfigured,
  serverSideOnly: true,
  endpoints: [
    { method: 'POST', path: '/api/plugins/jev/decide', description: 'Native decisions (state + questions)' },
    { method: 'POST', path: '/api/plugins/jev/classify', description: 'Classify text via a preset ruleset' },
    { method: 'POST', path: '/api/plugins/jev/tool-guard', description: 'Guard a tool call (allow/confirm/review/deny)' },
    { method: 'POST', path: '/api/plugins/jev/systemone', description: 'SystemOne decisions (state + questions)' },
  ],
  questionTypes: [
    { type: 'choice', description: 'Pick one option from criteria. Returns choice, probabilities, confidence.' },
    { type: 'score', description: 'Ordered levels. Returns score, probabilities, optional legend.' },
    { type: 'noul', description: 'Probability of yes. Returns noul between 0 and 1.' },
  ],
};

/**
 * List all registered plugins (currently just JEV, but structured for extensibility).
 */
export function listPlugins() {
  return [jevPluginInfo];
}

/**
 * Get a plugin by id.
 */
export function getPlugin(id) {
  if (id === 'jev') return jevPluginInfo;
  return null;
}

class JevError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Internal: call the JEV API with server-side credentials.
 * Never exposes the key to the caller or the browser.
 */
async function jevFetch(path, body) {
  if (!jevConfigured) {
    throw new JevError(
      'JEV plugin not configured. Set JEV_API_KEY on the server.',
      'JEV_NOT_CONFIGURED'
    );
  }
  const url = JEV_BASE_URL.replace(/\/$/, '') + path;
  logger.info('jev.request', { path, url: '[redacted]' });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${JEV_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      logger.error('jev.error', { status: res.status, error: redact(text).slice(0, 500) });
      throw new JevError(
        `JEV API returned ${res.status}`,
        'JEV_API_ERROR',
        { status: res.status }
      );
    }
    logger.info('jev.response', { path, code: data.code });
    return data;
  } catch (err) {
    if (err instanceof JevError) throw err;
    logger.error('jev.fetch.error', { error: err.message });
    throw new JevError(`JEV request failed: ${err.message}`, 'JEV_FETCH_FAILED');
  }
}

/**
 * Native JEV decision: send state + questions, get typed answers.
 * POST /api/v1/decisions  (jev-agent.com) or /api/v1/systemone
 * @param {object} params - { state, questions, model }
 *   questions: { [name]: { type: 'choice'|'score'|'noul', instructions, criteria } }
 */
export async function jevDecide({ state, questions, model }) {
  if (!state) throw new JevError('state is required', 'INVALID_REQUEST');
  if (!questions || typeof questions !== 'object') {
    throw new JevError('questions object is required', 'INVALID_REQUEST');
  }
  // jev-agent.com uses /api/v1/systemone for native decisions with own questions
  return jevFetch('/api/v1/systemone', { state, questions, ...(model ? { model } : {}) });
}

/**
 * Classify text via a preset ruleset.
 * POST /api/v1/classify
 * @param {object} params - { ruleset, items }
 */
export async function jevClassify({ ruleset, items }) {
  if (!ruleset) throw new JevError('ruleset is required', 'INVALID_REQUEST');
  if (!Array.isArray(items)) throw new JevError('items array is required', 'INVALID_REQUEST');
  return jevFetch('/api/v1/classify', { ruleset, items });
}

/**
 * Tool guard: guard a tool call — returns allow / confirm / review / deny.
 * POST /api/v1/decisions/tool-guard  (jevai.org)
 * @param {object} params - { tool, action, arguments_summary, side_effects, safeguards, policy, reversibility }
 */
export async function jevToolGuard(params) {
  if (!params.tool) throw new JevError('tool is required', 'INVALID_REQUEST');
  if (!params.action) throw new JevError('action is required', 'INVALID_REQUEST');
  return jevFetch('/api/v1/decisions/tool-guard', params);
}

/**
 * MCP-style tool descriptor for JEV, so Ruflo agents can discover and invoke JEV
 * through the existing tool/MCP architecture.
 */
export const jevTools = [
  {
    name: 'jev_decide',
    category: 'decision',
    description: 'Make a typed JEV decision (choice/score/noul) for routing, scoring, or gating.',
    enabled: jevConfigured,
    parameters: { state: 'string', questions: 'object', model: 'string?' },
  },
  {
    name: 'jev_classify',
    category: 'decision',
    description: 'Classify text using a preset JEV ruleset.',
    enabled: jevConfigured,
    parameters: { ruleset: 'string', items: 'string[]' },
  },
  {
    name: 'jev_tool_guard',
    category: 'guardrail',
    description: 'Guard a tool call — returns allow / confirm / review / deny.',
    enabled: jevConfigured,
    parameters: { tool: 'string', action: 'string', arguments_summary: 'string[]?' },
  },
];

/**
 * Execute a JEV tool by name (used by the tool execution layer).
 */
export async function executeJevTool(toolName, args) {
  switch (toolName) {
    case 'jev_decide':
      return jevDecide(args);
    case 'jev_classify':
      return jevClassify(args);
    case 'jev_tool_guard':
      return jevToolGuard(args);
    default:
      throw new JevError(`Unknown JEV tool: ${toolName}`, 'UNKNOWN_TOOL');
  }
}

export { JevError };
