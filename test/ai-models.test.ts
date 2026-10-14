import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as ai from '../src/domain/ai-models.js';
import { complete, checkBaseUrl, type FetchFn } from '../src/domain/llm.js';
import { seedAiDemo } from '../src/seed/ai-demo.js';

async function rejects(p: Promise<unknown>, part: string) {
  try { await p; } catch (e) { const err = e as { code?: string; message?: string }; if (err.code === part || (err.message ?? '').toLowerCase().includes(part.toLowerCase())) return; throw new Error(`Expected "${part}" but got ${err.code}: ${err.message}`); }
  throw new Error(`Expected refusal "${part}"`);
}
let w: World; const uid = (u: string) => w.actors[u].id;
beforeAll(async () => { w = await freshWorld('aimodels'); await seedAiDemo(w); });
afterAll(async () => { await w.pool.end(); });
const prov = async (name: string) => (await w.pool.query('SELECT * FROM ai_provider WHERE name=$1', [name])).rows[0];
const model = async (mid: string) => (await w.pool.query('SELECT * FROM ai_model WHERE model_id=$1', [mid])).rows[0];
const ok = (body: unknown): FetchFn => async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

describe('who can manage', () => {
  it('only owner and administrator; others see nothing', async () => {
    expect(await ai.overview(w.pool, uid('admin'))).not.toBeNull();
    expect(await ai.overview(w.pool, uid('buy'))).toBeNull();
    await rejects(w.as('buy', (c) => ai.addProvider(c, { name: 'X', kind: 'openai' })), 'FORBIDDEN');
    await rejects(w.as('com', (c) => ai.assignModel(c, { purpose: 'assistant', modelId: null })), 'FORBIDDEN');
    const o = await w.addUser('own2', 'OWN', { siteId: null }); expect(await ai.overview(w.pool, o.id)).not.toBeNull();
  });
});

