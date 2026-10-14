import { html, chip, when, type Raw } from './lib.js';
import { uid, read, val, act, head, denied, R, opts, toast, K, S } from './ctx.js';
import * as aim from '../src/domain/ai-models.js';
import { KINDS } from '../src/domain/llm.js';

const open = new Set<string>();
const st = { newKind: 'anthropic', test: {} as Record<string, string> };
const toggle = (k: string) => (open.has(k) ? open.delete(k) : open.add(k));
const verOf = (id: string) => read(async (db) => (await db.query('SELECT version FROM ai_provider WHERE id=$1', [id])).rows[0].version as number);
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.kind, k.label]));

export async function aiView(): Promise<Raw> {
  const d = await read(async (db) => ({ ov: await aim.overview(db, uid()), calls: await aim.recentCalls(db, uid(), 12) }));
  if (!d.ov) return denied('AI models', 'Connect AI services.', 'Only the owner or the administrator can manage AI models.');
  const { providers, assignments } = d.ov;
  const allModels = providers.flatMap((p) => p.models.map((m: { id: string; label: string; enabled: boolean }) => ({ ...m, provider: p.name, on: p.enabled && m.enabled })));
  const usable = allModels.filter((m) => m.on);
  const A = (purpose: string) => assignments.find((a: { purpose: string }) => a.purpose === purpose) ?? { model_id: null, fallback_id: null };
  const nameOf = (id: string | null) => { const m = allModels.find((x) => x.id === id); return m ? `${m.label} (${m.provider})` : null; };
  const kindHint = KINDS.find((k) => k.kind === st.newKind)!;
  const job = (purpose: string, title: string, what: string) => { const a = A(purpose); return html`<form class="card form job" data-form="ai-assign" data-purpose="${purpose}"><h3>${title}</h3><p class="sub">${what}</p>
    <div class="grid2"><label>Main model<select id="as-${purpose}-m">${opts(usable.map((m) => ({ id: m.id, label: `${m.label} · ${m.provider}` })), a.model_id ?? '', 'Built-in (no AI model)')}</select></label>
    <label>Back-up if it fails<select id="as-${purpose}-f">${opts(usable.map((m) => ({ id: m.id, label: `${m.label} · ${m.provider}` })), a.fallback_id ?? '', 'None')}</select></label></div>
    <div class="row"><button class="primary" type="submit">Save</button><small class="sub">Now: ${nameOf(a.model_id) ?? 'built-in'}${a.fallback_id ? ', then ' + nameOf(a.fallback_id) : ''}</small></div></form>`; };
  return html`${head('AI models', 'Connect one or more AI services and choose which one does which job. Owner and administrator only.', html`<button class="primary" data-act="ai-new">Add provider</button>`)}
  <section class="card note-card"><p><b>How it works.</b> The assistant and the report helper use the model you choose. When none is chosen, or it cannot be reached, they use the built-in reader, so they never stop working. Only the question you type is sent out, never your business data, except the figures the assistant reads back to answer you. Keys are sealed when saved and are never shown again; only the last four characters appear here.</p>
  <p class="sub">This browser demo cannot reach outside services, so “Test” will fail here. On the server version it works.</p></section>
  <section class="two">${job('assistant', 'Assistant', 'Answers questions, finds things and prepares changes for the person to confirm. Works by voice or typing.')}${job('reports', 'Report helper', 'Turns a plain-words request into a report. Allowed datasets only, never free-form database access.')}</section>
  ${open.has('newprov') ? html`<form class="card form" data-form="ai-addprov"><h2>Add provider</h2><div class="grid2"><label>Type<select id="ap-kind">${opts(KINDS.map((k) => ({ id: k.kind, label: k.label })), st.newKind)}</select></label><label>Name<input id="ap-name" required placeholder="e.g. Anthropic" /></label>
    <label>Web address <small>${kindHint.defaultBase ? 'leave blank for ' + kindHint.defaultBase : 'required'}</small><input id="ap-url" placeholder="${kindHint.defaultBase || 'https://… or http://localhost:11434/v1'}" /></label><label>API key<input id="ap-key" type="password" autocomplete="off" /></label></div>
    <div class="row"><button class="primary" type="submit">Add</button><button type="button" data-act="ai-new">Cancel</button></div></form>` : ''}
  ${providers.length ? providers.map((p) => html`<section class="card prov"><div class="provhead"><h2>${p.name}</h2><span class="chip neutral">${KIND_LABEL[p.kind]}</span>${p.enabled ? chip('active', 'On') : chip('draft', 'Off')}<span class="grow"></span>
      <button data-act="ai-pedit" data-id="${p.id}">Edit</button><button data-act="ai-ptoggle" data-id="${p.id}">${p.enabled ? 'Switch off' : 'Switch on'}</button><button class="danger" data-act="ai-prem" data-id="${p.id}">${open.has('rm:' + p.id) ? 'Sure? Remove it' : 'Remove'}</button></div>
    <p class="sub">${p.has_key ? 'Key ••••' + p.key_last4 : 'No key yet'} · ${p.base_url}</p>
    ${open.has('pe:' + p.id) ? html`<form class="form" data-form="ai-editprov" data-id="${p.id}"><div class="grid2"><label>Name<input id="pe-name" value="${p.name}" /></label><label>Web address<input id="pe-url" value="${p.base_url}" /></label><label>New key <small>(blank keeps the current one)</small><input id="pe-key" type="password" autocomplete="off" /></label></div>
      <div class="row"><button class="primary" type="submit">Save</button>${p.has_key ? html`<button type="button" data-act="ai-pkeyoff" data-id="${p.id}">Remove the key</button>` : ''}<button type="button" data-act="ai-pedit" data-id="${p.id}">Cancel</button></div></form>` : ''}
    <div class="scroll"><table class="mini"><thead><tr><th>Model</th><th>Name used by the provider</th><th class="r">Max reply</th><th>State</th><th></th></tr></thead><tbody>${p.models.map((m: { id: string; label: string; model_id: string; max_tokens: number; enabled: boolean }) => html`<tr><td>${m.label}</td><td><code>${m.model_id}</code></td><td class="r">${m.max_tokens}</td><td>${m.enabled ? chip('active', 'On') : chip('draft', 'Off')}${st.test[m.id] ? html`<br><small>${st.test[m.id]}</small>` : ''}</td>
      <td class="r nowrap"><button class="sm" data-act="ai-mtest" data-id="${m.id}">Test</button> <button class="sm" data-act="ai-medit" data-id="${m.id}">Edit</button> <button class="sm" data-act="ai-mtoggle" data-id="${m.id}">${m.enabled ? 'Off' : 'On'}</button> <button class="sm danger" data-act="ai-mrem" data-id="${m.id}">${open.has('mrm:' + m.id) ? 'Sure?' : 'Remove'}</button></td></tr>
      ${open.has('me:' + m.id) ? html`<tr><td colspan="5"><form class="row" data-form="ai-editmodel" data-id="${m.id}"><input id="me-label" value="${m.label}" aria-label="Name shown" /><input id="me-mid" value="${m.model_id}" aria-label="Model name" /><input id="me-tok" value="${m.max_tokens}" inputmode="numeric" style="max-width:90px" aria-label="Max reply" /><button class="primary" type="submit">Save</button></form></td></tr>` : ''}`)}</tbody></table></div>
    <form class="row" data-form="ai-addmodel" data-id="${p.id}"><input id="am-mid-${p.id}" placeholder="Model name from ${p.name}'s list" required /><input id="am-label-${p.id}" placeholder="Name to show (optional)" /><button type="submit">Add model</button></form></section>`) : html`<section class="card"><p class="empty">No provider yet. Add one to start.</p></section>`}
  <section class="card"><h2>Recent calls</h2>${d.calls.length ? html`<div class="scroll"><table class="mini"><thead><tr><th>When</th><th>Job</th><th>Model</th><th>Who</th><th class="r">Time</th><th>Result</th></tr></thead><tbody>${d.calls.map((c: { at: string; purpose: string; model: string | null; who: string | null; ms: number; ok: boolean; error: string | null }) => html`<tr><td>${when(c.at)}</td><td>${c.purpose}</td><td>${c.model ?? ''}</td><td>${c.who ?? ''}</td><td class="r">${c.ms} ms</td><td>${c.ok ? chip('accepted', 'ok') : html`<span class="chip bad" title="${c.error ?? ''}">failed</span>`}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">Nothing yet.</p>`}</section>`;
}

export async function onClick(t: HTMLElement): Promise<boolean> {
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b) return false;
  const a = b.dataset.act!, id = b.dataset.id ?? ''; const done = async () => { await R.render(); return true; };
  switch (a) {
    case 'ai-new': toggle('newprov'); return done();
    case 'ai-pedit': toggle('pe:' + id); return done();
    case 'ai-ptoggle': { const v = await verOf(id); const on = (await read(async (db) => (await db.query('SELECT enabled FROM ai_provider WHERE id=$1', [id])).rows[0].enabled)) as boolean; await act(on ? 'Provider switched off' : 'Provider switched on', (c) => aim.updateProvider(c, { id, expectedVersion: v, enabled: !on })); return true; }
    case 'ai-pkeyoff': { const v = await verOf(id); await act('Key removed', (c) => aim.updateProvider(c, { id, expectedVersion: v, clearKey: true, enabled: false })); return true; }
    case 'ai-prem': if (!open.has('rm:' + id)) { open.add('rm:' + id); return done(); } open.delete('rm:' + id); await act('Provider removed', (c) => aim.removeProvider(c, { id })); return true;
    case 'ai-mtoggle': { const on = (await read(async (db) => (await db.query('SELECT enabled FROM ai_model WHERE id=$1', [id])).rows[0].enabled)) as boolean; await act(on ? 'Model switched off' : 'Model switched on', (c) => aim.updateModel(c, { id, enabled: !on })); return true; }
    case 'ai-medit': toggle('me:' + id); return done();
    case 'ai-mrem': if (!open.has('mrm:' + id)) { open.add('mrm:' + id); return done(); } open.delete('mrm:' + id); await act('Model removed', (c) => aim.removeModel(c, { id })); return true;
    case 'ai-mtest': {
      st.test[id] = 'Testing…'; await R.render();
      const r = await read((db) => aim.testModel(db, uid(), id));
      st.test[id] = r.ok ? `Works · ${r.ms} ms` : /fetch|network|load failed/i.test(r.error ?? '') ? 'Could not reach it from this browser demo. Try it on the server.' : (r.error ?? 'Failed');
      toast(r.ok ? 'The model answered' : 'The model could not be reached', r.ok ? 'ok' : 'bad'); await R.render(); return true;
    }
  }
  return false;
}

export async function onSubmit(form: string, f?: HTMLElement): Promise<boolean> {
  const id = f?.dataset.id ?? '';
  switch (form) {
    case 'ai-addprov': { const r = await act('Provider added. Add its key and switch it on', (c) => aim.addProvider(c, { name: val('ap-name'), kind: val('ap-kind') as never, baseUrl: val('ap-url') || undefined, apiKey: val('ap-key') || undefined })); if (r) { open.delete('newprov'); await R.render(); } return true; }
    case 'ai-editprov': { const v = await verOf(id); const key = val('pe-key'); const r = await act('Saved', (c) => aim.updateProvider(c, { id, expectedVersion: v, name: val('pe-name'), baseUrl: val('pe-url'), apiKey: key || undefined })); if (r) { open.delete('pe:' + id); await R.render(); } return true; }
    case 'ai-addmodel': { const r = await act('Model added', (c) => aim.addModel(c, { providerId: id, modelId: val('am-mid-' + id), label: val('am-label-' + id) || undefined })); if (r) await R.render(); return true; }
    case 'ai-editmodel': { const r = await act('Saved', (c) => aim.updateModel(c, { id, label: val('me-label'), modelId: val('me-mid'), maxTokens: Number(val('me-tok')) || undefined })); if (r) { open.delete('me:' + id); await R.render(); } return true; }
    case 'ai-assign': { const p = f!.dataset.purpose as 'assistant' | 'reports'; await act(`${p === 'assistant' ? 'Assistant' : 'Report helper'} saved`, (c) => aim.assignModel(c, { purpose: p, modelId: val(`as-${p}-m`) || null, fallbackId: val(`as-${p}-f`) || null })); return true; }
  }
  return false;
}
export async function onChange(t: HTMLInputElement): Promise<boolean> {
  if (t.id === 'ap-kind') { st.newKind = t.value; await R.render(); return true; }
  return false;
}
void K; void S;
