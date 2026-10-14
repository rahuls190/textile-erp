import { html, raw, money, qty, when, chip, dateOnly, esc, type Raw } from './lib.js';
import { S, uid, read, val, act, head, denied, R, opts, toast, todayIso } from './ctx.js';
import * as md from '../src/domain/master-data.js';
import * as masters from '../src/domain/masters.js';
import * as admin from '../src/domain/admin.js';
import { can } from '../src/core/permissions.js';

const ANY = { anySite: true } as const;
const st = {
  matQ: '', matType: '', matStatus: '', mat: '', newType: '', draft: {} as Record<string, string>, typ: '', unitForm: false,
  q: { vendor: '', customer: '' } as Record<string, string>, stat: { vendor: '', customer: '' } as Record<string, string>, sel: { vendor: '', customer: '' } as Record<string, string>,
  importRes: null as null | { created: number; errors: { row: number; message: string }[]; dryRun: boolean; what: string },
};
const open = new Set<string>();
const toggle = (k: string) => (open.has(k) ? open.delete(k) : open.add(k));
const verOf = (table: string, id: string) => read(async (db) => (await db.query(`SELECT version FROM ${table} WHERE id=$1`, [id])).rows[0].version as number);
const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
const STATE_TONE: Record<string, string> = { draft: 'neutral', verification: 'warn', active: 'ok', suspended: 'bad', inactive: 'neutral', submitted: 'warn' };
const sChip = (s: string, label?: string) => html`<span class="chip ${STATE_TONE[s] ?? 'neutral'}">${label ?? (s === 'verification' ? 'waiting for checks' : s === 'submitted' ? 'waiting for approval' : s)}</span>`;
const KIND_LABEL: Record<string, string> = { FABRIC: 'Fabric', TRIM: 'Trims', CUP: 'Cups', PACKING: 'Packing', PROCESS: 'Process', WIP: 'Work in progress', FG: 'Finished goods' };
const INDIAN_STATES = md.INDIAN_STATES;
type Addr = { id?: string; kind?: string; label?: string | null; line1?: string; line2?: string | null; city?: string | null; state?: string | null; pincode?: string | null; contact_name?: string | null; phone?: string | null; gstin?: string | null; is_default?: boolean };
const addrFields = (pre: string, a: Addr = {}) => html`<div class="grid2"><label>Label <small>(optional)</small><input id="${pre}label" value="${a.label ?? ''}" placeholder="Head office, Godown…" /></label><label>Address line 1<input id="${pre}line" value="${a.line1 ?? ''}" /></label><label>Address line 2<input id="${pre}line2" value="${a.line2 ?? ''}" /></label><label>City<input id="${pre}city" value="${a.city ?? ''}" /></label><label>State<select id="${pre}state">${opts(INDIAN_STATES.map((x) => ({ id: x, label: x })), a.state ?? '', 'Choose…')}</select></label><label>Pincode<input id="${pre}pin" inputmode="numeric" maxlength="6" value="${a.pincode ?? ''}" /></label><label>Contact at this address<input id="${pre}cname" value="${a.contact_name ?? ''}" /></label><label>Phone<input id="${pre}phone" inputmode="tel" value="${a.phone ?? ''}" /></label><label>GSTIN <small>(if different)</small><input id="${pre}gstin" value="${a.gstin ?? ''}" /></label></div>`;
const readAddr = (pre: string) => ({ label: val(pre + 'label') || undefined, line1: val(pre + 'line'), line2: val(pre + 'line2') || undefined, city: val(pre + 'city') || undefined, state: val(pre + 'state') || undefined, pincode: val(pre + 'pin') || undefined, contactName: val(pre + 'cname') || undefined, phone: val(pre + 'phone') || undefined, gstin: val(pre + 'gstin') || undefined });

/** Remember what was typed in an open form before the page redraws (e.g. when a dropdown changes the form). */
function capture(formSel: string) { document.querySelectorAll(`${formSel} input, ${formSel} select, ${formSel} textarea`).forEach((e) => { const i = e as HTMLInputElement; if (i.id) st.draft[i.id] = i.value; }); }
const dv = (id: string, d = '') => st.draft[id] ?? d;

function importBox(kind: 'materials' | 'parties', sample: string, header: string): Raw {
  const r = st.importRes?.what === kind ? st.importRes : null;
  return html`<form class="card form" data-form="import-${kind}"><h2>Bulk add</h2>
    <p class="sub">Paste rows from a spreadsheet, first line is the column names. Every row is checked; nothing is saved unless all rows are good.</p>
    <label>Columns: <code>${header}</code><textarea id="imp-text" rows="6" placeholder="${sample}">${st.draft['imp-text'] ?? ''}</textarea></label>
    <div class="row"><button type="submit" data-check="1">Check only</button><button class="primary" type="submit">Add all rows</button><button type="button" data-act="mx-import-close">Close</button></div>
    ${r ? (r.errors.length ? html`<div class="note bad-t"><b>${r.errors.length} row${r.errors.length > 1 ? 's' : ''} need fixing. Nothing was saved.</b><ul>${r.errors.map((e) => html`<li>Row ${e.row}: ${e.message}</li>`)}</ul></div>` : html`<p class="note">${r.dryRun ? `All ${r.created} rows look good. Press “Add all rows” to save them.` : `${r.created} rows added.`}</p>`) : ''}</form>`;
}

