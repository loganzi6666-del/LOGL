/**
 * ChatGPT backend.
 *
 * Uses `response_format: json_schema` in strict mode, which is OpenAI's
 * equivalent of Claude's structured outputs: the reply is guaranteed to parse
 * against the schema the engine expects.
 */

import OpenAI from 'openai';
import { config } from '../config.js';

export function createOpenAiProvider() {
  const client = new OpenAI({
    // Local servers ignore the key but the SDK insists on one being present.
    apiKey: config.openai.apiKey ?? 'local',
    ...(config.openai.baseUrl ? { baseURL: config.openai.baseUrl } : {}),
  });

  // Strict mode forbids a few JSON Schema constructs that Claude accepts.
  const sanitise = (schema) => JSON.parse(JSON.stringify(schema));

  async function send({ system, user, schema, maxTokens }) {
    return client.chat.completions.create({
      model: config.openai.model,
      max_completion_tokens: maxTokens ?? 8000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(schema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'response', strict: true, schema: sanitise(schema) },
            },
          }
        : {}),
    });
  }

  return {
    name: 'openai',
    model: config.openai.model,

    async json({ system, user, schema, maxTokens }) {
      const response = await send({ system, user, schema, maxTokens });
      const message = response.choices?.[0]?.message;
      if (message?.refusal) {
        throw new Error(`모델이 요청을 거부했습니다: ${message.refusal}`);
      }
      const text = message?.content ?? '';
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`모델이 JSON을 반환하지 않았습니다: ${text.slice(0, 200)}`);
      }
    },

    async text({ system, user, maxTokens }) {
      const response = await send({ system, user, maxTokens });
      return (response.choices?.[0]?.message?.content ?? '').trim();
    },
  };
}
