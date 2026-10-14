import { html, raw, money, qty, when, chip, dateOnly, type Raw } from './lib.js';
import { K, S, uid, read, val, act, head, denied, R, opts, toast, todayIso, addDays } from './ctx.js';
import * as sales from '../src/domain/sales.js';
import { can } from '../src/core/permissions.js';

const st = { lead: '', quote: '', order: '', tab: 'board' as 'board' | 'list' };
const open = new Set<string>();
const toggle = (k: string) => (open.has(k) ? open.delete(k) : open.add(k));
const COLS: [string, string][] = [['new', 'New'], ['contacted', 'Contacted'], ['qualified', 'Qualified'], ['quoted', 'Quoted'], ['won', 'Won'], ['lost', 'Lost']];
const nf = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
const inr = (n: number) => '₹' + nf(n);

// ───────────── CRM ─────────────
export async function crmView(): Promise<Raw> {
  const d = await read(async (db) => ({
    data: await sales.listLeads(db, uid()), manage: await can(db, uid(), 'crm.manage', { anySite: true }),
    sel: st.lead ? await sales.getLead(db, uid(), st.lead).catch(() => null) : null,
  }));
  if (!d.data) return denied('CRM', 'Leads and follow-ups.', 'Your role cannot see the sales pipeline.');
  const { leads, todo } = d.data;
  const by = (s: string) => leads.filter((l) => l.status === s);
  const valueOf = (rows: typeof leads) => rows.reduce((a, l) => a + Number(l.est_value), 0);
  const openLeads = leads.filter((l) => !['won', 'lost'].includes(l.status));
  const card = (l: (typeof leads)[number]) => html`<button class="lead ${l.id === st.lead ? 'on' : ''} ${l.overdue ? 'od' : ''}" data-act="ld-pick" data-id="${l.id}"><b>${l.company || l.name}</b><small>${l.company ? l.name : ''}</small>
    <span class="lv">${Number(l.est_value) ? inr(Number(l.est_value)) : ''}</span>${l.next_follow_up ? html`<small class="${l.overdue ? 'bad-t' : ''}">${l.overdue ? 'Overdue · ' : 'Follow up '}${dateOnly(String(l.next_follow_up).slice(0, 10))}</small>` : ''}</button>`;
  const total = valueOf(openLeads) || 1;
  const sel = d.sel;
  return html`${head('CRM', 'Every enquiry from first call to a won order, and what to do next.', d.manage ? html`<button class="primary" data-act="ld-new">New lead</button>` : undefined)}
  <section class="card crm-sum"><div class="crm-k"><span>Open leads</span><b>${openLeads.length}</b></div><div class="crm-k"><span>Pipeline value</span><b>${inr(valueOf(openLeads))}</b></div><div class="crm-k"><span>Follow-ups due</span><b class="${todo.some((t) => t.overdue) ? 'bad-t' : ''}">${todo.length}</b></div><div class="crm-k"><span>Won</span><b>${by('won').length}</b></div>
    <div class="crm-bar" role="img" aria-label="Pipeline value by stage">${COLS.slice(0, 4).map(([k], i) => `<i class="s${i}" style="flex:${Math.max(0.0001, valueOf(by(k)) / total)}" title="${k}: ${inr(valueOf(by(k)))}"></i>`).join('')}</div></section>
  ${open.has('newlead') && d.manage ? html`<form class="card form" data-form="newlead"><h2>New lead</h2><div class="grid2"><label>Name<input id="ld-name" required /></label><label>Company<input id="ld-company" /></label><label>Phone<input id="ld-phone" inputmode="tel" /></label><label>Email<input id="ld-email" type="email" /></label><label>Source<select id="ld-source"><option>Referral</option><option>Trade fair</option><option>Website</option><option>Walk-in</option><option>Cold call</option></select></label><label>Expected value (₹)<input id="ld-value" inputmode="decimal" /></label></div><label>Interested in<input id="ld-interest" /></label><label>Follow up on<input id="ld-follow" type="date" value="${addDays(todayIso(), 2)}" /></label><div class="row"><button class="primary" type="submit">Save lead</button><button type="button" data-act="ld-new">Cancel</button></div></form>` : ''}
  ${todo.length ? html`<section class="card"><h2>Follow-ups</h2><ul class="fu">${todo.map((t) => html`<li class="${t.overdue ? 'od' : ''}"><span class="chip ${t.overdue ? 'bad' : 'neutral'}">${t.overdue ? 'Overdue' : dateOnly(t.due_date)}</span> <b>${t.lead_name ?? ''}</b> <small>${t.kind} · ${t.summary}</small>${d.manage ? html`<button data-act="fu-done" data-id="${t.id}">Done</button>` : ''}</li>`)}</ul></section>` : ''}
  <section class="board">${COLS.map(([k, label]) => html`<div class="col"><h3>${label} <small>${by(k).length}</small></h3>${by(k).map(card)}${by(k).length ? '' : html`<p class="empty">–</p>`}</div>`)}</section>
  ${sel ? html`<section class="card"><h2>${sel.lead.company || sel.lead.name} <span class="chip neutral">${sel.lead.number}</span> ${chip(sel.lead.status)}</h2>
    <p class="sub">${[sel.lead.name, sel.lead.phone, sel.lead.email, sel.lead.source && 'via ' + sel.lead.source, 'owner ' + sel.lead.owner].filter(Boolean).join(' · ')}</p>${sel.lead.interest ? html`<p>${sel.lead.interest}</p>` : ''}${sel.lead.lost_reason ? html`<p class="rp-warn">Lost: ${sel.lead.lost_reason}</p>` : ''}
    ${d.manage && !['won', 'lost'].includes(sel.lead.status) ? html`<div class="row">${['contacted', 'qualified'].filter((x) => x !== sel.lead.status).map((x) => html`<button data-act="ld-status" data-id="${x}">Mark ${x}</button>`)}<button data-act="ld-lostopen">Mark lost…</button></div>
      ${open.has('lost') ? html`<form class="row" data-form="ld-lost"><input id="ld-lost" placeholder="Why was it lost?" style="flex:1" /><button type="submit">Confirm lost</button></form>` : ''}
      <form class="form act" data-form="activity"><h3>Log or plan something</h3><div class="grid2"><label>What<select id="ac-kind"><option value="call">Call</option><option value="visit">Visit</option><option value="meeting">Meeting</option><option value="email">Email</option><option value="note">Note</option></select></label><label>Do it by (optional)<input id="ac-due" type="date" /></label></div><input id="ac-sum" placeholder="What happened, or what will you do?" required /><button type="submit">Add</button></form>` : ''}
    <ul class="timeline">${sel.activities.map((a: { kind: string; summary: string; by: string; created_at: string; done: boolean; due_date: string | null }) => html`<li><span class="chip ${a.done ? 'neutral' : 'warn'}">${a.kind}</span> ${a.summary} <small>${a.by} · ${when(a.created_at)}${!a.done && a.due_date ? ' · due ' + dateOnly(String(a.due_date).slice(0, 10)) : ''}</small></li>`)}</ul></section>` : ''}`;
}

