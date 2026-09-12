/**
 * One interface over Claude and ChatGPT.
 *
 * Both providers are asked for the same thing: a JSON object matching a schema.
 * Callers never see provider-specific shapes, so switching between them is a
 * single line in `.env`.
 */

import { config, hasCredentials } from '../config.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAiProvider } from './openai.js';

let provider = null;

export function getProvider() {
  if (provider) return provider;
  if (!hasCredentials()) {
    throw new Error(
      config.provider === 'openai'
        ? 'OPENAI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.'
        : 'ANTHROPIC_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.',
    );
  }
  provider = config.provider === 'openai' ? createOpenAiProvider() : createAnthropicProvider();
  return provider;
}

/** Reset between tests, or after changing configuration at runtime. */
export function resetProvider() {
  provider = null;
}

/**
 * Ask the model for a JSON object matching `schema`.
 *
 * @param {object} options
 * @param {string} options.system  system prompt; mark `cacheable` to cache it
 * @param {string} options.user    the request
 * @param {object} options.schema  JSON Schema the reply must satisfy
 * @param {'low'|'medium'|'high'} [options.effort]
 * @param {boolean} [options.cacheable] cache the system prompt across calls
 * @returns {Promise<object>} the parsed object
 */
export async function askForJson(options) {
  return getProvider().json(options);
}

/** Ask for prose, with no schema. */
export async function askForText(options) {
  return getProvider().text(options);
}

/**
 * Run async jobs with a ceiling on how many are in flight, so a turn with
 * twenty thinking nations does not open twenty sockets at once.
 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * JSON Schema helper.
 *
 * Both providers' strict modes require every property to be listed in
 * `required`, so optional fields are expressed as nullable instead. Callers get
 * back an object with the nulls stripped.
 */
export function nullable(type, extra = {}) {
  return { type: [type, 'null'], ...extra };
}

export function stripNulls(value) {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === null || item === undefined) continue;
      out[key] = stripNulls(item);
    }
    return out;
  }
  return value;
}
