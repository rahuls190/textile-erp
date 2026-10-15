import { html, raw, chip, dateOnly, type Raw } from './lib.js';
import { K, uid, read, val, act, head, denied, R, opts, toast } from './ctx.js';
import * as prod from '../src/domain/production.js';
import * as plan from '../src/domain/planning.js';
import { can } from '../src/core/permissions.js';

const ANY = { anySite: true } as const;
const st = { tab: 'orders' as 'orders' | 'finish' | 'cut' | 'shade', style: '', splitLot: '', parts: 2 };
const tone: Record<string, string> = { draft: 'neutral', issued: 'warn', completed: 'ok', cancelled: 'bad' };
const mono = (s: string) => html`<span class="mono">${s}</span>`;

type WO = { id: string; number: string; kind: 'finish' | 'cut'; status: string; version: number; finish_name: string | null; colour: string | null; notes: string | null; created_at: string; cancel_reason: string | null; style: string | null; style_name: string | null; processor: string | null; out_code: string | null; creator: string; lines: { id: string; role: string; code: string; name: string; lot: string | null; planned: number; actual: number | null; unit: string; sku_id: string | null }[] };

export async function workView(): Promise<Raw> {
  const d = await read(async (db) => {
    if (!(await can(db, uid(), 'production.view', ANY))) return null;
    const orders = (await prod.listWorkOrders(db, uid())) as unknown as WO[];
    const lots = (await prod.freeFabricLots(db, uid())) as { id: string; label: string; code: string; name: string; unit: string; free: number; attributes: Record<string, unknown> }[];
    const vendors = (await db.query(`SELECT id, code, name FROM partner WHERE is_vendor AND status='active' ORDER BY name`)).rows as { id: string; code: string; name: string }[];
    const fabrics = (await db.query(`SELECT id, code, name FROM item WHERE kind='FABRIC' AND status='active' ORDER BY code`)).rows as { id: string; code: string; name: string }[];
    const styles = (await db.query(`SELECT s.id, s.code, s.name FROM product_style s WHERE EXISTS (SELECT 1 FROM bom b WHERE b.style_id=s.id AND b.status='active') ORDER BY s.code`)).rows as { id: string; code: string; name: string }[];
    const styleId = st.style || styles[0]?.id || '';
    const skus = styleId ? (await db.query(`SELECT id, code, size, colour_code FROM sku WHERE style_id=$1 ORDER BY colour_code, code`, [styleId])).rows as { id: string; code: string; size: string; colour_code: string }[] : [];
    const needs = new Map<string, Awaited<ReturnType<typeof prod.cutNeeds>>>();
    for (const o of orders) if (o.kind === 'cut' && (o.status === 'draft' || o.status === 'issued')) needs.set(o.id, await prod.cutNeeds(db, o.id));
    let suggest = new Map<string, number>();
    if (await can(db, uid(), 'plan.view', ANY)) { const p = await plan.computePlan(db, uid()); suggest = new Map(p.skus.map((k) => [k.sku_id, k.rows[0]?.production ?? 0])); }
    return { orders, lots, vendors, fabrics, styles, styleId, skus, needs, suggest, create: await can(db, uid(), 'production.create', ANY), issue: await can(db, uid(), 'production.issue', ANY), done: await can(db, uid(), 'production.complete', ANY) };
  });
  if (!d) return denied('Work orders', 'Finishing, shade lots and cutting.', 'Your role cannot see work orders.');
  const tab = (id: typeof st.tab, label: string, n?: number) => html`<button class="${st.tab === id ? 'on' : ''}" data-act="wk-tab" data-id="${id}">${label}${n ? html` <span class="grp-n">${n}</span>` : ''}</button>`;
  const live = d.orders.filter((o) => o.status === 'draft' || o.status === 'issued').length;
  const body = st.tab === 'orders' ? ordersTab(d) : st.tab === 'finish' ? finishTab(d) : st.tab === 'cut' ? cutTab(d) : shadeTab(d);
  return html`${head('Work orders', 'Raw fabric goes for finishing, comes back as finished fabric, is split by shade, then cut into pieces. Everything that comes back goes through quality control before it can be used or sold.')}
  <div class="tabs">${tab('orders', 'Orders', live)}${d.create ? tab('finish', 'Send for finishing') : ''}${d.create ? tab('cut', 'Cut pieces') : ''}${d.done ? tab('shade', 'Shade lots') : ''}</div>${body}`;
}
type D = NonNullable<Awaited<ReturnType<typeof loadD>>>;
declare function loadD(): Promise<{ orders: WO[]; lots: { id: string; label: string; code: string; name: string; unit: string; free: number; attributes: Record<string, unknown> }[]; vendors: { id: string; code: string; name: string }[]; fabrics: { id: string; code: string; name: string }[]; styles: { id: string; code: string; name: string }[]; styleId: string; skus: { id: string; code: string; size: string; colour_code: string }[]; needs: Map<string, Awaited<ReturnType<typeof prod.cutNeeds>>>; suggest: Map<string, number>; create: boolean; issue: boolean; done: boolean }>;