// ───────────── Quotations ─────────────
export async function quotesView(): Promise<Raw> {
  const d = await read(async (db) => {
    const list = await sales.listQuotes(db, uid());
    const sel = st.quote ? await sales.getQuote(db, uid(), st.quote).catch(() => null) : null;
    const customers = (await sales.listCustomers(db, uid())).filter((c) => c.status === 'active');
    const items = (await db.query(`SELECT id, code, name FROM item WHERE status='active' AND kind IN ('FABRIC','FG','TRIM') ORDER BY code`)).rows;
    const leads = (await sales.listLeads(db, uid()))?.leads.filter((l) => !['won', 'lost'].includes(l.status)) ?? [];
    return { list, sel, customers, items, leads, create: await can(db, uid(), 'quote.create', { siteId: K.world.siteId }), send: await can(db, uid(), 'quote.send', { siteId: K.world.siteId }), order: await can(db, uid(), 'so.create', { siteId: K.world.siteId }), over: await can(db, uid(), 'quote.discount.over', { siteId: K.world.siteId }) };
  });
  if (!d.create && !d.list.length) return denied('Quotations', 'Prices you offered.', 'Your role cannot see quotations.');
  const s = d.sel;
  const exp = (q: { status: string; expired?: boolean }) => (q.expired ? chip('cancelled', 'expired') : chip(q.status));
  return html`${head('Quotations', 'Offer a price, record the answer, and turn an accepted quotation into an order.', d.create ? html`<button class="primary" data-act="q-new">New quotation</button>` : undefined)}
  ${open.has('newquote') && d.create ? html`<form class="card form" data-form="newquote"><h2>New quotation</h2><div class="grid2"><label>Customer<select id="q-cust">${opts(d.customers.map((c) => ({ id: c.id, label: `${c.name} (${c.code})` })), '', 'Choose…')}</select></label>
    <label>For lead (optional)<select id="q-lead">${opts(d.leads.map((l) => ({ id: l.id, label: `${l.number} · ${l.company || l.name}` })), '', 'None')}</select></label>
    <label>Item<select id="q-item">${opts(d.items.map((i) => ({ id: i.id, label: `${i.code} · ${i.name}` })))}</select></label><label>Quantity<input id="q-qty" inputmode="decimal" value="100" /></label>
    <label>Rate (₹ per unit)<input id="q-rate" inputmode="decimal" value="320" /></label><label>Discount % <small>(up to ${sales.SALES_RULES.maxDiscountPct}%${d.over ? ', or more as manager' : ''})</small><input id="q-disc" inputmode="decimal" value="0" /></label>
    <label>Valid until<input id="q-valid" type="date" value="${addDays(todayIso(), sales.SALES_RULES.quoteValidDays)}" /></label></div><label>Notes<input id="q-notes" /></label><div class="row"><button class="primary" type="submit">Create quotation</button><button type="button" data-act="q-new">Cancel</button></div></form>` : ''}
  <section class="split"><div class="card"><h2>Quotations</h2>${d.list.length ? html`<table class="mini"><thead><tr><th>No.</th><th>Customer</th><th class="r">Value</th><th>Status</th></tr></thead><tbody>${d.list.map((q) => html`<tr class="pick ${q.id === st.quote ? 'on' : ''}" data-act="q-pick" data-id="${q.id}"><td>${q.number}</td><td>${q.customer}</td><td class="r">${money(q.total)}</td><td>${exp(q)}</td></tr>`)}</tbody></table>` : html`<p class="empty">No quotations yet.</p>`}</div>
  <div class="card">${s ? html`<h2>${s.number} ${chip(s.status)}</h2><p class="sub">${s.customer} · valid until ${dateOnly(String(s.valid_until).slice(0, 10))}</p>
    <table class="mini"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Disc.</th><th class="r">Amount</th></tr></thead><tbody>${s.lines.map((l: { item_code: string; qty: string; rate: string; disc_pct: string; amount: string }) => html`<tr><td>${l.item_code}</td><td class="r">${qty(l.qty)}</td><td class="r">${money(l.rate)}</td><td class="r">${Number(l.disc_pct)}%</td><td class="r">${money(l.amount)}</td></tr>`)}</tbody><tfoot><tr><td colspan="4"><b>Total</b></td><td class="r"><b>${money(s.total)}</b></td></tr></tfoot></table>${s.notes ? html`<p class="sub">${s.notes}</p>` : ''}
    <div class="row">${d.send && s.status === 'draft' ? html`<button class="primary" data-act="q-send">Mark as sent</button>` : ''}${d.send && s.status === 'sent' ? html`<button class="primary" data-act="q-accept">Customer accepted</button><button data-act="q-rejopen">Customer said no…</button>` : ''}${d.order && s.status === 'accepted' ? html`<button class="primary" data-act="q-order">Create sales order</button>` : ''}${d.create && ['draft', 'sent'].includes(s.status) ? html`<button data-act="q-cancelopen">Cancel…</button>` : ''}</div>
    ${open.has('qreason') ? html`<form class="row" data-form="q-reason"><input id="q-reason" placeholder="Reason" style="flex:1" /><button type="submit">Confirm</button></form>` : ''}` : html`<p class="empty">Pick a quotation.</p>`}</div></section>`;
}