describe('providers and keys', () => {
  it('seals the key, shows only the last four, never returns it, keeps it out of the audit', async () => {
    const p = await prov('OpenAI');
    const r = await w.as('admin', (c) => ai.updateProvider(c, { id: p.id, expectedVersion: p.version, apiKey: 'sk-test-SECRET-1234', enabled: true }));
    expect(r.key_last4).toBe('1234'); expect(r.enabled).toBe(true);
    const raw = (await w.pool.query('SELECT api_key_sealed FROM ai_provider WHERE id=$1', [p.id])).rows[0].api_key_sealed;
    expect(raw).not.toContain('SECRET'); expect(await ai.open(raw)).toBe('sk-test-SECRET-1234');
    const ov = await ai.overview(w.pool, uid('admin')); expect(JSON.stringify(ov)).not.toContain('SECRET'); expect(JSON.stringify(ov)).not.toContain(raw);
    const a = (await w.pool.query(`SELECT before, after, reason FROM audit_log WHERE action='ai.provider.update' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(JSON.stringify(a)).not.toContain('SECRET'); expect(a.reason).toBe('API key replaced');
  });
  it('cannot be switched on without a key; stale edits refused; bad addresses refused', async () => {
    const g = await prov('Google');
    await rejects(w.as('admin', (c) => ai.updateProvider(c, { id: g.id, expectedVersion: g.version, enabled: true })), 'API key');
    await rejects(w.as('admin', (c) => ai.updateProvider(c, { id: g.id, expectedVersion: 99, name: 'x' })), 'STALE_VERSION');
    await rejects(w.as('admin', (c) => ai.addProvider(c, { name: 'Odd', kind: 'openai_compatible', baseUrl: 'http://example.com/v1' })), 'https');
    expect(() => checkBaseUrl('http://localhost:11434/v1')).not.toThrow(); expect(() => checkBaseUrl('https://u:p@x.com')).toThrow();
    const local = await w.as('admin', (c) => ai.addProvider(c, { name: 'Local model', kind: 'openai_compatible', baseUrl: 'http://localhost:11434/v1' }));
    expect(local.slug).toBe('local-model');
  });
  it('models: add, edit, duplicate refused, change which job uses which, remove only when unused', async () => {
    const o = await prov('OpenAI'); const m = await model('gpt-4o'); const mini = await model('gpt-4o-mini');
    await rejects(w.as('admin', (c) => ai.addModel(c, { providerId: o.id, modelId: 'gpt-4o' })), 'already listed');
    await w.as('admin', (c) => ai.updateModel(c, { id: m.id, label: 'GPT-4o (main)', maxTokens: 2000 }));
    await w.as('admin', (c) => ai.assignModel(c, { purpose: 'assistant', modelId: m.id, fallbackId: mini.id }));
    await rejects(w.as('admin', (c) => ai.removeModel(c, { id: m.id })), 'in use');
    await rejects(w.as('admin', (c) => ai.updateModel(c, { id: m.id, enabled: false })), 'in use');
    await rejects(w.as('admin', (c) => ai.removeProvider(c, { id: o.id })), 'still used');
    const an = await model('claude-haiku-5-5');
    await rejects(w.as('admin', (c) => ai.assignModel(c, { purpose: 'reports', modelId: an.id })), 'Switch');
    await w.as('admin', (c) => ai.assignModel(c, { purpose: 'assistant', modelId: null }));
    await w.as('admin', (c) => ai.removeModel(c, { id: m.id }));
    expect((await w.pool.query('SELECT 1 FROM ai_model WHERE id=$1', [m.id])).rowCount).toBe(0);
  });
  it('removing a provider removes its models; the call log is append-only', async () => {
    const g = await prov('Google'); await w.as('admin', (c) => ai.removeProvider(c, { id: g.id }));
    expect((await w.pool.query(`SELECT 1 FROM ai_model WHERE model_id='gemini-2.0-flash'`)).rowCount).toBe(0);
    await ai.testModel(w.pool, uid('admin'), (await model('gpt-4o-mini')).id, ok({ choices: [{ message: { content: 'OK' } }] }));
    await expect(w.pool.query(`DELETE FROM ai_call_log`)).rejects.toThrow();
  });
});

describe('calling models', () => {
  const spec = (kind: 'anthropic' | 'openai' | 'google' | 'openai_compatible') => ({ kind, baseUrl: 'https://x.test', apiKey: 'K', model: 'm', maxTokens: 50, temperature: 0 });
  it('builds the right request and reads the right answer for each provider', async () => {
    let seen: { url: string; headers: Record<string, string>; body: any } | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    const spy = (resp: unknown): FetchFn => async (url, init) => { seen = { url, headers: init.headers, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => resp, text: async () => '' }; };
    expect(await complete(spec('anthropic'), 'sys', [{ role: 'user', content: 'hi' }], spy({ content: [{ type: 'text', text: 'A' }] }))).toBe('A');
    expect(seen!.url).toBe('https://x.test/v1/messages'); expect(seen!.headers['x-api-key']).toBe('K'); expect(seen!.body.system).toBe('sys');
    expect(await complete(spec('openai'), 'sys', [{ role: 'user', content: 'hi' }], spy({ choices: [{ message: { content: 'B' } }] }))).toBe('B');
    expect(seen!.url).toBe('https://x.test/chat/completions'); expect(seen!.headers.authorization).toBe('Bearer K'); expect(seen!.body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(await complete(spec('google'), 'sys', [{ role: 'assistant', content: 'x' }], spy({ candidates: [{ content: { parts: [{ text: 'C' }] } }] }))).toBe('C');
    expect(seen!.url).toContain(':generateContent'); expect(seen!.headers['x-goog-api-key']).toBe('K'); expect(seen!.url).not.toContain('K');
    await expect(complete(spec('openai_compatible'), 's', [], async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' }))).rejects.toThrow('401');
  });
  it('uses the back-up model when the first fails, logs both, and reports NO_MODEL when nothing is set', async () => {
    await w.as('admin', (c) => ai.assignModel(c, { purpose: 'assistant', modelId: null }));
    await rejects(ai.callAi(w.pool, uid('buy'), 'assistant', 's', [{ role: 'user', content: 'x' }]), 'NO_MODEL');
    const an = await prov('Anthropic'); await w.as('admin', (c) => ai.updateProvider(c, { id: an.id, expectedVersion: an.version, apiKey: 'ak-1111', enabled: true }));
    const oi = await prov('OpenAI'); const mini = await model('gpt-4o-mini'); const son = await model('claude-sonnet-5-5');
    await w.as('admin', (c) => ai.assignModel(c, { purpose: 'assistant', modelId: son.id, fallbackId: mini.id }));
    const f: FetchFn = async (url) => url.includes('anthropic') ? { ok: false, status: 500, json: async () => ({}), text: async () => '' } : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'from backup' } }] }), text: async () => '' };
    const r = await ai.callAi(w.pool, uid('buy'), 'assistant', 's', [{ role: 'user', content: 'x' }], f);
    expect(r.text).toBe('from backup'); expect(r.model).toContain('mini');
    const log = await ai.recentCalls(w.pool, uid('admin'), 5); expect(log.some((l) => !l.ok) && log.some((l) => l.ok)).toBe(true);
    expect(await ai.recentCalls(w.pool, uid('buy'))).toEqual([]);
    void oi;
  });
});