// ───────────────────────── Materials ─────────────────────────
export async function materialsView(): Promise<Raw> {
  const d = await read(async (db) => {
    const types = await md.listMaterialTypes(db, uid());
    const all = await md.listMaterials(db, uid());
    const list = await md.listMaterials(db, uid(), { q: st.matQ, typeId: st.matType, status: st.matStatus });
    const sel = st.mat ? await md.getMaterial(db, uid(), st.mat).catch(() => null) : null;
    const c = (p: string) => can(db, uid(), p, ANY);
    return { types, all, list, sel, units: await md.listUnits(db), create: await c('item.create'), edit: await c('item.edit'), submit: await c('item.submit'), approve: await c('item.approve'), deact: await c('item.deactivate') };
  });
  if (!d.types.length && !d.all.length) return denied('Materials', 'Everything you buy, make or sell.', 'Your role cannot see the materials list.');
  const low = d.all.filter((m) => m.status === 'active' && m.reorder_level && Number(m.on_hand) < Number(m.reorder_level));
  const waiting = d.all.filter((m) => ['draft', 'submitted'].includes(m.status));
  const byType = d.types.filter((t) => t.items > 0);
  const maxN = Math.max(...byType.map((t) => t.items), 1);
  const s = d.sel; const it = s?.item;
  const nt = d.types.find((t) => t.id === st.newType);
  const mine = it && it.created_by === uid();
  const fld = (a: md.AttrDef, cur: unknown, p: string) => html`<label>${a.label}${a.unit ? html` <small>(${a.unit})</small>` : ''}${a.required ? html` <small>required</small>` : ''}<input id="${p}${a.key}" ${a.type === 'number' ? raw('inputmode="decimal"') : ''} value="${cur ?? ''}" /></label>`;
  return html`${head('Materials', 'Everything you buy, make or sell. Each belongs to a type, so nothing is described twice.', d.create ? html`<div class="row"><button class="primary" data-act="mat-new">New material</button><button data-act="mx-import-materials">Bulk add</button></div>` : undefined)}
  <section class="card crm-sum"><div class="crm-k"><span>Materials</span><b>${d.all.length}</b></div><div class="crm-k"><span>In use</span><b>${d.all.filter((m) => m.status === 'active').length}</b></div>
    <div class="crm-k"><span>Waiting for approval</span><b class="${waiting.length ? 'warn-t' : ''}">${waiting.length}</b></div><div class="crm-k"><span>Below reorder level</span><b class="${low.length ? 'bad-t' : ''}">${low.length}</b></div></section>
  ${byType.length ? html`<section class="card"><h2>By type</h2><div class="tbars">${byType.map((t) => html`<button class="tbar ${st.matType === t.id ? 'on' : ''}" data-act="mat-typefilter" data-id="${t.id}" title="Show only ${t.name}"><span>${t.name}</span><i style="width:${Math.max(4, (t.items / maxN) * 100)}%"></i><b>${t.items}</b></button>`)}</div></section>` : ''}
  ${open.has('importmaterials') && d.create ? importBox('materials', 'type,name,hsn,gst,attr_width,attr_gsm\nKNIT,Interlock 200 GSM,6006,5,170,200', 'type, name, description, hsn, gst, reorder_level, unit, attr_<name>…') : ''}
  ${open.has('newmat') && d.create ? html`<form class="card form" data-form="newmat"><h2>New material</h2>
    <label>Type<select id="mat-type">${opts(d.types.filter((t) => t.status === 'active').map((t) => ({ id: t.id, label: `${t.name} · ${KIND_LABEL[t.kind]}` })), st.newType, 'Choose a type…')}</select></label>
    ${nt ? html`<p class="sub">Code will be given automatically (${nt.code_prefix}-…). ${nt.attr_schema.length ? 'This type needs: ' + nt.attr_schema.map((a: md.AttrDef) => a.label).join(', ') + '.' : ''}</p>
    <div class="grid2"><label>Name<input id="mat-name" required value="${dv('mat-name')}" /></label>
    <label>Unit<select id="mat-unit">${opts(d.units.map((u) => ({ id: u.code, label: `${u.name} (${u.code})` })), dv('mat-unit', nt.default_unit))}</select></label>
    <label>HSN code<input id="mat-hsn" inputmode="numeric" value="${dv('mat-hsn')}" /></label><label>GST %<input id="mat-gst" inputmode="decimal" value="${dv('mat-gst')}" /></label>
    <label>Reorder level<input id="mat-reorder" inputmode="decimal" value="${dv('mat-reorder')}" /></label><label>Notes<input id="mat-desc" value="${dv('mat-desc')}" /></label>
    ${nt.attr_schema.map((a: md.AttrDef) => fld(a, dv('na-' + a.key), 'na-'))}</div>
    <div class="row"><button class="primary" type="submit">Save as draft</button><button type="button" data-act="mat-new">Cancel</button></div>` : html`<p class="empty">Pick a type first. The form then asks for exactly what that type needs.</p>`}</form>` : ''}
  <section class="split"><div class="card"><h2>Materials</h2>
    <div class="row"><input id="mat-q" type="search" placeholder="Search code or name" value="${st.matQ}" style="flex:1;min-width:140px" /><select id="mat-sf" aria-label="Status">${opts([{ id: 'active', label: 'In use' }, { id: 'draft', label: 'Draft' }, { id: 'submitted', label: 'Waiting for approval' }, { id: 'inactive', label: 'Switched off' }], st.matStatus, 'Any status')}</select>${st.matType ? html`<button data-act="mat-typefilter" data-id="">Clear type filter</button>` : ''}</div>
    ${d.list.length ? html`<div class="scroll"><table class="mini"><thead><tr><th>Code</th><th>Name</th><th>Type</th><th class="r">In stock</th><th>Status</th></tr></thead><tbody>${d.list.map((m) => { const lowM = m.status === 'active' && m.reorder_level && Number(m.on_hand) < Number(m.reorder_level);
      return html`<tr class="pick ${m.id === st.mat ? 'on' : ''}" data-act="mat-pick" data-id="${m.id}" tabindex="0"><td>${m.code}</td><td>${m.name}</td><td><small>${m.type_name ?? 'no type'}</small></td><td class="r">${qty(m.on_hand)} ${m.stock_unit}${lowM ? html` <span class="chip bad">low</span>` : ''}</td><td>${sChip(m.status)}</td></tr>`; })}</tbody></table></div>` : html`<p class="empty">Nothing matches.</p>`}</div>
  <div class="card">${s && it ? html`<h2>${it.name} ${sChip(it.status)}</h2><p class="sub">${it.code} · ${it.type_name ?? 'no type'} · counted in ${it.stock_unit} · ${it.tracking === 'ROLL' ? 'tracked by roll' : it.tracking === 'LOT' ? 'tracked by lot' : 'not tracked'}</p>
    ${open.has('editmat') && d.edit && it.status !== 'submitted' ? html`<form class="form" data-form="editmat"><div class="grid2"><label>Name<input id="em-name" value="${it.name}" /></label><label>HSN code<input id="em-hsn" value="${it.hsn_code ?? ''}" /></label><label>GST %<input id="em-gst" value="${it.gst_rate ?? ''}" /></label><label>Reorder level<input id="em-reorder" value="${it.reorder_level ? Number(it.reorder_level) : ''}" /></label><label>Notes<input id="em-desc" value="${it.description ?? ''}" /></label>
      ${(it.attr_schema ?? []).map((a: md.AttrDef) => fld(a, it.attributes?.[a.key], 'ea-'))}</div><div class="row"><button class="primary" type="submit">Save changes</button><button type="button" data-act="mat-edit">Cancel</button></div></form>` : html`
    <div class="kvs"><div class="kv"><span>HSN code</span><b>${it.hsn_code ?? '–'}</b></div><div class="kv"><span>GST</span><b>${it.gst_rate ? Number(it.gst_rate) + '%' : '–'}</b></div><div class="kv"><span>Reorder level</span><b>${it.reorder_level ? qty(it.reorder_level) + ' ' + it.stock_unit : '–'}</b></div>
      ${(it.attr_schema ?? []).map((a: md.AttrDef) => html`<div class="kv"><span>${a.label}</span><b>${it.attributes?.[a.key] ?? '–'}${it.attributes?.[a.key] && a.unit ? ' ' + a.unit : ''}</b></div>`)}</div>
    ${it.description ? html`<p>${it.description}</p>` : ''}`}
    <div class="row">${d.edit && it.status !== 'submitted' && !open.has('editmat') ? html`<button data-act="mat-edit">Edit</button>` : ''}
      ${it.status === 'draft' && d.submit ? html`<button class="primary" data-act="mat-submit">Send for approval</button>` : ''}
      ${it.status === 'submitted' && d.approve && !mine ? html`<button class="primary" data-act="mat-approve">Approve</button>` : ''}${it.status === 'submitted' && mine ? html`<small class="sub">Waiting for someone else to approve. You cannot approve what you made.</small>` : ''}
      ${it.status === 'active' && d.deact ? html`<button data-act="mat-offopen">Switch off…</button>` : ''}${it.status === 'inactive' && d.deact ? html`<button data-act="mat-on">Switch back on</button>` : ''}</div>
    ${open.has('matoff') ? html`<form class="row" data-form="mat-off"><input id="mat-reason" placeholder="Why is it being switched off?" style="flex:1" /><button type="submit">Confirm</button></form>` : ''}
    <h3>In stock</h3>${s.stock.length ? html`<table class="mini"><thead><tr><th>Roll / lot</th><th>Where</th><th>State</th><th class="r">Qty</th></tr></thead><tbody>${s.stock.map((r) => html`<tr><td>${r.label}</td><td>${r.location}</td><td>${chip(r.status.toLowerCase() === 'accepted' ? 'accepted' : r.status.toLowerCase() === 'hold' ? 'held' : 'rejected')}</td><td class="r">${qty(r.qty)}</td></tr>`)}</tbody></table>` : html`<p class="empty">None on hand.</p>`}
    <h3>Vendor prices</h3>${s.rates.length ? html`<table class="mini"><tbody>${s.rates.map((r) => html`<tr><td>${r.vendor}</td><td class="r">${money(r.rate)} / ${r.unit}${Number(r.min_qty) ? html` <small>from ${qty(r.min_qty)}</small>` : ''}</td><td>${r.status === 'approved' ? chip('approved') : chip(r.status)}</td></tr>`)}</tbody></table>` : html`<p class="empty">No vendor price on file.</p>`}
    <p class="sub">Used on ${s.used.po} purchase order line${s.used.po === 1 ? '' : 's'} and ${s.used.so} sales order line${s.used.so === 1 ? '' : 's'}.</p>
    <h3>History</h3><ul class="timeline">${s.history.map((h: { at: string; action: string; who: string; reason: string | null }) => html`<li><b>${h.action.replace('item.', '').replace(/\./g, ' ')}</b> by ${h.who ?? 'system'} <small>${when(h.at)}${h.reason ? ' · ' + h.reason : ''}</small></li>`)}</ul>` : html`<p class="empty">Pick a material to see its details.</p>`}</div></section>`;
}

