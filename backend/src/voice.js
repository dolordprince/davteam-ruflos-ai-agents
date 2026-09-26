// backend/src/voice.js — TTS provider abstraction.
// Server-side credentials only — NEVER exposed to the browser.
// Supports multiple TTS providers through a common interface.
import { logger } from './logger.js';
import { config } from './config.js';

// Provider registry — each provider implements: synthesize(text, options) -> { audio, format }
const providers = {};

/**
 * Register a TTS provider.
 */
export function registerProvider(name, provider) {
  if (!provider || typeof provider.synthesize !== 'function') {
    throw new Error(`Provider "${name}" must implement synthesize()`);
  }
  providers[name] = provider;
  logger.info('voice.provider.registered', { name });
}

/**
 * Get the configured TTS provider.
 * Credentials come from server-side config only.
 */
function getProvider() {
  const name = config.ttsProvider || 'none';
  if (name === 'none' || !providers[name]) return null;
  return providers[name];
}

/**
 * Synthesize speech from text.
 * All credentials stay server-side. Only the audio bytes are returned.
 *
 * @param {string} text - The text to speak
 * @param {object} options - { voice, speed, pitch, format }
 * @returns {Promise<object>} { audio: Buffer, format: string, provider: string } or { available: false, reason }
 */
export async function synthesize(text, options = {}) {
  const { voice, speed = 1.0, pitch = 1.0, format = 'mp3' } = options;

  // Truncate very long text — Osiri speaks short responses, not entire logs
  const truncated = text.length > 500 ? text.slice(0, 500) + '...' : text;

  const provider = getProvider();
  if (!provider) {
    return {
      available: false,
      reason: 'No TTS provider configured. Set TTS_PROVIDER and TTS_API_KEY in server environment.',
    };
  }

  try {
    const result = await provider.synthesize(truncated, {
      voice: voice || config.ttsVoice || 'default',
      speed,
      pitch,
      format,
    });
    logger.info('voice.synthesize.success', { provider: config.ttsProvider, length: truncated.length, format: result.format });
    return {
      available: true,
      audio: result.audio,
      format: result.format,
      provider: config.ttsProvider,
    };
  } catch (err) {
    logger.error('voice.synthesize.failed', { error: err.message, provider: config.ttsProvider });
    return {
      available: false,
      reason: `TTS synthesis failed: ${err.message}`,
    };
  }
}

/**
 * Check if voice/TTS is available.
 */
export function isVoiceAvailable() {
  return getProvider() !== null;
}

/**
 * Get available voices from the configured provider.
 */
export async function getVoices() {
  const provider = getProvider();
  if (!provider || typeof provider.getVoices !== 'function') {
    return { available: false, voices: [] };
  }
  try {
    const voices = await provider.getVoices();
    return { available: true, voices };
  } catch (err) {
    logger.error('voice.getVoices.failed', { error: err.message });
    return { available: false, voices: [], error: err.message };
  }
}

/**
 * Stop any currently playing speech (for interruption).
 * This is a signal to the client — actual audio stopping happens browser-side.
 */
export function stopSpeech() {
  return { stopped: true, message: 'Speech interruption signal sent' };
}

// --- Built-in provider: OpenAI-compatible TTS ---
// Only activated when TTS_PROVIDER=openai and TTS_API_KEY is set in server env.
registerProvider('openai', {
  async synthesize(text, options) {
    const apiKey = config.ttsApiKey;
    if (!apiKey) throw new Error('TTS_API_KEY not configured');

    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: options.voice || 'alloy',
        speed: options.speed || 1.0,
        response_format: options.format || 'mp3',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI TTS error: ${response.status} ${err.slice(0, 200)}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    return { audio: audioBuffer, format: options.format || 'mp3' };
  },

  async getVoices() {
    return ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  },
});

// --- Built-in provider: Browser-native (no server-side TTS, client uses Web Speech API) ---
// When TTS_PROVIDER=browser, the server sends a signal and the browser uses its own speech synthesis.
// No credentials needed — the browser handles it natively.
registerProvider('browser', {
  async synthesize(text, options) {
    // Return a signal that tells the browser to use its own Web Speech API
    return {
      audio: null,
      format: 'web-speech',
      text,
      voice: options.voice || 'default',
      speed: options.speed || 1.0,
      pitch: options.pitch || 1.0,
    };
  },
  async getVoices() {
    return []; // Browser determines available voices
  },
});

export const voice = { synthesize, isVoiceAvailable, getVoices, stopSpeech, registerProvider };