function ordersTab(d: D): Raw {
  if (!d.orders.length) return html`<section class="card"><p class="empty">No work orders yet. Send a fabric roll for finishing, or cut pieces for a style.</p></section>`;
  return html`${d.orders.map((o) => {
    const inp = o.lines.find((l) => l.role === 'input'); const out = o.lines.find((l) => l.role === 'output');
    const skus = o.lines.filter((l) => l.role === 'sku');
    const needs = d.needs.get(o.id);
    return html`<section class="card"><div class="row between"><h2>${o.number} <span class="chip ${tone[o.status]}">${o.status}</span> <small>${o.kind === 'finish' ? 'Finishing' : 'Cutting ' + (o.style ?? '')}</small></h2><span class="sub">${o.kind === 'finish' ? (o.processor ?? 'In-house') : o.creator} · ${dateOnly(o.created_at)}</span></div>
      ${o.kind === 'finish' && inp ? html`<p>${mono(inp.code)} roll ${inp.lot} · <b>${inp.planned}</b> ${inp.unit} → <b>${o.out_code}</b> · ${o.finish_name}${o.colour ? ' · ' + o.colour : ''}${out ? html` · came back <b>${out.actual}</b> ${out.unit} (loss ${(inp.planned - (out.actual ?? 0)).toFixed(2)} ${out.unit}, ${(((inp.planned - (out.actual ?? 0)) / inp.planned) * 100).toFixed(1)}%)` : ''}</p>` : ''}
      ${o.kind === 'cut' ? html`<div class="scroll"><table class="mini"><thead><tr><th>SKU</th><th class="r">Planned</th><th class="r">${o.status === 'issued' ? 'Actually cut' : 'Cut'}</th></tr></thead><tbody>${skus.map((l) => html`<tr><td>${mono(l.code)}</td><td class="r">${l.planned}</td><td class="r">${o.status === 'issued' ? html`<input class="num" style="width:76px" inputmode="numeric" data-actual="${l.sku_id}" value="${l.planned}" />` : l.actual ?? '–'}</td></tr>`)}</tbody></table></div>
        ${needs ? html`<details><summary>Materials this order takes (${needs.length})</summary><table class="mini"><tbody>${needs.map((n) => html`<tr><td>${mono(n.code)} ${n.name}${n.colour ? ' · ' + n.colour : ''}</td><td class="r">${n.qty.toLocaleString('en-IN')} ${n.unit}</td></tr>`)}</tbody></table></details>` : ''}
        ${o.status === 'completed' ? (() => { const p = skus.reduce((a, l) => a + l.planned, 0), a = skus.reduce((x, l) => x + (l.actual ?? 0), 0); return html`<p class="note ${a < p ? 'warn-t' : ''}">${a} of ${p} pieces cut (${p ? Math.round((a / p) * 1000) / 10 : 0}%). ${a < p ? (p - a) + ' short. The production plan picks the shortfall up again.' : ''}</p>`; })() : ''}` : ''}
      ${o.notes ? html`<p class="note">${o.notes}</p>` : ''}${o.cancel_reason ? html`<p class="note warn-t">Cancelled: ${o.cancel_reason}</p>` : ''}
      <div class="row">
        ${o.status === 'draft' && d.issue ? html`<button class="primary" data-act="${o.kind === 'finish' ? 'wk-issue-f' : 'wk-issue-c'}" data-id="${o.id}" data-v="${o.version}">${o.kind === 'finish' ? 'Send the fabric out' : 'Issue materials to cutting'}</button>` : ''}
        ${o.status === 'issued' && o.kind === 'finish' && d.done ? html`<label class="inline">Received <input id="wk-rq-${o.id}" class="num" style="width:90px" inputmode="decimal" value="${inp?.planned ?? ''}" /> ${inp?.unit}</label><button class="primary" data-act="wk-recv" data-id="${o.id}" data-v="${o.version}">Receive finished fabric</button>` : ''}
        ${o.status === 'issued' && o.kind === 'cut' && d.done ? html`<button class="primary" data-act="wk-comp" data-id="${o.id}" data-v="${o.version}">Record pieces cut</button>` : ''}
        ${o.status === 'draft' && d.create ? html`<input id="wk-why-${o.id}" placeholder="Reason to cancel" style="width:180px" /><button data-act="wk-cancel" data-id="${o.id}" data-v="${o.version}">Cancel</button>` : ''}
      </div></section>`; })}`;
}