// ───────────────────────── Material types ─────────────────────────
export async function typesView(): Promise<Raw> {
  const d = await read(async (db) => ({ types: await md.listMaterialTypes(db, uid()), units: await md.listUnits(db), manage: await can(db, uid(), 'mtype.manage', ANY), unit: await can(db, uid(), 'unit.create', ANY) }));
  if (!d.types.length && !d.manage) return denied('Material types', 'The kinds of material your business uses.', 'Your role cannot see material types.');
  const sel = d.types.find((t) => t.id === st.typ);
  const kinds = [...new Set(d.types.map((t) => t.kind))];
  return html`${head('Material types', 'A type decides what must be recorded for every material in it, so fabric always has a width and a GSM.', d.manage ? html`<button class="primary" data-act="ty-new">New type</button>` : undefined)}
  ${open.has('newtype') && d.manage ? html`<form class="card form" data-form="newtype"><h2>New material type</h2><div class="grid2"><label>Name<input id="ty-name" required placeholder="e.g. Lace" /></label><label>Short code<input id="ty-code" required placeholder="LACE" /></label>
    <label>Group<select id="ty-kind">${md.KINDS.filter((k) => !['WIP', 'PROCESS'].includes(k)).map((k) => html`<option value="${k}">${KIND_LABEL[k]}</option>`)}</select></label><label>Counted in<select id="ty-unit">${opts(d.units.map((u) => ({ id: u.code, label: `${u.name} (${u.code})` })))}</select></label>
    <label>Tracking<select id="ty-track"><option value="LOT">By lot</option><option value="ROLL">By roll</option><option value="NONE">Not tracked</option></select></label><label>Code letters<input id="ty-prefix" maxlength="4" placeholder="LAC" /></label></div>
    <label>What must be recorded <small>(one per line: name | number or text | unit | required)</small><textarea id="ty-attrs" rows="4" placeholder="Width|number|mm|required&#10;Colour|text"></textarea></label><div class="row"><button class="primary" type="submit">Save type</button><button type="button" data-act="ty-new">Cancel</button></div></form>` : ''}
  <section class="split"><div class="card"><h2>Types</h2>${kinds.map((k) => html`<h3>${KIND_LABEL[k]}</h3><table class="mini"><tbody>${d.types.filter((t) => t.kind === k).map((t) => html`<tr class="pick ${t.id === st.typ ? 'on' : ''}" data-act="ty-pick" data-id="${t.id}" tabindex="0"><td><b>${t.name}</b><br><small>${(t.attr_schema as md.AttrDef[]).map((a) => a.label).join(' · ') || 'nothing extra'}</small></td><td class="r">${t.items} material${t.items === 1 ? '' : 's'}</td><td>${t.status === 'active' ? '' : chip('cancelled', 'switched off')}</td></tr>`)}</tbody></table>`)}</div>
  <div class="card">${sel ? html`<h2>${sel.name} <span class="chip neutral">${sel.code}</span></h2><p class="sub">${KIND_LABEL[sel.kind]} · counted in ${sel.default_unit} · codes start ${sel.code_prefix}- · ${sel.items} material${sel.items === 1 ? '' : 's'}</p>
    ${d.manage ? html`<form class="form" data-form="edittype"><label>Name<input id="et-name" value="${sel.name}" /></label><label>Tracking<select id="et-track">${opts([{ id: 'LOT', label: 'By lot' }, { id: 'ROLL', label: 'By roll' }, { id: 'NONE', label: 'Not tracked' }], sel.tracking)}</select></label>
      <label>What must be recorded <small>(name | number or text | unit | required)</small><textarea id="et-attrs" rows="5">${md.attrsToText(sel.attr_schema)}</textarea></label><p class="sub">New rules apply to new and edited materials; existing ones keep what they have.</p>
      <div class="row"><button class="primary" type="submit">Save</button><button type="button" data-act="ty-toggle" data-id="${sel.status === 'active' ? 'inactive' : 'active'}">${sel.status === 'active' ? 'Switch off' : 'Switch back on'}</button></div></form>`
      : html`<ul>${(sel.attr_schema as md.AttrDef[]).map((a) => html`<li>${a.label} <small>${a.type}${a.unit ? ', ' + a.unit : ''}${a.required ? ', required' : ''}</small></li>`)}</ul>`}` : html`<p class="empty">Pick a type to see what it records.</p>`}
    <h3>Units</h3><table class="mini"><tbody>${d.units.map((u) => html`<tr><td>${u.code}</td><td>${u.name}</td><td class="r"><small>${u.precision} decimal place${u.precision === 1 ? '' : 's'}</small></td></tr>`)}</tbody></table>
    ${d.unit ? html`<form class="row" data-form="newunit"><input id="un-code" placeholder="Code, e.g. CONE" style="width:120px" required /><input id="un-name" placeholder="Name" required /><select id="un-prec"><option value="0">whole numbers</option><option value="3" selected>3 decimals</option></select><button type="submit">Add unit</button></form>` : ''}</div></section>`;
}

