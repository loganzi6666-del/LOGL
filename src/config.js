import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: int(process.env.PORT, 5173),
  savesDir: path.join(ROOT, 'saves'),

  provider: (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase(),
  language: process.env.GAME_LANGUAGE ?? 'ko',

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? null,
    model: process.env.OPENAI_MODEL ?? 'gpt-4.1',
  },

  /** How many AI nations get a full language-model turn. The rest use rules. */
  thinkingNations: int(process.env.AI_THINKING_NATIONS, 10),
  /** Parallel LLM calls. Raise it if your rate limit allows. */
  concurrency: int(process.env.AI_CONCURRENCY, 4),
};

export function hasCredentials() {
  return config.provider === 'openai'
    ? Boolean(config.openai.apiKey)
    : Boolean(config.anthropic.apiKey);
}

export function ensureSavesDir() {
  fs.mkdirSync(config.savesDir, { recursive: true });
  return config.savesDir;
}