// ───────────── Sales orders ─────────────
export async function salesView(): Promise<Raw> {
  const d = await read(async (db) => {
    const list = await sales.listOrders(db, uid());
    const sel = st.order ? await sales.getOrder(db, uid(), st.order).catch(() => null) : null;
    const customers = await sales.listCustomers(db, uid());
    const sum = await sales.salesSummary(db, uid());
    const stock: Record<string, Awaited<ReturnType<typeof sales.stockForLine>>> = {};
    if (sel && ['confirmed', 'part_dispatched'].includes(sel.status)) for (const l of sel.lines) if (Number(l.dispatched_qty) < Number(l.qty)) stock[l.id] = await sales.stockForLine(db, uid(), l.id).catch(() => []);
    const c = (p: string) => can(db, uid(), p, { siteId: K.world.siteId });
    return { list, sel, customers, sum, stock, create: await c('so.create'), submit: await c('so.submit'), terms: await c('customer.terms'), cancel: await c('so.cancel'), dispatch: await c('dispatch.post'), alloc: await c('reservation.allocate'),
      approve: sel ? await can(db, uid(), 'so.approve', { siteId: sel.site_id, amount: sel.total }) : false, items: (await db.query(`SELECT id, code, name FROM item WHERE status='active' AND kind IN ('FABRIC','FG','TRIM') ORDER BY code`)).rows };
  });
  if (!d.sum.sales && !d.create) return denied('Sales orders', 'Orders from customers.', 'Your role cannot see sales orders.');
  const s = d.sel; const k = d.sum.sales;
  const mine = s && s.created_by === K.world.actors[S.user].id;
  const act2 = (a: string, label: string, cls = '') => html`<button class="${cls}" data-act="${a}">${label}</button>`;
  const months = k?.months ?? []; const mmax = Math.max(...months.map((m: { total: number }) => m.total), 1);
  const custs = d.customers.filter((c) => c.status === 'active');
  return html`${head('Sales orders', 'From order to dispatch. Stock is held for an order, then leaves only when the storekeeper dispatches it.', d.create ? html`<button class="primary" data-act="so-new">New order</button>` : undefined)}
  ${k ? html`<section class="card crm-sum"><div class="crm-k"><span>Booked</span><b>${inr(k.booked)}</b></div><div class="crm-k"><span>Waiting for approval</span><b>${inr(k.awaiting)}</b></div><div class="crm-k"><span>Still to ship</span><b>${inr(k.to_ship)}</b></div><div class="crm-k"><span>Late orders</span><b class="${k.late ? 'bad-t' : ''}">${k.late}</b></div>
    ${months.length ? raw(`<div class="spark" style="grid-column:1/-1;height:70px">${months.map((m: { month: string; total: number }) => `<span class="sp" style="--h:${Math.max(6, (m.total / mmax) * 100)}%" title="${m.month}: ₹${nf(m.total)}"><i class="on"></i></span>`).join('')}</div><div class="sp-ax" style="grid-column:1/-1"><small>${months[0].month}</small><small>${months[months.length - 1].month}</small></div>`) : ''}</section>` : ''}
  ${open.has('newso') && d.create ? html`<form class="card form" data-form="newso"><h2>New sales order</h2><div class="grid2"><label>Customer<select id="so-cust">${opts(custs.map((c) => ({ id: c.id, label: `${c.name} · limit ${money(c.credit_limit)}` })), '', 'Choose…')}</select></label><label>Due date<input id="so-due" type="date" value="${addDays(todayIso(), 10)}" /></label>
    <label>Item<select id="so-item">${opts(d.items.map((i) => ({ id: i.id, label: `${i.code} · ${i.name}` })))}</select></label><label>Quantity<input id="so-qty" inputmode="decimal" value="100" /></label><label>Rate (₹)<input id="so-rate" inputmode="decimal" value="320" /></label><label>Discount %<input id="so-disc" inputmode="decimal" value="0" /></label></div><div class="row"><button class="primary" type="submit">Save as draft</button><button type="button" data-act="so-new">Cancel</button></div></form>` : ''}
  <section class="split"><div class="card"><h2>Orders</h2>${d.list.length ? html`<table class="mini"><thead><tr><th>No.</th><th>Customer</th><th class="r">Value</th><th>Status</th></tr></thead><tbody>${d.list.map((o) => html`<tr class="pick ${o.id === st.order ? 'on' : ''}" data-act="so-pick" data-id="${o.id}"><td>${o.number}</td><td>${o.customer}</td><td class="r">${money(o.total)}</td><td>${chip(o.status)}${o.late ? html` <span class="chip bad">late</span>` : ''}</td></tr>`)}</tbody></table>` : html`<p class="empty">No orders yet.</p>`}
    <h3>Customers and credit</h3><table class="mini"><thead><tr><th>Customer</th><th class="r">Open orders</th><th class="r">Limit</th></tr></thead><tbody>${custs.map((c) => { const use = Number(c.credit_limit) ? Math.min(100, (Number(c.exposure) / Number(c.credit_limit)) * 100) : 0; return html`<tr><td>${c.name}<div class="cbar"><i style="width:${use}%" class="${use > 85 ? 'hot' : ''}"></i></div></td><td class="r">${money(c.exposure)}</td><td class="r">${d.terms ? html`<form data-form="terms" data-id="${c.id}" class="inl-f"><input id="cl-${c.id}" value="${Number(c.credit_limit)}" inputmode="decimal" aria-label="Credit limit for ${c.name}" /><button type="submit">Set</button></form>` : Number(c.credit_limit) ? money(c.credit_limit) : 'none'}</td></tr>`; })}</tbody></table></div>
  <div class="card">${s ? html`<h2>${s.number} ${chip(s.status)}</h2><p class="sub">${s.customer} · ${money(s.total)}${s.due_date ? ' · due ' + dateOnly(String(s.due_date).slice(0, 10)) : ''} · prepared by ${s.created_name}</p>
    <p class="sub">Customer's open orders ${money(s.exposure)} of ${Number(s.creditLimit) ? money(s.creditLimit) : 'no limit set'}</p>
    <table class="mini"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th><th class="r">Sent</th><th class="r">Held</th></tr></thead><tbody>${s.lines.map((l: { item_code: string; qty: string; rate: string; disc_pct: string; amount: string; dispatched_qty: string; reserved: string }) => html`<tr><td>${l.item_code}</td><td class="r">${qty(l.qty)}</td><td class="r">${money(l.rate)}${Number(l.disc_pct) ? html` <small>−${Number(l.disc_pct)}%</small>` : ''}</td><td class="r">${money(l.amount)}</td><td class="r">${qty(l.dispatched_qty)}</td><td class="r">${qty(l.reserved)}</td></tr>`)}</tbody></table>
    <div class="row">${s.status === 'draft' && d.submit ? act2('so-submit', 'Submit for approval', 'primary') : ''}${s.status === 'approval_pending' && d.approve && !mine ? html`${act2('so-approve', 'Approve', 'primary')}${act2('so-returnopen', 'Send back…')}` : ''}${s.status === 'approval_pending' && mine ? html`<small class="sub">Waiting for someone else to approve. You cannot approve your own order.</small>` : ''}${['draft', 'approval_pending', 'confirmed'].includes(s.status) && (d.cancel || (s.status === 'draft' && mine)) ? act2('so-cancelopen', 'Cancel…') : ''}</div>
    ${open.has('soreason') ? html`<form class="row" data-form="so-reason"><input id="so-reason" placeholder="Reason" style="flex:1" /><button type="submit">Confirm</button></form>` : ''}
    ${['confirmed', 'part_dispatched'].includes(s.status) && (d.alloc || d.dispatch) ? html`<h3>Hold stock and dispatch</h3>${d.dispatch ? html`<div class="row"><input id="so-veh" placeholder="Vehicle no." /><input id="so-lr" placeholder="LR / docket no." /></div>` : ''}${s.lines.filter((l: { dispatched_qty: string; qty: string }) => Number(l.dispatched_qty) < Number(l.qty)).map((l: { id: string; item_code: string; qty: string; dispatched_qty: string; reserved: string }) => {
      const left = Number(l.qty) - Number(l.dispatched_qty); const picks = d.stock[l.id] ?? [];
      return html`<div class="dline"><b>${l.item_code}</b> <small>${left} to send · ${Number(l.reserved)} held</small>${picks.length ? html`<div class="row"><select id="dl-${l.id}">${picks.flatMap((p) => p.where.map((w) => html`<option value="${p.lotId}|${w.location_id}">${p.label} @ ${w.code} · ${qty(w.qty)} here · ${qty(p.available)} free</option>`))}</select><input id="dq-${l.id}" inputmode="decimal" value="${Math.min(left, Number(picks[0].where[0].qty))}" style="width:90px" />${d.alloc ? html`<button data-act="so-hold" data-id="${l.id}">Hold</button>` : ''}${d.dispatch ? html`<button class="primary" data-act="so-send" data-id="${l.id}">Dispatch</button>` : ''}</div>` : html`<p class="empty">No released stock of this item.</p>`}</div>`;
    })}` : ''}
    ${s.dispatches.length ? html`<h3>Dispatches</h3><ul class="timeline">${s.dispatches.map((x: { number: string; at: string; by: string; vehicle_no: string | null; lr_no: string | null; lines: { lot: string; qty: string; from: string }[] }) => html`<li><b>${x.number}</b> <small>${x.at} · ${x.by}${x.vehicle_no ? ' · ' + x.vehicle_no : ''}${x.lr_no ? ' · ' + x.lr_no : ''}</small><br><small>${x.lines.map((l) => `${qty(l.qty)} m of ${l.lot} from ${l.from}`).join(', ')}</small></li>`)}</ul>` : ''}` : html`<p class="empty">Pick an order.</p>`}</div></section>`;
}

