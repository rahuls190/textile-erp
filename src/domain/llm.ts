// Provider adapters: one function turns (system, messages) into text for Anthropic, OpenAI, Google Gemini, or any OpenAI-compatible endpoint.
import { badRequest } from '../core/errors.js';

export type Kind = 'anthropic' | 'openai' | 'google' | 'openai_compatible';
export type Msg = { role: 'user' | 'assistant'; content: string };
export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
export const KINDS: { kind: Kind; label: string; defaultBase: string }[] = [
  { kind: 'anthropic', label: 'Anthropic (Claude)', defaultBase: 'https://api.anthropic.com' },
  { kind: 'openai', label: 'OpenAI', defaultBase: 'https://api.openai.com/v1' },
  { kind: 'google', label: 'Google (Gemini)', defaultBase: 'https://generativelanguage.googleapis.com' },
  { kind: 'openai_compatible', label: 'Other (OpenAI-compatible, e.g. a local model)', defaultBase: '' },
];

/** Only https, or http to this machine / a private network (a local model). Anything else is refused. */
export function checkBaseUrl(u: string): string {
  let url: URL;
  try { url = new URL(u); } catch { throw badRequest('That web address is not valid'); }
  const host = url.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw badRequest('Use an https address (plain http is only allowed for a model on this machine or your own network)');
  if (url.username || url.password) throw badRequest('Do not put a password in the address');
  return u.replace(/\/+$/, '');
}

export interface CallSpec { kind: Kind; baseUrl: string; apiKey: string; model: string; maxTokens: number; temperature: number }

export async function complete(spec: CallSpec, system: string, messages: Msg[], f: FetchFn, timeoutMs = 45000): Promise<string> {
  const base = spec.baseUrl.replace(/\/+$/, '');
  let url: string; let headers: Record<string, string> = { 'content-type': 'application/json' }; let body: unknown;
  if (spec.kind === 'anthropic') {
    url = `${base}/v1/messages`; headers = { ...headers, 'x-api-key': spec.apiKey, 'anthropic-version': '2023-06-01' };
    body = { model: spec.model, max_tokens: spec.maxTokens, temperature: spec.temperature, system, messages };
  } else if (spec.kind === 'google') {
    url = `${base}/v1beta/models/${encodeURIComponent(spec.model)}:generateContent`; headers = { ...headers, 'x-goog-api-key': spec.apiKey };
    body = { systemInstruction: { parts: [{ text: system }] }, contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig: { maxOutputTokens: spec.maxTokens, temperature: spec.temperature } };
  } else {
    url = `${base}/chat/completions`; headers = { ...headers, authorization: `Bearer ${spec.apiKey}` };
    body = { model: spec.model, max_tokens: spec.maxTokens, temperature: spec.temperature, messages: [{ role: 'system', content: system }, ...messages] };
  }
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) throw new Error(`The AI service answered ${res.status}`);
    const j = (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const text = spec.kind === 'anthropic' ? (j.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('')
      : spec.kind === 'google' ? (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('')
      : (j.choices?.[0]?.message?.content ?? '');
    if (!String(text).trim()) throw new Error('The AI service returned an empty answer');
    return String(text);
  } catch (e) {
    const err = e as Error; throw new Error(err.name === 'AbortError' ? 'The AI service took too long' : err.message);
  } finally { clearTimeout(timer); }
}