function finishTab(d: D): Raw {
  return html`<section class="card"><h2>Send fabric for finishing</h2><p class="sub">Pick a roll that has passed quality control. It can be finished in your own unit, or sent to a job-work vendor. The finished fabric comes back on hold until quality control passes it.</p>
    ${d.lots.length ? html`<form data-form="wk-finish" class="grid2">
      <label>Roll<select id="wk-lot">${opts(d.lots.map((l) => ({ id: l.id, label: `${l.code} · ${l.label} · ${l.free} ${l.unit} free` })))}</select></label>
      <label>Quantity to send<input id="wk-fq" inputmode="decimal" placeholder="e.g. 600" /></label>
      <label>Becomes (finished fabric)<select id="wk-out">${opts(d.fabrics.map((f) => ({ id: f.id, label: `${f.code} · ${f.name}` })))}</select></label>
      <label>Finish<input id="wk-finish" placeholder="Dyed black, peach finish, enzyme wash…" /></label>
      <label>Colour code<input id="wk-fcol" placeholder="BLK (optional)" /></label>
      <label>Who finishes it<select id="wk-proc">${opts(d.vendors.map((v) => ({ id: v.id, label: v.name })), '', 'Our own unit')}</select></label>
      <div class="row"><button class="primary" type="submit">Make finishing order</button></div></form>` : html`<p class="empty">No accepted fabric is free to send. Receive fabric and pass quality control first.</p>`}</section>`;
}

function cutTab(d: D): Raw {
  if (!d.styles.length) return html`<section class="card"><p class="empty">No style has an approved BOM yet.</p></section>`;
  return html`<section class="card"><h2>Cut pieces</h2><p class="sub">Choose a style and how many of each SKU to cut. The suggestion is this month's production from the plan. Materials come from accepted stock, fabric by colour and shade.</p>
    <label class="inline">Style <select id="wk-style" data-wk="style">${opts(d.styles.map((s) => ({ id: s.id, label: `${s.code} · ${s.name}` })), d.styleId)}</select></label>
    <form data-form="wk-cut"><div class="scroll"><table class="mini"><thead><tr><th>SKU</th><th class="r">Plan says</th><th class="r">Cut</th></tr></thead><tbody>${d.skus.map((k) => { const s = d.suggest.get(k.id) ?? 0; return html`<tr><td>${mono(k.code)}</td><td class="r">${s || '–'}</td><td class="r"><input class="num" style="width:84px" inputmode="numeric" data-cutq="${k.id}" value="${s || ''}" /></td></tr>`; })}</tbody></table></div>
      <label>Note<input id="wk-cnote" placeholder="optional" /></label><div class="row"><button class="primary" type="submit">Make cutting order</button></div></form></section>`;
}

function shadeTab(d: D): Raw {
  const sel = st.splitLot || d.lots[0]?.id || ''; const lot = d.lots.find((l) => l.id === sel);
  return html`<section class="card"><h2>Split a roll into shade lots</h2><p class="sub">After quality control the same fabric often comes in more than one shade. Split it so each colour is cut from fabric that matches. The parts need not use the whole roll.</p>
    ${d.lots.length ? html`<label class="inline">Lot <select id="wk-slot" data-wk="slot">${opts(d.lots.map((l) => ({ id: l.id, label: `${l.code} · ${l.label} · ${l.free} ${l.unit} free` })), sel)}</select></label>
    <form data-form="wk-split"><div class="scroll"><table class="mini"><thead><tr><th>Shade</th><th>Colour code</th><th class="r">Quantity (${lot?.unit})</th></tr></thead><tbody>${Array.from({ length: st.parts }, (_, i) => html`<tr><td><input id="wk-sh-${i}" style="width:70px" placeholder="${'ABCDEF'[i]}" value="${'ABCDEF'[i]}" /></td><td><input id="wk-sc-${i}" style="width:90px" placeholder="BLK" /></td><td class="r"><input id="wk-sq-${i}" class="num" style="width:100px" inputmode="decimal" /></td></tr>`)}</tbody></table></div>
      <div class="row"><button type="button" data-act="wk-more">Add a shade</button><button class="primary" type="submit">Split</button></div></form>` : html`<p class="empty">No accepted fabric to split.</p>`}</section>`;
}