// ───────────── events ─────────────
const ver = async (table: string, id: string) => (await K.pool.query(`SELECT version FROM ${table} WHERE id=$1`, [id])).rows[0].version as number;
async function versionOf(table: string, id: string) { return read(async (db) => (await db.query(`SELECT version FROM ${table} WHERE id=$1`, [id])).rows[0].version as number); }
void ver;

export async function onClick(t: HTMLElement): Promise<boolean> {
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b) return false;
  const a = b.dataset.act!, id = b.dataset.id ?? '';
  switch (a) {
    case 'ld-new': toggle('newlead'); return void await R.render(), true;
    case 'ld-pick': st.lead = st.lead === id ? '' : id; open.delete('lost'); return void await R.render(), true;
    case 'ld-lostopen': toggle('lost'); return void await R.render(), true;
    case 'ld-status': { const v = await versionOf('crm_lead', st.lead); await act('Lead updated', (c) => sales.setLeadStatus(c, { leadId: st.lead, status: id, expectedVersion: v })); return true; }
    case 'fu-done': await act('Marked done', (c) => sales.completeActivity(c, { activityId: id })); return true;
    case 'q-new': toggle('newquote'); return void await R.render(), true;
    case 'q-pick': st.quote = id; open.delete('qreason'); return void await R.render(), true;
    case 'q-send': { const v = await versionOf('quotation', st.quote); await act('Quotation sent', (c) => sales.sendQuote(c, { quoteId: st.quote, expectedVersion: v })); return true; }
    case 'q-accept': { const v = await versionOf('quotation', st.quote); await act('Quotation accepted', (c) => sales.decideQuote(c, { quoteId: st.quote, expectedVersion: v, accepted: true })); return true; }
    case 'q-rejopen': open.add('qreason'); S.open.add('q-reject'); open.delete('q-cancel'); return void await R.render(), true;
    case 'q-cancelopen': open.add('qreason'); S.open.add('q-cancel'); S.open.delete('q-reject'); return void await R.render(), true;
    case 'q-order': { const o = await act('Sales order drafted from the quotation', (c) => sales.createOrder(c, { siteId: K.world.siteId, quoteId: st.quote })); if (o) { st.order = o.id; S.view = 'sales'; history.replaceState(null, '', '#sales'); await R.render(); } return true; }
    case 'so-new': toggle('newso'); return void await R.render(), true;
    case 'so-pick': st.order = id; open.delete('soreason'); return void await R.render(), true;
    case 'so-submit': { const v = await versionOf('sales_order', st.order); await act('Submitted for approval', (c) => sales.submitOrder(c, { orderId: st.order, expectedVersion: v })); return true; }
    case 'so-approve': { const v = await versionOf('sales_order', st.order); await act('Order approved', (c) => sales.approveOrder(c, { orderId: st.order, expectedVersion: v })); return true; }
    case 'so-returnopen': open.add('soreason'); S.open.add('so-return'); S.open.delete('so-cancel'); return void await R.render(), true;
    case 'so-cancelopen': open.add('soreason'); S.open.add('so-cancel'); S.open.delete('so-return'); return void await R.render(), true;
    case 'so-hold': case 'so-send': {
      const [lotId, locationId] = (document.getElementById('dl-' + id) as HTMLSelectElement).value.split('|'); const q = val('dq-' + id);
      if (a === 'so-hold') await act('Stock held for the order', (c) => sales.allocate(c, { orderId: st.order, lineId: id, lotId, qty: q }));
      else await act('Dispatched', (c) => sales.dispatch(c, { orderId: st.order, vehicleNo: val('so-veh') || undefined, lrNo: val('so-lr') || undefined, lines: [{ lineId: id, lotId, locationId, qty: q }] }));
      return true;
    }
  }
  return false;
}

