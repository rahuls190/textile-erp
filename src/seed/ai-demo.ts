import type { World } from './demo.js';
import * as ai from '../domain/ai-models.js';

/** Providers and model names to start from. They are switched off with no key; the owner or administrator adds a key and switches them on. Check model names against the provider's own list. */
export async function seedAiDemo(w: World) {
  const set: [string, 'anthropic' | 'openai' | 'google', [string, string][]][] = [
    ['Anthropic', 'anthropic', [['claude-sonnet-5-5', 'Claude Sonnet'], ['claude-haiku-5-5', 'Claude Haiku (fast)'], ['claude-opus-5-5', 'Claude Opus (strongest)']]],
    ['OpenAI', 'openai', [['gpt-4o', 'GPT-4o'], ['gpt-4o-mini', 'GPT-4o mini (fast)']]],
    ['Google', 'google', [['gemini-2.0-flash', 'Gemini Flash (fast)']]],
  ];
  for (const [name, kind, models] of set) {
    const p = await w.as('admin', (c) => ai.addProvider(c, { name, kind }));
    for (const [id, label] of models) await w.as('admin', (c) => ai.addModel(c, { providerId: p.id, modelId: id, label }));
  }
}
