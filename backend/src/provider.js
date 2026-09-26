// backend/src/provider.js — Model provider abstraction (OpenAI-compatible)
// Provider credentials are server-side only. The frontend never receives them.
import { config } from './config.js';
import { logger } from './logger.js';
import { redact } from './logger.js';

/**
 * List configured/available model providers.
 * Never returns API keys.
 */
export function listProviders() {
  return [
    {
      id: 'openai-compatible',
      name: config.modelName || 'gpt-4o',
      type: 'LLM',
      baseUrl: config.modelBaseUrl ? '[configured]' : null,
      configured: Boolean(config.modelApiKey),
      serverSideOnly: true,
    },
    {
      id: 'anthropic',
      name: 'Claude',
      type: 'LLM',
      configured: Boolean(config.anthropicApiKey),
      serverSideOnly: true,
    },
    {
      id: 'openai',
      name: 'GPT',
      type: 'LLM',
      configured: Boolean(config.openaiApiKey),
      serverSideOnly: true,
    },
    {
      id: 'google',
      name: 'Gemini',
      type: 'LLM',
      configured: Boolean(config.googleApiKey),
      serverSideOnly: true,
    },
    {
      id: 'transformers-local',
      name: 'Xenova/all-MiniLM-L6-v2',
      type: 'Embedding',
      configured: true,
      available: 'local',
      serverSideOnly: false,
    },
  ];
}

/**
 * List available models (never includes keys).
 */
export function listModels() {
  const models = [];
  if (config.modelApiKey) {
    models.push({
      id: config.modelName || 'gpt-4o',
      provider: 'openai-compatible',
      available: true,
    });
  }
  if (config.anthropicApiKey) {
    models.push({ id: 'claude-3.5-sonnet', provider: 'anthropic', available: true });
    models.push({ id: 'opus', provider: 'anthropic', available: true });
  }
  if (config.openaiApiKey) {
    models.push({ id: 'gpt-4o', provider: 'openai', available: true });
    models.push({ id: 'gpt-4-turbo', provider: 'openai', available: true });
  }
  if (config.googleApiKey) {
    models.push({ id: 'gemini-pro', provider: 'google', available: true });
  }
  // Local embedding model always available
  models.push({
    id: 'Xenova/all-MiniLM-L6-v2',
    provider: 'transformers-local',
    available: true,
    type: 'embedding',
  });
  return models;
}

/**
 * Perform a chat completion against the configured OpenAI-compatible endpoint.
 * Streams tokens if onToken is provided; otherwise returns full response.
 * Credentials are never exposed to the caller.
 *
 * @param {object} params
 * @param {Array} params.messages - [{role, content}]
 * @param {string} [params.model] - model name override
 * @param {function} [params.onToken] - streaming callback
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{content, model, usage}>}
 */
export async function chatCompletion({ messages, model, onToken, signal }) {
  const baseUrl = config.modelBaseUrl;
  const apiKey = config.modelApiKey;
  const modelName = model || config.modelName || 'gpt-4o';

  if (!apiKey) {
    throw new ProviderError('No model provider configured. Set MODEL_API_KEY on the server.', 'NO_PROVIDER');
  }

  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  logger.info('model.request', { model: modelName, url: '[redacted]', messages: messages.length });

  const body = JSON.stringify({
    model: modelName,
    messages,
    stream: Boolean(onToken),
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body,
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error('model.error', { status: res.status, error: redact(errText) });
    throw new ProviderError(`Model provider returned ${res.status}`, 'PROVIDER_ERROR', { status: res.status });
  }

  if (onToken && res.body) {
    // Stream SSE
    let fullContent = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const token = parsed.choices?.[0]?.delta?.content || '';
          if (token) {
            fullContent += token;
            onToken(token);
          }
        } catch {
          // skip malformed
        }
      }
    }
    return { content: fullContent, model: modelName, usage: null };
  } else {
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    return { content, model: modelName, usage: data.usage || null };
  }
}

export class ProviderError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.details = details;
  }
}
