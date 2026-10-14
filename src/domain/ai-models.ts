// AI model registry. Owner and administrator add, edit, switch and remove providers and models, choose which model does which job.
// API keys are sealed (AES-GCM) before they reach the database and are never returned by any read; only the last four characters are shown.
import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan, can } from '../core/permissions.js';
import { audit } from '../core/audit.js';
import { badRequest, invalidState, notFound, staleVersion, AppError } from '../core/errors.js';
import { complete, checkBaseUrl, KINDS, type CallSpec, type FetchFn, type Kind, type Msg } from './llm.js';
import type { Provider } from './ai.js';

const ANY = { anySite: true } as const;
export const PURPOSES = ['assistant', 'reports'] as const;
export type Purpose = (typeof PURPOSES)[number];

// ── sealing ──
let SECRET = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.AI_KEY_SECRET ?? 'demo-only-secret-change-me';
export const setKeySecret = (s: string) => { SECRET = s; };
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function aesKey() { return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SECRET)), 'AES-GCM', false, ['encrypt', 'decrypt']); }
export async function seal(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(), new TextEncoder().encode(plain)));
  return b64(new Uint8Array([...iv, ...ct]));
}
export async function open(sealed: string): Promise<string> {
  const all = unb64(sealed);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await aesKey(), all.slice(12)));
}

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'provider';

// ── providers ──
export async function addProvider(ctx: Ctx, i: { name: string; kind: Kind; baseUrl?: string; apiKey?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'ai.manage', ANY);
  if (!i.name.trim()) throw badRequest('Give the provider a name');
  const k = KINDS.find((x) => x.kind === i.kind); if (!k) throw badRequest('Unknown provider type');
  const base = checkBaseUrl(i.baseUrl?.trim() || k.defaultBase || (() => { throw badRequest('Enter the address of the model service'); })());
  let slug = slugOf(i.name); const n = (await ctx.db.query(`SELECT count(*)::int AS n FROM ai_provider WHERE slug LIKE $1`, [slug + '%'])).rows[0].n; if (n) slug += '-' + (n + 1);
  const key = i.apiKey?.trim();
  const r = await ctx.db.query(`INSERT INTO ai_provider(slug,name,kind,base_url,api_key_sealed,key_last4,enabled,created_by) VALUES ($1,$2,$3,$4,$5,$6,false,$7) RETURNING id, slug, name, kind, base_url, enabled, version, key_last4`,
    [slug, i.name.trim(), i.kind, base, key ? await seal(key) : null, key ? key.slice(-4) : null, ctx.actor.id]);
  await audit(ctx, { action: 'ai.provider.add', entityType: 'ai_provider', entityId: r.rows[0].id, after: { ...r.rows[0], hasKey: !!key } });
  return r.rows[0];
}