export async function onSubmit(form: string, f?: HTMLElement): Promise<boolean> {
  switch (form) {
    case 'newlead': {
      const r = await act('Lead saved', (c) => sales.createLead(c, { name: val('ld-name'), company: val('ld-company') || undefined, phone: val('ld-phone') || undefined, email: val('ld-email') || undefined, source: val('ld-source'), interest: val('ld-interest') || undefined, estValue: val('ld-value') || undefined, nextFollowUp: val('ld-follow') || undefined }));
      if (r) { open.delete('newlead'); st.lead = r.id; await R.render(); } return true;
    }
    case 'ld-lost': { const v = await versionOf('crm_lead', st.lead); const r = await act('Marked lost', (c) => sales.setLeadStatus(c, { leadId: st.lead, status: 'lost', reason: val('ld-lost'), expectedVersion: v })); if (r) { open.delete('lost'); await R.render(); } return true; }
    case 'activity': { const r = await act('Added', (c) => sales.addActivity(c, { leadId: st.lead, kind: (document.getElementById('ac-kind') as HTMLSelectElement).value, summary: val('ac-sum'), dueDate: val('ac-due') || undefined })); if (r) await R.render(); return true; }
    case 'newquote': {
      const r = await act('Quotation created', (c) => sales.createQuote(c, { siteId: K.world.siteId, customerId: val('q-cust'), leadId: val('q-lead') || undefined, validUntil: val('q-valid') || undefined, notes: val('q-notes') || undefined, lines: [{ itemId: val('q-item'), qty: val('q-qty'), rate: val('q-rate'), discPct: val('q-disc') || '0' }] }));
      if (r) { open.delete('newquote'); st.quote = r.id; await R.render(); } return true;
    }
    case 'q-reason': {
      const v = await versionOf('quotation', st.quote); const reject = S.open.has('q-reject'); const reason = val('q-reason');
      const r = reject ? await act('Recorded', (c) => sales.decideQuote(c, { quoteId: st.quote, expectedVersion: v, accepted: false, reason })) : await act('Quotation cancelled', (c) => sales.cancelQuote(c, { quoteId: st.quote, expectedVersion: v, reason }));
      if (r) { open.delete('qreason'); S.open.delete('q-reject'); S.open.delete('q-cancel'); await R.render(); } return true;
    }
    case 'newso': {
      const r = await act('Draft order saved', (c) => sales.createOrder(c, { siteId: K.world.siteId, customerId: val('so-cust'), dueDate: val('so-due') || undefined, lines: [{ itemId: val('so-item'), qty: val('so-qty'), rate: val('so-rate'), discPct: val('so-disc') || '0' }] }));
      if (r) { open.delete('newso'); st.order = r.id; await R.render(); } return true;
    }
    case 'so-reason': {
      const v = await versionOf('sales_order', st.order); const ret = S.open.has('so-return'); const reason = val('so-reason');
      const r = ret ? await act('Sent back', (c) => sales.returnOrder(c, { orderId: st.order, expectedVersion: v, reason })) : await act('Order cancelled', (c) => sales.cancelOrder(c, { orderId: st.order, expectedVersion: v, reason }));
      if (r) { open.delete('soreason'); S.open.delete('so-return'); S.open.delete('so-cancel'); await R.render(); } return true;
    }
    case 'terms': { const pid = f?.dataset.id ?? ''; await act('Credit limit saved', (c) => sales.setCreditTerms(c, { partnerId: pid, creditLimit: val('cl-' + pid) })); return true; }
  }
  return false;
}
void toast; void html; void raw;