// ───────────────────────── Vendors & clients ─────────────────────────
export async function partiesView(role: 'vendor' | 'customer'): Promise<Raw> {
  const V = role === 'vendor'; const W = V ? 'Vendors' : 'Clients'; const noun = V ? 'vendor' : 'client';
  const d = await read(async (db) => {
    const all = await md.listParties(db, uid(), { role });
    const list = all && await md.listParties(db, uid(), { role, q: st.q[role], status: st.stat[role] });
    const sel = st.sel[role] ? await md.getParty(db, uid(), st.sel[role]).catch(() => null) : null;
    const c = (p: string) => can(db, uid(), p, ANY);
    return { all, list, sel, items: (await db.query(`SELECT id, code, name FROM item WHERE status='active' ORDER BY code`)).rows,
      create: await c('partner.create'), edit: await c('partner.edit'), submit: await c('partner.submit'), bankOk: await c('partner.bank.approve'), approve: await c('partner.trade.approve'), suspend: await c('partner.suspend'),
      ratePropose: await c('rate.propose'), rateApprove: await c('rate.approve'), terms: await c('customer.terms'), bankView: await c('partner.bank.view') };
  });
  if (!d.all) return denied(W, V ? 'Who you buy from.' : 'Who you sell to.', `Your role cannot see ${noun}s.`);
  const s = d.sel; const p = s?.p;
  const waiting = d.all.filter((x) => ['draft', 'verification'].includes(x.status));
  const total = d.all.reduce((a, x) => a + Number(V ? x.po_value : x.order_value), 0);
  const top = [...d.all].sort((a, b) => Number(V ? b.po_value : b.order_value) - Number(V ? a.po_value : a.order_value)).slice(0, 5).filter((x) => Number(V ? x.po_value : x.order_value) > 0);
  const topMax = Math.max(...top.map((x) => Number(V ? x.po_value : x.order_value)), 1);
  const mine = p && p.created_by === uid();
  const rateMine = (r: { proposed_by: string }) => r.proposed_by === uid();
  const step = (label: string, on: boolean, done: boolean) => html`<li class="${done ? 'done' : on ? 'now' : ''}">${label}</li>`;
  const phase = !p ? 0 : p.status === 'draft' ? 1 : p.status === 'verification' ? 2 : 3;
  return html`${head(W, V ? 'Who you buy from: details, contacts, prices and how they have performed.' : 'Who you sell to: details, contacts, credit and orders.', d.create ? html`<div class="row"><button class="primary" data-act="p-new">New ${noun}</button><button data-act="mx-import-parties">Bulk add</button></div>` : undefined)}
  <section class="card crm-sum"><div class="crm-k"><span>${W}</span><b>${d.all.length}</b></div><div class="crm-k"><span>Approved</span><b>${d.all.filter((x) => x.status === 'active').length}</b></div><div class="crm-k"><span>Waiting for checks</span><b class="${waiting.length ? 'warn-t' : ''}">${waiting.length}</b></div>
    <div class="crm-k"><span>Suspended</span><b class="${d.all.some((x) => x.status === 'suspended') ? 'bad-t' : ''}">${d.all.filter((x) => x.status === 'suspended').length}</b></div><div class="crm-k"><span>${V ? 'Bought so far' : 'Ordered so far'}</span><b>${inr(total)}</b></div></section>
  ${top.length ? html`<section class="card"><h2>${V ? 'Biggest vendors by value' : 'Biggest clients by value'}</h2><div class="tbars">${top.map((x) => html`<button class="tbar" data-act="p-pick" data-id="${x.id}"><span>${x.name}</span><i style="width:${Math.max(4, (Number(V ? x.po_value : x.order_value) / topMax) * 100)}%"></i><b>${inr(Number(V ? x.po_value : x.order_value))}</b></button>`)}</div></section>` : ''}
  ${open.has('importparties') && d.create ? importBox('parties', 'role,name,gstin,city,payment_days,contact_name\nvendor,Om Trims,24AAACO1111F1Z4,Surat,30,Raju', 'role (vendor/customer/both), name, gstin, pan, city, state, phone, email, payment_days, contact_name, contact_phone') : ''}
  ${open.has('newparty') && d.create ? html`<form class="card form" data-form="newparty"><h2>New ${noun}</h2><div class="grid2"><label>Name<input id="np-name" required /></label><label>GSTIN<input id="np-gstin" placeholder="29ABCDE1234F1Z5" /></label><label>PAN<input id="np-pan" placeholder="ABCDE1234F" /></label>
    <label>City<input id="np-city" /></label><label>State<select id="np-state">${opts(INDIAN_STATES.map((x) => ({ id: x, label: x })), '', 'Choose…')}</select></label><label>Phone<input id="np-phone" inputmode="tel" /></label><label>Email<input id="np-email" type="email" /></label>
    <label>Payment days<input id="np-days" inputmode="numeric" placeholder="${V ? 'what they give us' : 'what we give them'}" /></label><label>Main contact<input id="np-cname" /></label><label>Contact phone<input id="np-cphone" inputmode="tel" /></label>
    ${V ? html`<label>Bank account <small>(checked by finance)</small><input id="np-bank" inputmode="numeric" /></label>` : ''}</div>
    <h3>Billing address</h3><p class="sub">Invoices go here. The state decides which GST applies.</p>${addrFields('nb-')}
    <h3>Shipping address</h3><label class="chk"><input type="checkbox" id="ns-same" checked /> Same as billing</label><div id="ns-box" hidden>${addrFields('ns-')}</div>
    <div class="row"><button class="primary" type="submit">Save as draft</button><button type="button" data-act="p-new">Cancel</button></div></form>` : ''}
  <section class="split"><div class="card"><h2>${W}</h2>
    <div class="row"><input id="p-q" type="search" placeholder="Search name, code, GSTIN or city" value="${st.q[role]}" style="flex:1;min-width:140px" /><select id="p-sf" aria-label="Status">${opts([{ id: 'active', label: 'Approved' }, { id: 'draft', label: 'Draft' }, { id: 'verification', label: 'Waiting for checks' }, { id: 'suspended', label: 'Suspended' }], st.stat[role], 'Any status')}</select></div>
    ${d.list && d.list.length ? html`<div class="scroll"><table class="mini"><thead><tr><th>Code</th><th>Name</th><th>City</th><th class="r">${V ? 'Orders' : 'Orders'}</th><th>Status</th></tr></thead><tbody>${d.list.map((x) => html`<tr class="pick ${x.id === st.sel[role] ? 'on' : ''}" data-act="p-pick" data-id="${x.id}" tabindex="0"><td>${x.code}</td><td>${x.name}${x.contact ? html`<br><small>${x.contact}</small>` : ''}</td><td>${x.city ?? ''}</td><td class="r">${V ? x.pos : x.orders}</td><td>${sChip(x.status)}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">Nothing matches.</p>`}</div>
  <div class="card">${s && p ? html`<h2>${p.name} ${sChip(p.status)}</h2><p class="sub">${p.code}${p.city ? ' · ' + p.city : ''}${p.state ? ', ' + p.state : ''} · added by ${s.creator}</p>
    <ol class="wf">${step('Details added', phase === 1, phase > 1)}${step('Checked' + (V ? ' (bank by finance)' : ''), phase === 2, phase > 2)}${step('Approved', phase === 3 && p.status === 'active', p.status === 'active')}</ol>
    ${open.has('editparty') && d.edit ? html`<form class="form" data-form="editparty"><div class="grid2"><label>Name<input id="ep-name" value="${p.name}" /></label><label>GSTIN<input id="ep-gstin" value="${p.gstin ?? ''}" /></label><label>PAN<input id="ep-pan" value="${p.pan ?? ''}" /></label><label>City<input id="ep-city" value="${p.city ?? ''}" /></label>
      <label>State<select id="ep-state">${opts(INDIAN_STATES.map((x) => ({ id: x, label: x })), p.state ?? '', 'Choose…')}</select></label><label>Phone<input id="ep-phone" value="${p.phone ?? ''}" /></label><label>Email<input id="ep-email" value="${p.email ?? ''}" /></label><label>Payment days<input id="ep-days" value="${p.payment_days ?? ''}" /></label>
      ${V || p.bank_account ? html`<label>Bank account <small>(blank = keep ${p.bank_account ?? 'none'})</small><input id="ep-bank" inputmode="numeric" /></label>` : ''}</div><label>Notes<input id="ep-notes" value="${p.notes ?? ''}" /></label>
      ${['active', 'suspended'].includes(p.status) ? html`<p class="sub">Changing the GSTIN or bank account sends this ${noun} back for checking until it is approved again.</p>` : ''}<div class="row"><button class="primary" type="submit">Save</button><button type="button" data-act="p-edit">Cancel</button></div></form>` : html`
    <div class="kvs"><div class="kv"><span>GSTIN</span><b>${p.gstin ?? '–'}</b></div><div class="kv"><span>PAN</span><b>${p.pan ?? '–'}</b></div><div class="kv"><span>Phone</span><b>${p.phone ?? '–'}</b></div><div class="kv"><span>Email</span><b>${p.email ?? '–'}</b></div>
      <div class="kv"><span>Payment days</span><b>${p.payment_days ?? s.terms?.payment_days ?? '–'}</b></div>${V ? html`<div class="kv"><span>Bank account</span><b>${p.bank_account ?? '–'} ${p.bank_account ? (p.bank_verified_by ? chip('accepted', 'verified') : chip('held', 'not verified')) : ''}</b></div>` : html`<div class="kv"><span>Credit limit</span><b>${s.terms && Number(s.terms.credit_limit) ? money(s.terms.credit_limit) : 'none set'}</b></div>`}</div>${p.notes ? html`<p>${p.notes}</p>` : ''}`}
    <div class="row">${d.edit && !open.has('editparty') ? html`<button data-act="p-edit">Edit</button>` : ''}${p.status === 'draft' && d.submit ? html`<button class="primary" data-act="p-submit">Send for checking</button>` : ''}
      ${p.status === 'verification' && p.bank_account && !p.bank_verified_by && d.bankOk && !mine ? html`<button class="primary" data-act="p-bank">Verify bank account</button>` : ''}
      ${p.status === 'verification' && d.approve && !mine && (!p.bank_account || p.bank_verified_by) ? html`<button class="primary" data-act="p-approve">Approve</button>` : ''}
      ${p.status === 'verification' && mine ? html`<small class="sub">Someone else must check and approve this. You cannot approve what you added.</small>` : ''}
      ${p.status === 'verification' && p.bank_account && !p.bank_verified_by && !d.bankOk ? html`<small class="sub">Waiting for finance to verify the bank account.</small>` : ''}
      ${p.status === 'active' && d.suspend ? html`<button data-act="p-suspendopen">Suspend…</button>` : ''}${p.status === 'suspended' && d.suspend ? html`<button class="primary" data-act="p-reactivate">Reactivate</button>` : ''}</div>
    ${open.has('suspend') ? html`<form class="row" data-form="p-suspend"><input id="p-reason" placeholder="Why? (no new orders while suspended)" style="flex:1" /><button type="submit">Confirm</button></form>` : ''}
    <h3>Contacts</h3>${s.contacts.length ? html`<ul class="plain">${s.contacts.map((c: { id: string; name: string; role: string | null; phone: string | null; email: string | null; is_primary: boolean }) => html`<li><b>${c.name}</b>${c.is_primary ? html` <span class="chip info">main</span>` : ''} <small>${[c.role, c.phone, c.email].filter(Boolean).join(' · ')}</small>${d.edit ? html` <button class="ghost sm" data-act="c-del" data-id="${c.id}" aria-label="Remove ${c.name}">Remove</button>` : ''}</li>`)}</ul>` : html`<p class="empty">No contacts yet.</p>`}
    ${d.edit ? html`<form class="row" data-form="addcontact"><input id="ct-name" placeholder="Name" required /><input id="ct-role" placeholder="Role" style="width:110px" /><input id="ct-phone" placeholder="Phone" style="width:130px" /><input id="ct-email" placeholder="Email" /><button type="submit">Add contact</button></form>` : ''}
    <h3>Addresses</h3>${(['billing', 'shipping', 'registered', 'works'] as const).map((k) => { const list = (s.addresses as Addr[]).filter((x) => x.kind === k); return list.length || k === 'billing' || k === 'shipping' ? html`<div class="addrs"><h4>${k === 'billing' ? 'Billing' : k === 'shipping' ? 'Shipping' : k === 'registered' ? 'Registered office' : 'Works'}</h4>${list.length ? list.map((a) => open.has('ea-' + a.id) && d.edit ? html`<form class="form" data-form="editaddr" data-id="${a.id}">${addrFields('ea-', a)}<div class="row"><button class="primary" type="submit">Save</button><button type="button" data-act="a-edit" data-id="${a.id}">Cancel</button></div></form>` : html`<div class="addr"><div><b>${a.label || k}</b> ${a.is_default ? html`<span class="chip info">default</span>` : ''}<br>${[a.line1, a.line2].filter(Boolean).join(', ')}<br>${[a.city, a.state, a.pincode].filter(Boolean).join(', ')}${a.contact_name || a.phone ? html`<br><small>${[a.contact_name, a.phone].filter(Boolean).join(' · ')}${a.gstin ? ' · GSTIN ' + a.gstin : ''}</small>` : ''}</div>${d.edit ? html`<div class="row">${!a.is_default ? html`<button class="ghost sm" data-act="a-def" data-id="${a.id}">Make default</button>` : ''}<button class="ghost sm" data-act="a-edit" data-id="${a.id}">Edit</button><button class="ghost sm" data-act="a-del" data-id="${a.id}" aria-label="Remove address">Remove</button></div>` : ''}</div>`) : html`<p class="empty">None yet.</p>`}</div>` : ''; })}
    ${d.edit ? (open.has('addaddr') ? html`<form class="form" data-form="addaddr"><label>Type<select id="ad-kind"><option value="billing">Billing</option><option value="shipping">Shipping</option><option value="registered">Registered office</option><option value="works">Works</option></select></label>${addrFields('ad-')}<label class="chk"><input type="checkbox" id="ad-def" /> Make this the default for its type</label><div class="row"><button class="primary" type="submit">Add address</button><button type="button" data-act="a-add">Cancel</button></div></form>` : html`<div class="row"><button data-act="a-add">Add address</button></div>`) : ''}
    ${V ? html`<h3>Price list</h3>${s.rates.length ? html`<table class="mini"><thead><tr><th>Material</th><th class="r">Price</th><th>From</th><th>Status</th><th></th></tr></thead><tbody>${s.rates.map((r: { id: string; item_code: string; item_name: string; rate: string; unit: string; min_qty: string; effective_from: string; status: string; proposed_by: string }) => html`<tr><td>${r.item_code}<br><small>${r.item_name}</small></td><td class="r">${money(r.rate)} / ${r.unit}${Number(r.min_qty) ? html`<br><small>from ${qty(r.min_qty)}</small>` : ''}</td><td>${dateOnly(String(r.effective_from).slice(0, 10))}</td><td>${r.status === 'approved' ? chip('approved') : r.status === 'superseded' ? chip('closed', 'old') : chip('proposed')}</td><td>${r.status === 'proposed' && d.rateApprove && !rateMine(r) ? html`<button class="sm" data-act="r-approve" data-id="${r.id}">Approve</button>` : ''}</td></tr>`)}</tbody></table>` : html`<p class="empty">No prices agreed yet.</p>`}
      ${d.ratePropose && p.status === 'active' ? html`<form class="row" data-form="addrate"><select id="rt-item">${opts(d.items.map((i) => ({ id: i.id, label: `${i.code} · ${i.name}` })))}</select><input id="rt-rate" inputmode="decimal" placeholder="Price" style="width:90px" required /><input id="rt-min" inputmode="decimal" placeholder="From qty" style="width:90px" /><input id="rt-from" type="date" value="${todayIso()}" /><button type="submit">Propose price</button></form><p class="sub">A different person approves each price. The old price ends the day before the new one starts.</p>` : ''}
      <h3>Purchase orders</h3>${s.pos.length ? html`<table class="mini"><tbody>${s.pos.map((o: { number: string; status: string; total: string }) => html`<tr><td>${o.number}</td><td class="r">${money(o.total)}</td><td>${chip(o.status)}</td></tr>`)}</tbody></table>` : html`<p class="empty">No orders placed yet.</p>`}`
    : html`<h3>Sales orders</h3>${s.orders.length ? html`<table class="mini"><tbody>${s.orders.map((o: { number: string; status: string; total: string }) => html`<tr><td>${o.number}</td><td class="r">${money(o.total)}</td><td>${chip(o.status)}</td></tr>`)}</tbody></table>` : html`<p class="empty">No orders yet.</p>`}`}
    <h3>History</h3><ul class="timeline">${s.history.map((h: { at: string; action: string; who: string; reason: string | null }) => html`<li><b>${h.action.replace('partner.', '').replace(/\./g, ' ')}</b> by ${h.who ?? 'system'} <small>${when(h.at)}${h.reason ? ' · ' + h.reason : ''}</small></li>`)}</ul>`
    : html`<p class="empty">Pick a ${noun} to see the details.</p>`}</div></section>`;
}
export const vendorsView = () => partiesView('vendor');
export const clientsView = () => partiesView('customer');

// ───────────────────────── events ─────────────────────────
const roleNow = (): 'vendor' | 'customer' => ((S.view as string) === 'clients' ? 'customer' : 'vendor');
const PARTY_FIELDS = (p: string) => ({ name: val(p + 'name') || undefined, gstin: val(p + 'gstin'), pan: val(p + 'pan'), city: val(p + 'city'), state: val(p + 'state'), phone: val(p + 'phone'), email: val(p + 'email') });

export async function onClick(t: HTMLElement): Promise<boolean> {
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b) return false;
  const a = b.dataset.act!, id = b.dataset.id ?? '';
  const done = async () => { await R.render(); return true; };
  switch (a) {
    case 'mat-new': toggle('newmat'); st.draft = {}; st.newType = ''; return done();
    case 'mat-pick': st.mat = st.mat === id ? '' : id; open.delete('editmat'); open.delete('matoff'); return done();
    case 'mat-typefilter': st.matType = st.matType === id ? '' : id; return done();
    case 'mat-edit': toggle('editmat'); return done();
    case 'mat-offopen': toggle('matoff'); return done();
    case 'mat-submit': { const v = await verOf('item', st.mat); await act('Sent for approval', (c) => masters.submitItem(c, { itemId: st.mat, expectedVersion: v })); return true; }
    case 'mat-approve': { const v = await verOf('item', st.mat); await act('Material approved. It can now be bought and sold', (c) => masters.approveItem(c, { itemId: st.mat, expectedVersion: v })); return true; }
    case 'mat-on': { const v = await verOf('item', st.mat); await act('Switched back on', (c) => md.setMaterialActive(c, { itemId: st.mat, expectedVersion: v, active: true })); return true; }
    case 'mx-import-materials': toggle('importmaterials'); st.importRes = null; return done();
    case 'mx-import-parties': toggle('importparties'); st.importRes = null; return done();
    case 'mx-import-close': open.delete('importmaterials'); open.delete('importparties'); st.importRes = null; st.draft['imp-text'] = ''; return done();
    case 'ty-new': toggle('newtype'); return done();
    case 'ty-pick': st.typ = st.typ === id ? '' : id; return done();
    case 'ty-toggle': { await act(id === 'inactive' ? 'Type switched off' : 'Type switched on', (c) => md.updateMaterialType(c, { id: st.typ, status: id as 'active' | 'inactive' })); return true; }
    case 'p-new': toggle('newparty'); return done();
    case 'p-pick': st.sel[roleNow()] = st.sel[roleNow()] === id ? '' : id; open.delete('editparty'); open.delete('suspend'); return done();
    case 'p-edit': toggle('editparty'); return done();
    case 'p-suspendopen': toggle('suspend'); return done();
    case 'p-submit': { const v = await verOf('partner', st.sel[roleNow()]); await act('Sent for checking', (c) => masters.submitPartner(c, { partnerId: st.sel[roleNow()], expectedVersion: v })); return true; }
    case 'p-bank': { const v = await verOf('partner', st.sel[roleNow()]); await act('Bank account verified', (c) => masters.verifyPartnerBank(c, { partnerId: st.sel[roleNow()], expectedVersion: v })); return true; }
    case 'p-approve': { const v = await verOf('partner', st.sel[roleNow()]); await act('Approved. It can now be used on orders', (c) => masters.approvePartner(c, { partnerId: st.sel[roleNow()], expectedVersion: v })); return true; }
    case 'p-reactivate': { const v = await verOf('partner', st.sel[roleNow()]); await act('Reactivated', (c) => md.reactivateParty(c, { partnerId: st.sel[roleNow()], expectedVersion: v })); return true; }
    case 'c-del': await act('Contact removed', (c) => md.removeContact(c, { contactId: id })); return true;
    case 'a-add': open.has('addaddr') ? open.delete('addaddr') : open.add('addaddr'); await R.render(); return true;
    case 'a-edit': open.has('ea-' + id) ? open.delete('ea-' + id) : open.add('ea-' + id); await R.render(); return true;
    case 'a-def': await act('Default address changed', (c) => md.setDefaultAddress(c, { addressId: id })); return true;
    case 'a-del': await act('Address removed', (c) => md.removeAddress(c, { addressId: id })); return true;
    case 'r-approve': await act('Price approved', (c) => masters.approveRate(c, { rateId: id })); return true;
  }
  return false;
}

export async function onSubmit(form: string, f?: HTMLElement, ev?: SubmitEvent): Promise<boolean> {
  const sel = () => st.sel[roleNow()];
  switch (form) {
    case 'newmat': {
      const nt = st.newType; const attrs: Record<string, string> = {};
      f?.querySelectorAll('input[id^="na-"]').forEach((e) => { const i = e as HTMLInputElement; attrs[i.id.slice(3)] = i.value.trim(); });
      const r = await act('Material saved as a draft. Send it for approval when ready', (c) => md.createMaterial(c, { typeId: nt, name: val('mat-name'), unit: val('mat-unit'), hsnCode: val('mat-hsn') || undefined, gstRate: val('mat-gst') || undefined, reorderLevel: val('mat-reorder') || undefined, description: val('mat-desc') || undefined, attributes: attrs }));
      if (r) { open.delete('newmat'); st.mat = r.id; st.draft = {}; st.newType = ''; await R.render(); } return true;
    }
    case 'editmat': {
      const attrs: Record<string, string> = {}; f?.querySelectorAll('input[id^="ea-"]').forEach((e) => { const i = e as HTMLInputElement; attrs[i.id.slice(3)] = i.value.trim(); });
      const v = await verOf('item', st.mat);
      const r = await act('Saved', (c) => md.updateMaterial(c, { itemId: st.mat, expectedVersion: v, name: val('em-name'), hsnCode: val('em-hsn'), gstRate: val('em-gst'), reorderLevel: val('em-reorder'), description: val('em-desc'), attributes: attrs }));
      if (r) { open.delete('editmat'); await R.render(); } return true;
    }
    case 'mat-off': { const v = await verOf('item', st.mat); const r = await act('Switched off', (c) => md.setMaterialActive(c, { itemId: st.mat, expectedVersion: v, active: false, reason: val('mat-reason') })); if (r) { open.delete('matoff'); await R.render(); } return true; }
    case 'newtype': {
      const r = await act('Material type added', async (c) => md.createMaterialType(c, { code: val('ty-code'), name: val('ty-name'), kind: val('ty-kind'), defaultUnit: val('ty-unit'), tracking: val('ty-track'), prefix: val('ty-prefix') || undefined, attrs: md.parseAttrs((document.getElementById('ty-attrs') as HTMLTextAreaElement).value) }));
      if (r) { open.delete('newtype'); st.typ = r.id; await R.render(); } return true;
    }
    case 'edittype': await act('Saved', async (c) => md.updateMaterialType(c, { id: st.typ, name: val('et-name'), tracking: val('et-track'), attrs: md.parseAttrs((document.getElementById('et-attrs') as HTMLTextAreaElement).value) })); return true;
    case 'newunit': { const r = await act('Unit added', (c) => admin.createUnit(c, { code: val('un-code').toUpperCase(), name: val('un-name'), precision: Number(val('un-prec')) })); if (r) await R.render(); return true; }
    case 'newparty': {
      const role = roleNow();
      const r = await act(`${role === 'vendor' ? 'Vendor' : 'Client'} saved as a draft`, (c) => md.createParty(c, { ...PARTY_FIELDS('np-'), name: val('np-name'), role, paymentDays: val('np-days') ? Number(val('np-days')) : undefined, bankAccount: val('np-bank') || undefined, contact: val('np-cname') ? { name: val('np-cname'), phone: val('np-cphone') || undefined } : undefined, ...(val('nb-line') ? { billing: readAddr('nb-'), shippingSameAsBilling: (document.getElementById('ns-same') as HTMLInputElement).checked, shipping: (document.getElementById('ns-same') as HTMLInputElement).checked ? undefined : (val('ns-line') ? readAddr('ns-') : undefined) } : {}) }));
      if (r) { open.delete('newparty'); st.sel[role] = r.id; await R.render(); } return true;
    }
    case 'editparty': {
      const v = await verOf('partner', sel());
      const r = await act('Saved', (c) => md.updateParty(c, { partnerId: sel(), expectedVersion: v, ...PARTY_FIELDS('ep-'), paymentDays: val('ep-days') ? Number(val('ep-days')) : null, notes: val('ep-notes'), bankAccount: val('ep-bank') }));
      if (r) { open.delete('editparty'); if ((r as { sentBack?: boolean }).sentBack) toast('Sent back for checking because the GSTIN or bank account changed'); await R.render(); } return true;
    }
    case 'p-suspend': { const v = await verOf('partner', sel()); const r = await act('Suspended. No new orders can be raised', (c) => md.suspendParty(c, { partnerId: sel(), expectedVersion: v, reason: val('p-reason') })); if (r) { open.delete('suspend'); await R.render(); } return true; }
    case 'addcontact': { const r = await act('Contact added', (c) => md.addContact(c, { partnerId: sel(), name: val('ct-name'), role: val('ct-role') || undefined, phone: val('ct-phone') || undefined, email: val('ct-email') || undefined })); if (r) await R.render(); return true; }
    case 'addaddr': { const r = await act('Address added', (c) => md.addAddress(c, { partnerId: sel(), kind: val('ad-kind'), ...readAddr('ad-'), makeDefault: (document.getElementById('ad-def') as HTMLInputElement).checked })); if (r) { open.delete('addaddr'); await R.render(); } return true; }
    case 'editaddr': { const aid = (ev?.target as HTMLElement).closest('form')!.dataset.id!; const r = await act('Address saved', (c) => md.updateAddress(c, { addressId: aid, ...readAddr('ea-') })); if (r) { open.delete('ea-' + aid); await R.render(); } return true; }
    case 'addrate': await act('Price proposed. A different person approves it', (c) => masters.proposeRate(c, { partnerId: sel(), itemId: val('rt-item'), rate: val('rt-rate'), minQty: val('rt-min') || undefined, effectiveFrom: val('rt-from') })); return true;
    case 'import-materials': case 'import-parties': {
      const what = form === 'import-materials' ? 'materials' : 'parties'; const text = (document.getElementById('imp-text') as HTMLTextAreaElement).value; st.draft['imp-text'] = text;
      const dry = (ev?.submitter as HTMLElement | null)?.dataset.check === '1';
      try { const r = await (await import('./ctx.js')).K.world.as(S.user, (c) => (what === 'materials' ? md.importMaterials(c, text, dry) : md.importParties(c, text, dry))); st.importRes = { ...r, what };
        if (!dry && !r.errors.length) { toast(`${r.created} rows added`); st.draft['imp-text'] = ''; } }
      catch (e) { toast((e as Error).message, 'bad'); }
      await R.render(); return true;
    }
  }
  return false;
}

export async function onChange(t: HTMLInputElement): Promise<boolean> {
  if (t.id === 'ns-same') { const b = document.getElementById('ns-box'); if (b) b.hidden = t.checked; return true; }
  if (t.id === 'mat-type') { capture('form[data-form=newmat]'); st.newType = t.value; await R.render(); return true; }
  if (t.id === 'mat-sf') { st.matStatus = t.value; await R.render(); return true; }
  if (t.id === 'p-sf') { st.stat[roleNow()] = t.value; await R.render(); return true; }
  return false;
}
export async function onInput(t: HTMLInputElement): Promise<boolean> {
  const set = t.id === 'mat-q' ? () => { st.matQ = t.value; } : t.id === 'p-q' ? () => { st.q[roleNow()] = t.value; } : null;
  if (!set) return false;
  set(); await R.render(); const el = document.getElementById(t.id) as HTMLInputElement | null; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } return true;
}
void esc;