export async function updateProvider(ctx: Ctx, i: { id: string; expectedVersion: number; name?: string; baseUrl?: string; apiKey?: string; clearKey?: boolean; enabled?: boolean }) {
  await assertCan(ctx.db, ctx.actor.id, 'ai.manage', ANY);
  const p = (await ctx.db.query('SELECT * FROM ai_provider WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
  if (!p) throw notFound('Provider');
  if (p.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, p.version);
  const base = i.baseUrl !== undefined ? checkBaseUrl(i.baseUrl.trim()) : p.base_url;
  let sealed = p.api_key_sealed, last4 = p.key_last4;
  if (i.clearKey) { sealed = null; last4 = null; }
  if (i.apiKey?.trim()) { sealed = await seal(i.apiKey.trim()); last4 = i.apiKey.trim().slice(-4); }
  const enabled = i.enabled ?? p.enabled;
  const isLocal = /^http:/.test(base);
  if (enabled && !sealed && !isLocal) throw invalidState('Add the API key before switching this provider on');
  const r = await ctx.db.query(`UPDATE ai_provider SET name=$2, base_url=$3, api_key_sealed=$4, key_last4=$5, enabled=$6, version=version+1 WHERE id=$1 RETURNING id, slug, name, kind, base_url, enabled, version, key_last4`,
    [i.id, i.name?.trim() || p.name, base, sealed, last4, enabled]);
  await audit(ctx, { action: 'ai.provider.update', entityType: 'ai_provider', entityId: i.id,
    before: { name: p.name, base_url: p.base_url, enabled: p.enabled, key: p.key_last4 ? '••••' + p.key_last4 : null }, after: { name: r.rows[0].name, base_url: base, enabled, key: last4 ? '••••' + last4 : null },
    reason: i.apiKey?.trim() ? 'API key replaced' : i.clearKey ? 'API key removed' : null });
  return r.rows[0];
}

export async function removeProvider(ctx: Ctx, i: { id: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'ai.manage', ANY);
  const p = (await ctx.db.query('SELECT * FROM ai_provider WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
  if (!p) throw notFound('Provider');
  const used = (await ctx.db.query(`SELECT a.purpose FROM ai_assignment a JOIN ai_model m ON m.id IN (a.model_id, a.fallback_id) WHERE m.provider_id=$1`, [i.id])).rows;
  if (used.length) throw invalidState(`Its models are still used for ${[...new Set(used.map((x) => x.purpose))].join(' and ')}. Choose other models there first`);
  await ctx.db.query('DELETE FROM ai_model WHERE provider_id=$1', [i.id]);
  await ctx.db.query('DELETE FROM ai_provider WHERE id=$1', [i.id]);
  await audit(ctx, { action: 'ai.provider.remove', entityType: 'ai_provider', entityId: i.id, before: { name: p.name, kind: p.kind } });
}

// ── models ──
export async function addModel(ctx: Ctx, i: { providerId: string; modelId: string; label?: string; maxTokens?: number; temperature?: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'ai.manage', ANY);
  if (!(await ctx.db.query('SELECT 1 FROM ai_provider WHERE id=$1', [i.providerId])).rowCount) throw notFound('Provider');
  const mid = i.modelId.trim(); if (!/^[A-Za-z0-9._:/-]{2,80}$/.test(mid)) throw badRequest('The model name has odd characters. Copy it from the provider\'s model list');
  if ((await ctx.db.query('SELECT 1 FROM ai_model WHERE provider_id=$1 AND model_id=$2', [i.providerId, mid])).rowCount) throw badRequest('That model is already listed for this provider');
  const r = await ctx.db.query(`INSERT INTO ai_model(provider_id,model_id,label,max_tokens,temperature) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [i.providerId, mid, i.label?.trim() || mid, i.maxTokens ?? 1024, i.temperature ?? 0.2]);
  await audit(ctx, { action: 'ai.model.add', entityType: 'ai_model', entityId: r.rows[0].id, after: r.rows[0] });
  return r.rows[0];
}
export async function updateModel(ctx: Ctx, i: { id: string; label?: string; modelId?: string; enabled?: boolean; maxTokens?: number; temperature?: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'ai.manage', ANY);
  const m = (await ctx.db.query('SELECT * FROM ai_model WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
  if (!m) throw notFound('Model');
  if (i.enabled === false && (await ctx.db.query('SELECT 1 FROM ai_assignment WHERE model_id=$1 OR fallback_id=$1', [i.id])).rowCount) throw invalidState('This model is in use. Choose another model for that job first');
  const r = await ctx.db.query(`UPDATE ai_model SET label=$2, model_id=$3, enabled=$4, max_tokens=$5, temperature=$6 WHERE id=$1 RETURNING *`,
    [i.id, i.label?.trim() || m.label, i.modelId?.trim() || m.model_id, i.enabled ?? m.enabled, i.maxTokens ?? m.max_tokens, i.temperature ?? m.temperature]);
  await audit(ctx, { action: 'ai.model.update', entityType: 'ai_model', entityId: i.id, before: m, after: r.rows[0] });
  return r.rows[0];
}
export async function removeModel(ctx: Ctx, i: { id: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'ai.manage', ANY);
  const m = (await ctx.db.query('SELECT * FROM ai_model WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
  if (!m) throw notFound('Model');
  if ((await ctx.db.query('SELECT 1 FROM ai_assignment WHERE model_id=$1 OR fallback_id=$1', [i.id])).rowCount) throw invalidState('This model is in use. Choose another model for that job first');
  await ctx.db.query('DELETE FROM ai_model WHERE id=$1', [i.id]);
  await audit(ctx, { action: 'ai.model.remove', entityType: 'ai_model', entityId: i.id, before: m });
}

/** Choose which model does a job. Passing null means "use the built-in reader". */
export async function assignModel(ctx: Ctx, i: { purpose: Purpose; modelId: string | null; fallbackId?: string | null }) {
  await assertCan(ctx.db, ctx.actor.id, 'ai.manage', ANY);
  if (!PURPOSES.includes(i.purpose)) throw badRequest('Unknown job');
  for (const id of [i.modelId, i.fallbackId ?? null]) if (id) {
    const m = (await ctx.db.query(`SELECT m.enabled, p.enabled AS pe, p.name FROM ai_model m JOIN ai_provider p ON p.id=m.provider_id WHERE m.id=$1`, [id])).rows[0];
    if (!m) throw notFound('Model');
    if (!m.enabled || !m.pe) throw invalidState(`Switch ${m.name} and the model on first`);
  }
  if (i.modelId && i.modelId === i.fallbackId) throw badRequest('The back-up model must be a different one');
  const before = (await ctx.db.query('SELECT * FROM ai_assignment WHERE purpose=$1', [i.purpose])).rows[0];
  await ctx.db.query('UPDATE ai_assignment SET model_id=$2, fallback_id=$3 WHERE purpose=$1', [i.purpose, i.modelId, i.modelId ? (i.fallbackId ?? null) : null]);
  await audit(ctx, { action: 'ai.assign', entityType: 'ai_assignment', before, after: { purpose: i.purpose, model_id: i.modelId, fallback_id: i.fallbackId ?? null } });
}

// ── reads (never include keys) ──
export async function overview(db: Db, userId: string) {
  if (!(await can(db, userId, 'ai.manage', ANY))) return null;
  const providers = (await db.query(`SELECT id, slug, name, kind, base_url, enabled, version, key_last4, (api_key_sealed IS NOT NULL) AS has_key FROM ai_provider ORDER BY created_at, name`)).rows;
  const models = (await db.query(`SELECT * FROM ai_model ORDER BY label`)).rows;
  const assignments = (await db.query(`SELECT * FROM ai_assignment`)).rows;
  return { providers: providers.map((p) => ({ ...p, models: models.filter((m) => m.provider_id === p.id) })), assignments, kinds: KINDS };
}
export async function recentCalls(db: Db, userId: string, limit = 15) {
  if (!(await can(db, userId, 'ai.manage', ANY))) return [];
  return (await db.query(`SELECT l.at, l.purpose, l.model, l.ok, l.ms, l.error, u.display_name AS who FROM ai_call_log l LEFT JOIN app_user u ON u.id=l.user_id ORDER BY l.id DESC LIMIT $1`, [limit])).rows;
}
/** What the assistant screen needs to know: is a model configured (no names or keys). */
export async function modelInUse(db: Db, purpose: Purpose): Promise<string | null> {
  const c = await candidates(db, purpose); return c.length ? c[0].label : null;
}

// ── calling ──
type Cand = CallSpec & { label: string; id: string };
async function candidates(db: Db, purpose: Purpose): Promise<Cand[]> {
  const rows = (await db.query(
    `SELECT m.id, m.model_id, m.label, m.max_tokens, m.temperature, p.kind, p.base_url, p.api_key_sealed, 0 AS ord FROM ai_assignment a JOIN ai_model m ON m.id=a.model_id JOIN ai_provider p ON p.id=m.provider_id WHERE a.purpose=$1 AND m.enabled AND p.enabled
     UNION ALL SELECT m.id, m.model_id, m.label, m.max_tokens, m.temperature, p.kind, p.base_url, p.api_key_sealed, 1 FROM ai_assignment a JOIN ai_model m ON m.id=a.fallback_id JOIN ai_provider p ON p.id=m.provider_id WHERE a.purpose=$1 AND m.enabled AND p.enabled ORDER BY ord`, [purpose])).rows;
  const out: Cand[] = [];
  for (const r of rows) out.push({ id: r.id, label: r.label, kind: r.kind, baseUrl: r.base_url, apiKey: r.api_key_sealed ? await open(r.api_key_sealed) : '', model: r.model_id, maxTokens: r.max_tokens, temperature: Number(r.temperature) });
  return out;
}
const log = (db: Db, userId: string | null, purpose: string, model: string | null, ok: boolean, ms: number, error?: string) =>
  db.query('INSERT INTO ai_call_log(user_id,purpose,model,ok,ms,error) VALUES ($1,$2,$3,$4,$5,$6)', [userId, purpose, model, ok, ms, error?.slice(0, 200) ?? null]);

export class NoModel extends AppError { constructor() { super(409, 'NO_MODEL', 'No AI model is switched on for this job'); } }
/** Try the chosen model, then the back-up. Throws NO_MODEL if none is configured. Only the text sent in `messages` leaves the system. */
export async function callAi(db: Db, userId: string, purpose: Purpose, system: string, messages: Msg[], f: FetchFn = (globalThis.fetch as unknown as FetchFn)): Promise<{ text: string; model: string }> {
  const c = await candidates(db, purpose);
  if (!c.length) throw new NoModel();
  let last = '';
  for (const m of c) {
    const t0 = Date.now();
    try { const text = await complete(m, system, messages, f); await log(db, userId, purpose, m.label, true, Date.now() - t0); return { text, model: m.label }; }
    catch (e) { last = (e as Error).message; await log(db, userId, purpose, m.label, false, Date.now() - t0, last); }
  }
  throw new AppError(502, 'AI_UNAVAILABLE', `The AI model could not be reached (${last})`);
}

export async function testModel(db: Db, userId: string, modelId: string, f: FetchFn = (globalThis.fetch as unknown as FetchFn)): Promise<{ ok: boolean; ms: number; error?: string; reply?: string }> {
  if (!(await can(db, userId, 'ai.manage', ANY))) throw new AppError(403, 'FORBIDDEN', 'Only the owner or administrator can test models');
  const r = (await db.query(`SELECT m.model_id, m.label, m.max_tokens, m.temperature, p.kind, p.base_url, p.api_key_sealed FROM ai_model m JOIN ai_provider p ON p.id=m.provider_id WHERE m.id=$1`, [modelId])).rows[0];
  if (!r) throw notFound('Model');
  const t0 = Date.now();
  try {
    const text = await complete({ kind: r.kind, baseUrl: r.base_url, apiKey: r.api_key_sealed ? await open(r.api_key_sealed) : '', model: r.model_id, maxTokens: 32, temperature: 0 }, 'Reply with the single word OK.', [{ role: 'user', content: 'Test' }], f, 20000);
    await log(db, userId, 'test', r.label, true, Date.now() - t0); return { ok: true, ms: Date.now() - t0, reply: text.slice(0, 40) };
  } catch (e) { const msg = (e as Error).message; await log(db, userId, 'test', r.label, false, Date.now() - t0, msg); return { ok: false, ms: Date.now() - t0, error: msg }; }
}

/** A Provider for the report assistant, or undefined when no model is assigned (the built-in reader is used). */
export async function reportsProvider(db: Db, userId: string, f?: FetchFn): Promise<Provider | undefined> {
  if (!(await candidates(db, 'reports')).length) return undefined;
  return async (system, user) => (await callAi(db, userId, 'reports', system, [{ role: 'user', content: user }], f)).text;
}
