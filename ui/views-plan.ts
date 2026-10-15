import { html, raw, qty, chip, dateOnly, type Raw } from './lib.js';
import { S, uid, read, val, act, head, denied, R, opts, toast } from './ctx.js';
import * as plan from '../src/domain/planning.js';
import { can } from '../src/core/permissions.js';

const ANY = { anySite: true } as const;
const st = { tab: 'plan' as 'plan' | 'requests' | 'minimums', sel: '', showIdle: false, matSel: '', within: '30' };
const rs = (n: number | null | undefined) => (n == null ? '–' : '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 }));
const mlabel = (m: string) => new Date(m + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
const f = (v: number) => (v === 0 ? '–' : v.toLocaleString('en-IN', { maximumFractionDigits: v < 10 ? 2 : 0 }));

export async function planningView(): Promise<Raw> {
  const d = await read(async (db) => {
    if (!(await can(db, uid(), 'plan.view', ANY))) return null;
    const p = await plan.computePlan(db, uid());
    const reqs = await plan.listRequests(db, uid());
    const vendors = (await db.query(`SELECT id, code, name FROM partner WHERE is_vendor AND status='active' ORDER BY name`)).rows as { id: string; code: string; name: string }[];
    const fabrics = (await db.query(`SELECT id, code, name FROM item WHERE kind='FABRIC' AND status='active' ORDER BY code`)).rows as { id: string; code: string; name: string }[];
    const styles = (await db.query(`SELECT id, code, name, cutting_yield_pct::float AS y FROM product_style ORDER BY code`)).rows as { id: string; code: string; name: string; y: number }[];
    const plans = new Map<string, Record<string, unknown>>((await db.query('SELECT * FROM item_plan')).rows.map((r) => [r.item_id, r]));
    return { p, alerts: await plan.planAlerts(db, uid()), reqs, vendors, fabrics, styles, plans, manage: await can(db, uid(), 'plan.manage', ANY), convert: await can(db, uid(), 'po.create', ANY) };
  });
  if (!d) return denied('Production plan', 'Six months ahead: what to make and what to buy.', 'Your role cannot see the production plan.');
  const tab = (id: typeof st.tab, label: string, n?: number) => html`<button class="${st.tab === id ? 'on' : ''}" data-act="pn-tab" data-id="${id}">${label}${n ? html` <span class="grp-n">${n}</span>` : ''}</button>`;
  const open = d.reqs.filter((r: { status: string }) => r.status === 'open').length;
  const tabs = html`<div class="tabs">${tab('plan', 'Plan')}${tab('requests', 'Purchase requests', open)}${tab('minimums', 'Minimums and settings')}</div>`;
  return html`${head('Production plan', `Next ${d.p.months.length} months from ${dateOnly(d.p.asOf)}. Pieces to make keep finished stock above its minimum; materials are bought so they never fall below theirs.`, d.manage ? html`<button class="primary" data-act="pn-run">Run the plan now</button>` : undefined)}${alertsCard(d.alerts)}${tabs}${st.tab === 'plan' ? planTab(d) : st.tab === 'requests' ? requestsTab(d) : minimumsTab(d)}`;
}
const alertsCard = (a: Awaited<ReturnType<typeof plan.planAlerts>>): Raw => {
  const n = a.skus.length + a.materials.length + a.late.length;
  if (!n && !a.openRequests) return html`<section class="card"><p class="note">Everything is at or above its minimum, and nothing is waiting for the buyer.</p></section>`;
  return html`<section class="card"><h2>Needs attention</h2><ul class="plain">
    ${a.openRequests ? html`<li>${a.openRequests} purchase request${a.openRequests > 1 ? 's are' : ' is'} waiting for the buyer.</li>` : ''}
    ${a.late.length ? html`<li class="warn-t">${a.late.length} purchase${a.late.length > 1 ? 's are' : ' is'} already late for the lead time: ${a.late.slice(0, 4).map((l) => l.code).join(', ')}${a.late.length > 4 ? '…' : ''}</li>` : ''}
    ${a.skus.length ? html`<li>${a.skus.length} SKU${a.skus.length > 1 ? 's are' : ' is'} under the minimum with nothing being cut: ${a.skus.slice(0, 5).map((k) => k.code).join(', ')}${a.skus.length > 5 ? '…' : ''}</li>` : ''}
    ${a.materials.length ? html`<li>${a.materials.length} material${a.materials.length > 1 ? 's are' : ' is'} under the minimum even with what is on order: ${a.materials.slice(0, 5).map((m) => m.code).join(', ')}${a.materials.length > 5 ? '…' : ''}</li>` : ''}</ul></section>`;
};
type D = NonNullable<Awaited<ReturnType<typeof load>>>;
declare function load(): Promise<{ p: Awaited<ReturnType<typeof plan.computePlan>>; reqs: Awaited<ReturnType<typeof plan.listRequests>>; vendors: { id: string; code: string; name: string }[]; fabrics: { id: string; code: string; name: string }[]; styles: { id: string; code: string; name: string; y: number }[]; plans: Map<string, Record<string, unknown>>; manage: boolean; convert: boolean } | null>;

function planTab(d: D): Raw {
  const p = d.p; const live = p.skus.filter((k) => st.showIdle || !k.idle);
  const sel = st.matSel ? p.materials.find((m) => m.item_id === st.matSel) : null;
  return html`<section class="card crm-sum"><div class="crm-k"><span>Pieces to make</span><b>${p.totals.pieces.toLocaleString('en-IN')}</b></div><div class="crm-k"><span>Materials to buy</span><b>${p.totals.buy_lines} lines</b></div><div class="crm-k"><span>Estimated buying</span><b>${rs(p.totals.buy_cost)}</b></div><div class="crm-k"><span>Already late</span><b class="${p.totals.late ? 'bad-t' : ''}">${p.totals.late}</b></div></section>
  ${p.warnings.length ? html`<section class="card"><ul class="plain">${p.warnings.map((w) => html`<li class="warn-t">${w}</li>`)}</ul></section>` : ''}
  <section class="card"><div class="row between"><h2>Pieces to make</h2><label class="chk"><input type="checkbox" id="pn-idle" ${st.showIdle ? raw('checked') : ''} /> show SKUs with no sales</label></div>
    <p class="sub">Each month: sales plus the minimum stock, less what is already in hand. The first month also builds up the minimum.</p>
    ${live.length ? html`<div class="scroll"><table class="mini"><thead><tr><th>SKU</th><th class="r">In stock</th><th class="r">Sales / month</th><th class="r">Minimum</th>${p.months.map((m) => html`<th class="r">${mlabel(m)}</th>`)}<th class="r">Total</th></tr></thead><tbody>${live.map((k) => html`<tr><td class="mono">${k.code}</td><td class="r">${f(k.on_hand)}</td><td class="r">${f(k.avg_demand)}</td><td class="r">${f(k.min)}</td>${k.rows.map((r) => html`<td class="r" title="Sales ${r.demand}, opening ${r.opening}, closing ${r.closing}">${f(r.production)}</td>`)}<td class="r"><b>${f(k.pieces)}</b></td></tr>`)}</tbody></table></div>` : html`<p class="empty">No SKU has sales yet. Set expected sales on the Minimums tab, or confirm sales orders for SKUs.</p>`}</section>
  <section class="card"><h2>Materials</h2><p class="sub">Need for the pieces above (with wastage and cutting loss), and what must be bought to stay above each minimum. Click a material for the month-by-month balance.</p>
    ${p.materials.length ? html`<div class="scroll"><table class="mini"><thead><tr><th>Material</th><th class="r">In stock</th><th class="r">On order</th><th class="r">Minimum</th>${p.months.map((m) => html`<th class="r">${mlabel(m)}<br /><small>need / buy</small></th>`)}<th class="r">To buy</th></tr></thead><tbody>${p.materials.map((m) => html`<tr class="pick ${m.item_id === st.matSel ? 'on' : ''}" tabindex="0" data-act="pn-mat" data-id="${m.item_id}"><td><span class="mono">${m.code}</span> ${m.name}${m.make ? html`<br /><small>made from grey fabric, ${m.finish_loss_pct}% lost in finishing</small>` : ''}</td><td class="r">${f(m.on_hand)}</td><td class="r">${f(m.on_order)}</td><td class="r">${f(m.min)}</td>${m.rows.map((r) => html`<td class="r">${f(r.need)}${r.buy ? html`<br /><b class="warn-t">${f(r.buy)}</b>` : ''}</td>`)}<td class="r"><b>${f(m.buy_total)}</b> <small>${m.make ? 'to make' : m.unit}</small></td></tr>`)}</tbody></table></div>` : html`<p class="empty">Nothing to buy yet.</p>`}
    ${sel ? html`<h3>${sel.code} month by month <small>(lead time ${sel.lead_days} days${sel.vendor ? ', ' + sel.vendor : ''})</small></h3><div class="scroll"><table class="mini"><thead><tr><th></th>${p.months.map((m) => html`<th class="r">${mlabel(m)}</th>`)}</tr></thead><tbody>
      ${(['opening', 'receipts', 'need', 'buy', 'closing'] as const).map((k) => html`<tr><td>${{ opening: 'Opening stock', receipts: 'Arriving (orders and requests)', need: 'Needed for production', buy: sel.make ? 'To make' : 'To buy', closing: 'Closing stock' }[k]}</td>${sel.rows.map((r) => html`<td class="r">${f(r[k])}</td>`)}</tr>`)}</tbody></table></div>` : ''}</section>`;
}

function requestsTab(d: D): Raw {
  const rows = d.reqs as { id: string; number: string; status: string; note: string | null; version: number; vendor: string | null; partner_id: string | null; po_number: string | null; po_id: string | null; creator: string; lines: { code: string; name: string; qty: number; unit: string; needed_by: string; order_by: string; est_rate: number | null; reason: string | null }[] }[];
  const tone: Record<string, string> = { open: 'warn', converted: 'ok', cancelled: 'neutral' };
  return html`${d.manage ? html`<section class="card"><div class="row"><label class="inline">Ask for everything that has to be ordered within the next <input id="pn-within" class="num" inputmode="numeric" value="${st.within}" style="width:64px" /> days</label><button class="primary" data-act="pn-gen">Raise purchase requests now</button></div>
    <p class="note">One request per vendor. What an open request already covers is not asked for again, so this is safe to run any time. In a live installation it runs on a daily schedule.</p></section>` : ''}
  ${rows.length ? rows.map((r) => html`<section class="card"><div class="row between"><h2>${r.number} <span class="chip ${tone[r.status]}">${r.status}</span></h2><span class="sub">${r.vendor ?? 'No vendor chosen'}${r.po_number ? ' · ' + r.po_number : ''} · raised by ${r.creator}</span>${r.po_id ? html`<button data-act="pn-openpo" data-id="${r.po_id}">Open ${r.po_number}</button>` : ''}</div>
    ${r.note ? html`<p class="note warn-t">${r.note}</p>` : ''}
    <div class="scroll"><table class="mini"><thead><tr><th>Material</th><th class="r">Quantity</th><th>Needed by</th><th>Order by</th><th class="r">Est. price</th></tr></thead><tbody>${r.lines.map((l) => html`<tr><td><span class="mono">${l.code}</span> ${l.name}<br /><small>${l.reason ?? ''}</small></td><td class="r">${qty(String(l.qty))} ${l.unit}</td><td>${dateOnly(l.needed_by)}</td><td class="${l.order_by < d.p.asOf ? 'bad-t' : ''}">${dateOnly(l.order_by)}${l.order_by < d.p.asOf ? ' (already late)' : ''}</td><td class="r">${l.est_rate == null ? '–' : rs(l.qty * l.est_rate)}</td></tr>`)}</tbody></table></div>
    ${r.status === 'open' ? html`<div class="row">${d.convert && r.partner_id ? html`<button class="primary" data-act="pn-convert" data-id="${r.id}" data-v="${r.version}">Make a draft purchase order</button>` : ''}${!r.partner_id ? html`<small class="sub">Give these materials a vendor price or a preferred vendor, then raise the requests again.</small>` : ''}${d.manage ? html`<input id="pn-reason-${r.id}" placeholder="Reason to cancel" style="min-width:180px" /><button data-act="pn-cancel" data-id="${r.id}" data-v="${r.version}">Cancel request</button>` : ''}</div>` : ''}</section>`) : html`<section class="card"><p class="empty">No purchase requests yet.</p></section>`}`;
}

function minimumsTab(d: D): Raw {
  const p = d.p; const s = p.settings;
  const sel = st.sel; const k = p.skus.find((x) => x.item_id === sel); const m = p.materials.find((x) => x.item_id === sel);
  const ip = (id: string) => d.plans.get(id) ?? {}; const v = (x: unknown) => (x == null ? '' : String(Number(x)));
  const form = !d.manage || !sel || (!k && !m) ? '' : html`<form class="card form" data-form="pn-item"><h2>${k ? k.code : m!.code} · planning figures</h2><p class="sub">Leave a box empty to use the company setting.</p>
    <div class="grid2">${k ? html`<label>Expected sales per month (pieces)<input id="pn-demand" inputmode="decimal" value="${v(ip(k.item_id).monthly_demand)}" placeholder="average of last ${s.sales_months} months: ${f(k.avg_demand)}" /></label>` : ''}
    <label>Minimum stock${k ? ' (pieces)' : ' (' + m!.unit + ')'}<input id="pn-min" inputmode="decimal" value="${v(ip(sel).manual_min)}" placeholder="calculated: ${f(k ? k.min : m!.min)}" /></label>
    <label>Days of cover<input id="pn-cover" inputmode="numeric" value="${v(ip(sel).cover_days)}" placeholder="${s.cover_days}" /></label>
    ${m ? html`<label>Lead time (days)<input id="pn-lead" inputmode="numeric" value="${v(ip(sel).lead_days)}" placeholder="${s.lead_days}" /></label>
    <label>Preferred vendor<select id="pn-vendor">${opts(d.vendors.map((x) => ({ id: x.id, label: x.name })), (ip(sel).preferred_vendor_id as string) ?? '', 'Cheapest approved price')}</select></label>
    ${m.kind === 'FABRIC' ? html`<label>Made from grey fabric<select id="pn-grey">${opts(d.fabrics.filter((x) => x.id !== sel).map((x) => ({ id: x.id, label: `${x.code} · ${x.name}` })), (ip(sel).grey_item_id as string) ?? '', 'Bought as it is')}</select></label><label>Lost in finishing (%)<input id="pn-loss" inputmode="decimal" value="${v(ip(sel).finish_loss_pct)}" /></label>` : ''}` : ''}</div>
    <div class="row"><button class="primary" type="submit">Save</button><button type="button" data-act="pn-pick" data-id="">Close</button></div></form>
    ${k ? html`<form class="card form" data-form="pn-month"><h3>Planned sales for one month</h3><p class="sub">Replaces the average for that month only (for a season or an order you already know).</p><div class="row"><select id="pn-mm">${opts(p.months.map((x) => ({ id: x, label: mlabel(x) })))}</select><input id="pn-mq" inputmode="decimal" placeholder="pieces (empty clears)" /><button type="submit">Set</button></div></form>` : ''}`;
  return html`${d.manage ? html`<form class="card form" data-form="pn-settings"><h2>Company settings</h2><div class="grid2">
    <label>Months of sales to average<input id="ps-months" inputmode="numeric" value="${s.sales_months}" /></label><label>Days of cover for minimum stock<input id="ps-cover" inputmode="numeric" value="${s.cover_days}" /></label>
    <label>Usual vendor lead time (days)<input id="ps-lead" inputmode="numeric" value="${s.lead_days}" /></label><label>Months to plan<input id="ps-horizon" inputmode="numeric" value="${s.horizon_months}" /></label></div>
    <p class="sub">Minimum stock = average monthly sales × days of cover ÷ 30. A figure typed for one item wins when it is higher.</p><div class="row"><button class="primary" type="submit">Save settings</button></div></form>
  <form class="card form" data-form="pn-yield"><h2>Cutting yield</h2><p class="sub">One style has several sizes, so cutting never uses all the fabric. 92 means 8 metres in 100 are lost. Fabric need is divided by this.</p>
    <div class="scroll"><table class="mini"><tbody>${d.styles.map((x) => html`<tr><td class="mono">${x.code}</td><td>${x.name}</td><td class="r"><input class="num" data-yield="${x.id}" inputmode="decimal" value="${x.y}" style="width:80px" aria-label="Cutting yield percent for ${x.code}" /> %</td></tr>`)}</tbody></table></div><div class="row"><button class="primary" type="submit">Save yields</button></div></form>` : ''}
  ${form}
  <section class="card"><h2>Finished pieces</h2><div class="scroll"><table class="mini"><thead><tr><th>SKU</th><th class="r">Sales / month</th><th class="r">Cover (days)</th><th class="r">Minimum</th><th class="r">In stock</th></tr></thead><tbody>${p.skus.map((x) => html`<tr class="pick ${x.item_id === sel ? 'on' : ''}" tabindex="0" data-act="pn-pick" data-id="${x.item_id}"><td class="mono">${x.code}</td><td class="r">${f(x.avg_demand)}${x.monthly_demand != null ? ' ✎' : ''}</td><td class="r">${x.cover_days}</td><td class="r">${f(x.min)}${x.manual_min != null ? ' ✎' : ''}</td><td class="r">${f(x.on_hand)}</td></tr>`)}</tbody></table></div></section>
  <section class="card"><h2>Materials</h2><div class="scroll"><table class="mini"><thead><tr><th>Material</th><th class="r">Avg use / month</th><th class="r">Minimum</th><th class="r">Lead (days)</th><th>Vendor</th></tr></thead><tbody>${p.materials.map((x) => html`<tr class="pick ${x.item_id === sel ? 'on' : ''}" tabindex="0" data-act="pn-pick" data-id="${x.item_id}"><td><span class="mono">${x.code}</span> ${x.name}</td><td class="r">${f(x.avg_use)} ${x.unit}</td><td class="r">${f(x.min)}${x.manual_min != null ? ' ✎' : ''}</td><td class="r">${x.lead_days}</td><td>${x.make ? 'made in finishing' : x.vendor ?? html`<span class="warn-t">none</span>`}</td></tr>`)}</tbody></table></div><p class="note">✎ marks a figure typed by hand.</p></section>`;
}

// ───────────── events ─────────────
const done = async () => { await R.render(); return true; };
const ver = (table: string, id: string) => read(async (db) => (await db.query(`SELECT version FROM ${table} WHERE id=$1`, [id])).rows[0].version as number);
const nz = (id: string) => { const x = val(id); return x === '' ? null : x; };
const nzi = (id: string) => { const x = val(id); return x === '' ? null : Number(x); };

export async function onClick(t: HTMLElement): Promise<boolean> {
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b || !b.dataset.act?.startsWith('pn-')) return false;
  const id = b.dataset.id ?? '';
  switch (b.dataset.act) {
    case 'pn-tab': st.tab = id as typeof st.tab; return done();
    case 'pn-mat': st.matSel = st.matSel === id ? '' : id; return done();
    case 'pn-pick': st.sel = st.sel === id ? '' : id; return done();
    case 'pn-run': {
      const w = Number(val('pn-within') || st.within) || 30;
      const r = await act('Plan run', (c) => plan.runPlan(c, { withinDays: w }));
      if (r) { toast(`${r.requests.length} purchase request${r.requests.length === 1 ? '' : 's'} raised, ${r.cutting.length} cutting order${r.cutting.length === 1 ? '' : 's'} drafted${r.cutting.length ? '. Find them under Work orders' : ''}`); await R.render(); }
      return true;
    }
    case 'pn-openpo': S.poId = id; S.view = 'po'; history.replaceState(null, '', '#po'); return done();
    case 'pn-gen': {
      const w = Number(val('pn-within') || st.within); st.within = String(w);
      const r = await act('Requests raised', (c) => plan.generateRequests(c, { withinDays: w }));
      if (r) { toast(r.requests.length ? `${r.requests.length} request${r.requests.length > 1 ? 's' : ''} raised for ${r.lines} line${r.lines > 1 ? 's' : ''}. ${r.later ? r.later + ' more later' : ''}` : r.later ? `Nothing to order in the next ${w} days. ${r.later} line${r.later > 1 ? 's' : ''} later` : 'Nothing new to ask for. Everything is covered'); st.tab = 'requests'; await R.render(); }
      return true;
    }
    case 'pn-convert': { const r = await act('Draft purchase order made. Find it under Purchase orders', (c) => plan.convertRequest(c, { requestId: id, expectedVersion: Number(b.dataset.v) })); void r; return true; }
    case 'pn-cancel': await act('Request cancelled', (c) => plan.cancelRequest(c, { requestId: id, expectedVersion: Number(b.dataset.v), reason: val('pn-reason-' + id) })); return true;
  }
  return false;
}
export async function onSubmit(form: string): Promise<boolean> {
  switch (form) {
    case 'pn-settings': await act('Settings saved', (c) => plan.updateSettings(c, { salesMonths: Number(val('ps-months')), coverDays: Number(val('ps-cover')), leadDays: Number(val('ps-lead')), horizonMonths: Number(val('ps-horizon')) })); return true;
    case 'pn-yield': {
      const rows = [...document.querySelectorAll('input[data-yield]')] as HTMLInputElement[];
      await act('Cutting yields saved', async (c) => { for (const r of rows) await plan.setCuttingYield(c, { styleId: r.dataset.yield!, yieldPct: Number(r.value) }); });
      return true;
    }
    case 'pn-item': {
      const sel = st.sel; const isSku = !!document.getElementById('pn-demand');
      await act('Saved', (c) => plan.setItemPlan(c, { itemId: sel, manualMin: nz('pn-min'), coverDays: nzi('pn-cover'), monthlyDemand: isSku ? nz('pn-demand') : null, ...(isSku ? {} : { leadDays: nzi('pn-lead'), preferredVendorId: val('pn-vendor') || null, greyItemId: val('pn-grey') || null, finishLossPct: nz('pn-loss') }) }));
      return true;
    }
    case 'pn-month': await act('Planned sales set', (c) => plan.setDemand(c, { itemId: st.sel, month: val('pn-mm'), qty: nz('pn-mq') })); return true;
  }
  return false;
}
export async function onChange(t: HTMLInputElement): Promise<boolean> {
  if (t.id === 'pn-idle') { st.showIdle = t.checked; await R.render(); return true; }
  return false;
}
void S; void chip; void ver;