const nz = (id: string) => val(id) || undefined;
export async function onClick(t: HTMLElement): Promise<boolean> {
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b || !b.dataset.act?.startsWith('wk-')) return false;
  const id = b.dataset.id ?? ''; const v = Number(b.dataset.v);
  const done = async () => { await R.render(); return true; };
  switch (b.dataset.act) {
    case 'wk-tab': st.tab = id as typeof st.tab; return done();
    case 'wk-more': if (st.parts < 6) st.parts++; return done();
    case 'wk-issue-f': await act('Fabric sent out', (c) => prod.issueFinish(c, { woId: id, expectedVersion: v })); return true;
    case 'wk-issue-c': await act('Materials issued to cutting', (c) => prod.issueCut(c, { woId: id, expectedVersion: v })); return true;
    case 'wk-recv': {
      const r = await act('Finished fabric received. It is on quality-control hold', (c) => prod.receiveFinish(c, { woId: id, expectedVersion: v, qty: val('wk-rq-' + id) }));
      if (r) toast(`Received. Loss ${r.loss} (${r.lossPct}%). Waiting for quality control`); return true;
    }
    case 'wk-comp': {
      const actual = [...document.querySelectorAll('input[data-actual]')].map((i) => ({ skuId: (i as HTMLInputElement).dataset.actual!, qty: Number((i as HTMLInputElement).value || 0) }));
      const r = await act('Pieces recorded. They are on quality-control hold', (c) => prod.completeCut(c, { woId: id, expectedVersion: v, actual }));
      if (r) toast(r.shortfall ? `${r.actual} of ${r.planned} cut. ${r.shortfall} short goes back to the plan` : `All ${r.actual} pieces cut`); return true;
    }
    case 'wk-cancel': await act('Order cancelled', (c) => prod.cancelWorkOrder(c, { woId: id, expectedVersion: v, reason: val('wk-why-' + id) })); return true;
  }
  return false;
}
export async function onSubmit(form: string): Promise<boolean> {
  switch (form) {
    case 'wk-finish': {
      const r = await act('Finishing order made', (c) => prod.createFinishOrder(c, { lotId: val('wk-lot'), qty: val('wk-fq'), outItemId: val('wk-out'), processorId: val('wk-proc') || null, finishName: val('wk-finish'), colour: nz('wk-fcol') }));
      if (r) { st.tab = 'orders'; await R.render(); } return true;
    }
    case 'wk-cut': {
      const lines = [...document.querySelectorAll('input[data-cutq]')].map((i) => ({ skuId: (i as HTMLInputElement).dataset.cutq!, qty: Number((i as HTMLInputElement).value || 0) })).filter((l) => l.qty > 0);
      const r = await act('Cutting order made', (c) => prod.createCutOrder(c, { siteId: K.world.siteId, styleId: st.style || val('wk-style'), lines, notes: nz('wk-cnote') }));
      if (r) { st.tab = 'orders'; await R.render(); } return true;
    }
    case 'wk-split': {
      const parts = Array.from({ length: st.parts }, (_, i) => ({ qty: val('wk-sq-' + i), shade: val('wk-sh-' + i), colour: nz('wk-sc-' + i) })).filter((p) => p.qty);
      const r = await act('Shade lots made', (c) => prod.splitLot(c, { lotId: st.splitLot || val('wk-slot'), parts }));
      if (r) { st.parts = 2; await R.render(); } return true;
    }
  }
  return false;
}
export async function onChange(t: HTMLInputElement): Promise<boolean> {
  if (t.dataset.wk === 'style') { st.style = t.value; await R.render(); return true; }
  if (t.dataset.wk === 'slot') { st.splitLot = t.value; await R.render(); return true; }
  return false;
}
void chip;
