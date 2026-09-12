/**
 * Claude backend.
 *
 * Uses structured outputs (`output_config.format`) so the reply is guaranteed to
 * match the schema the engine expects, and prompt caching on the rules block,
 * which is identical on every call within a turn.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

/**
 * Server-side refusal fallback keeps a turn alive if a safety classifier
 * declines — a live possibility for a simulation about war. It is a beta, so if
 * the account cannot use it we drop it and carry on rather than failing the turn.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function createAnthropicProvider() {
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  let fallbacksAvailable = true;

  const buildSystem = (system, cacheable) => {
    const blocks = [{ type: 'text', text: system }];
    if (cacheable) blocks[0].cache_control = { type: 'ephemeral' };
    return blocks;
  };

  async function send(params) {
    const attempt = async (withFallbacks) => {
      const request = {
        model: config.anthropic.model,
        max_tokens: params.maxTokens ?? 8000,
        system: buildSystem(params.system, params.cacheable),
        messages: [{ role: 'user', content: params.user }],
        output_config: {
          effort: params.effort ?? 'medium',
          ...(params.schema ? { format: { type: 'json_schema', schema: params.schema } } : {}),
        },
      };
      if (withFallbacks) {
        request.betas = [FALLBACK_BETA];
        request.fallbacks = 'default';
        return client.beta.messages.create(request);
      }
      return params.schema ? client.messages.parse(request) : client.messages.create(request);
    };

    if (fallbacksAvailable) {
      try {
        return await attempt(true);
      } catch (error) {
        const message = String(error?.message ?? '');
        const unsupported =
          error?.status === 400 && /fallback|beta|unsupported|unrecognized/i.test(message);
        if (!unsupported) throw error;
        fallbacksAvailable = false; // remember, so we only pay for this once
      }
    }
    return attempt(false);
  }

  const textOf = (response) => {
    const parts = [];
    for (const block of response.content ?? []) {
      if (block.type === 'text') parts.push(block.text);
    }
    return parts.join('').trim();
  };

  return {
    name: 'anthropic',
    model: config.anthropic.model,

    async json({ system, user, schema, effort = 'medium', cacheable = false, maxTokens }) {
      const response = await send({ system, user, schema, effort, cacheable, maxTokens });
      if (response.stop_reason === 'refusal') {
        throw new Error(
          `모델이 요청을 거부했습니다 (${response.stop_details?.category ?? 'unknown'}). 명령 내용을 바꿔 보세요.`,
        );
      }
      if (response.parsed_output) return response.parsed_output;
      const text = textOf(response);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`모델이 JSON을 반환하지 않았습니다: ${text.slice(0, 200)}`);
      }
    },

    async text({ system, user, effort = 'low', cacheable = false, maxTokens }) {
      const response = await send({ system, user, effort, cacheable, maxTokens });
      if (response.stop_reason === 'refusal') return '';
      return textOf(response);
    },
  };
}
