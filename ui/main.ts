import { setCurrent, DEFAULT_PREFS } from './prefs.js';
import { getPreferences } from '../src/domain/prefs.js';
import { LitePool } from './lite-pool.js';
import { openWorld, isSeeded } from './world.js';
import { runWorkedExample } from './walkthrough.js';
import { html, raw, esc, qty, money, when, dateOnly, chip, type Raw } from './lib.js';
import { K, S, R, $, uid, read, val, toast, act, head, kv, DEMO_PASSWORD, PEOPLE, ORDER, type View, type Db } from './ctx.js';
import { can } from '../src/core/permissions.js';
import { login, logout, actorFromToken } from '../src/core/auth.js';
import { qAdd, qSub } from '../src/core/qty.js';
import * as po from '../src/domain/po.js';
import * as rcv from '../src/domain/receipt.js';
import * as qc from '../src/domain/qc.js';
import * as inv from '../src/domain/inventory.js';
import * as q from '../src/domain/queries.js';
import * as hr from '../src/domain/hr.js';
import * as A from './views-admin.js';
import * as H from './views-hr.js';
import * as O from './views-owner.js';
import * as P from './views-reports.js';
import * as O2 from './views-overview.js';
import * as B from './views-barcode.js';
import * as PF from './po-form.js';
import * as SL from './views-sales.js';
import * as MX from './views-masters.js';
import * as BM from './views-bom.js';
import * as BK from './views-bulk.js';
import * as PN from './views-plan.js';
import * as WK from './views-work.js';
import * as AI from './views-ai.js';
import * as AG from './agent-ui.js';
import * as P0 from '../src/domain/reports.js';

declare const __BUILD_ID__: string;

type Item = { id: View; label: string; hint: string };
const GROUPS: { title: string; key: 'control' | 'reports' | 'sales' | 'masters' | 'products' | 'planning' | 'work' | 'ops' | 'people' | 'admin'; items: Item[] }[] = [
  { title: 'Control', key: 'control', items: [
    { id: 'owner', label: 'Owner desk', hint: 'Every process on one page' },
    { id: 'escalations', label: 'Urgent approvals', hint: 'Escalate and follow' } ] },
  { title: 'Reports', key: 'reports', items: [
    { id: 'reports', label: 'Reports', hint: 'Figures and exports' } ] },
  { title: 'Sales', key: 'sales', items: [
    { id: 'crm', label: 'CRM', hint: 'Leads and follow-ups' },
    { id: 'quotes', label: 'Quotations', hint: 'Prices offered' },
    { id: 'sales', label: 'Sales orders', hint: 'Orders, stock, dispatch' } ] },
  { title: 'Masters', key: 'masters', items: [
    { id: 'vendors', label: 'Vendors', hint: 'Who you buy from' },
    { id: 'distributors', label: 'Distributors', hint: 'Who buys in volume and resells' },
    { id: 'retailers', label: 'Retailers', hint: 'Who sells to the end customer' },
    { id: 'skus', label: 'SKUs', hint: 'Every size and colour of every style' },
    { id: 'materials', label: 'Materials', hint: 'Everything bought or made for production' },
    { id: 'finished', label: 'Finished goods', hint: 'What you sell' },
    { id: 'mtypes', label: 'Material types', hint: 'What each kind must record, units' } ] },
  { title: 'Products', key: 'products', items: [
    { id: 'products', label: 'Styles, SKUs & BOM', hint: 'Sizes, colours, bills of materials, packs' } ] },
  { title: 'Planning', key: 'planning', items: [
    { id: 'planning', label: 'Production plan', hint: 'Six months ahead, minimum stock, purchase requests' } ] },
  { title: 'Production', key: 'work', items: [
    { id: 'work', label: 'Work orders', hint: 'Finishing, shade lots, cutting' } ] },
  { title: 'Operations', key: 'ops', items: [
    { id: 'po', label: 'Purchase orders', hint: 'Create, approve, release' },
    { id: 'receiving', label: 'Receiving', hint: 'Material arriving at the gate' },
    { id: 'quality', label: 'Quality', hint: 'Inspect and release' },
    { id: 'stock', label: 'Stock', hint: 'Rolls, reservations, adjustments' },
    { id: 'barcodes', label: 'Scan & labels', hint: 'Print barcodes, scan, move forward' } ] },
  { title: 'People', key: 'people', items: [
    { id: 'employees', label: 'Employees', hint: 'Register, reporting lines' },
    { id: 'attendance', label: 'Attendance', hint: 'Daily marks, shifts, overtime' },
    { id: 'leave', label: 'Leave', hint: 'Apply and approve' },
    { id: 'payroll', label: 'Payroll', hint: 'Runs, salaries, payslips' } ] },
  { title: 'Administration', key: 'admin', items: [
    { id: 'users', label: 'Users', hint: 'Sign-ins, roles, suspension' },
    { id: 'roles', label: 'Roles & permissions', hint: 'Who is allowed what' },
    { id: 'audit', label: 'Audit trail', hint: 'Who did what' },
    { id: 'signins', label: 'Sign-in log', hint: 'Every attempt' },
    { id: 'aimodels', label: 'AI models', hint: 'Connect AI services' } ] },
];
const ALL_VIEWS: View[] = ['overview', 'account', ...GROUPS.flatMap((g) => g.items.map((i) => i.id))];

let vis = { ops: true, users: false, audit: false, owner: false, esc: false, rep: false, masters: false, ai: false, mat: false, ven: false, cli: false, sales: false, prod: false, plan: false, work: false, crm: false, quotes: false, sord: false };
const rollBar = (r: { held: string; accepted: string; rejected: string; reserved: string; available: string }) => {
  const held = Number(r.held), rej = Number(r.rejected), res = Number(r.reserved), av = Math.max(Number(r.available), 0);
  const tot = held + rej + res + av || 1;
  const seg = (n: number, c: string, t: string) => (n > 0 ? `<i class="${c}" style="flex:${(n / tot).toFixed(4)}" title="${t}: ${qty(String(n))}"></i>` : '');
  return raw(`<div class="bar" role="img" aria-label="Held ${qty(r.held)}, available ${qty(r.available)}, reserved ${qty(r.reserved)}, rejected ${qty(r.rejected)}">${seg(av, 'av', 'Free')}${seg(res, 'rs', 'Reserved')}${seg(held, 'hd', 'On QC hold')}${seg(rej, 'rj', 'Rejected')}</div>`);
};
const legend = html`<div class="legend"><span><i class="av"></i>Free</span><span><i class="rs"></i>Reserved</span><span><i class="hd"></i>On QC hold</span><span><i class="rj"></i>Rejected</span></div>`;

// ───────────── views ─────────────
const overview = O2.overviewView;

async function poView(): Promise<Raw> {
  const d = await read(async (db) => {
    const list = await po.listPOs(db, uid());
    const sel = S.poId ? await po.getPO(db, uid(), S.poId).catch(() => null) : null;
    const rcpt = sel ? (await db.query(`SELECT r.number, r.challan_no, r.received_at FROM receipt r WHERE r.po_id=$1 ORDER BY r.received_at`, [sel.id])).rows : [];
    const names = Object.fromEntries((await db.query('SELECT id, username FROM app_user')).rows.map((r) => [r.id, r.username]));
    const items = (await db.query(`SELECT id, code, name, stock_unit FROM item WHERE status='active' ORDER BY code`)).rows;
    const vendors = (await db.query(`SELECT id, code, name FROM partner WHERE status='active' AND is_vendor ORDER BY code`)).rows;
    const itemCodes = Object.fromEntries((await db.query('SELECT id, code FROM item')).rows.map((r) => [r.id, r.code]));
    const fromPr = sel ? ((await db.query('SELECT number FROM purchase_request WHERE po_id=$1', [sel.id])).rows[0]?.number as string | undefined) : undefined;
    return { list, sel, fromPr, rcpt, names, items, vendors, itemCodes };
  });
  const s = d.sel;
  const reason = html`<input id="reason" placeholder="Reason (needed to return, cancel or amend)" aria-label="Reason" />`;
  const actions = (): Raw => {
    if (!s) return html``;
    const b = (a: string, label: string, cls = '') => html`<button class="${cls}" data-act="${a}">${label}</button>`;
    const pa = s.pending_amendment as null | { reason: string; newTotal: string };
    if (pa) return html`<div class="pending"><b>Amendment awaiting approval</b><span>${pa.reason} · new total ${money(pa.newTotal)} · proposed by ${d.names[s.amended_by] ?? ''}</span></div><div class="row">${b('po-approve', 'Approve amendment', 'primary')}${b('po-return', 'Discard amendment')}</div>${reason}`;
    switch (s.status) {
      case 'draft': return html`<div class="row">${b('po-submit', 'Submit for approval', 'primary')}${s.created_by === uid() ? b('po-editlines', 'Edit items') : ''}${b('po-cancel', 'Cancel order')}</div>${reason}`;
      case 'approval_pending': return html`<div class="row">${b('po-approve', 'Approve', 'primary')}${b('po-return', 'Return to buyer')}${b('po-cancel', 'Cancel order')}</div>${reason}`;
      case 'approved': return html`<div class="row">${b('po-release', 'Release to vendor', 'primary')}${b('po-cancel', 'Cancel order')}</div>${reason}`;
      case 'released': case 'acknowledged': case 'partial_receipt':
        return html`<div class="row">${b('po-amend', 'Propose +5% price change')}${b('po-cancel', 'Cancel / short-close')}</div>${reason}`;
      default: return html`<p class="note">This order is ${s.status}. No further actions.</p>`;
    }
  };
  const form = PF.formView(d.items, d.vendors);
  return html`
  ${head('Purchase orders', 'Creating, approving and releasing are three separate rights. Nobody approves their own order.', html`<button class="primary" data-act="toggle-newpo">New purchase order</button>`)}
  ${form}
  <section class="split">
    <div class="card flush"><div class="tablewrap"><table>
      <thead><tr><th>Order</th><th>Vendor</th><th>Status</th><th class="r">Total</th></tr></thead>
      <tbody>${d.list.length ? d.list.map((p) => html`<tr class="pick ${p.id === S.poId ? 'on' : ''}" data-pick-po="${p.id}" tabindex="0"><td class="mono">${p.number}</td><td>${p.vendor}</td><td>${chip(p.status)}</td><td class="r num">${money(p.total)}</td></tr>`) : html`<tr><td colspan="4" class="empty">No purchase orders you can see yet. Create one, or run the worked example on the Overview.</td></tr>`}</tbody>
    </table></div></div>
    <aside class="card detail">${s ? html`
      <div class="dh"><h2 class="mono">${s.number}</h2>${chip(s.status)}</div>
      ${kv('Total', money(s.total))}${kv('Version', `v${s.version} · revision ${s.revision}`)}${d.fromPr ? kv('Raised from', d.fromPr + ' (production plan)') : ''}${kv('Created by', d.names[s.created_by] ?? '')}${kv('Approved by', d.names[s.approved_by] ?? '–')}${kv('Released by', d.names[s.released_by] ?? '–')}
      <h3>Lines</h3>
      <div class="tablewrap"><table class="mini"><thead><tr><th>Item</th><th class="r">Ordered</th><th class="r">Received</th><th class="r">Accepted</th><th class="r">Rejected</th><th class="r">Rate</th><th>Due</th></tr></thead>
      <tbody>${s.lines.map((l: Record<string, string>) => html`<tr><td class="mono">${d.itemCodes[l.item_id]}</td><td class="r num">${qty(l.qty)}</td><td class="r num">${qty(l.received_qty)}</td><td class="r num">${qty(l.accepted_qty)}</td><td class="r num">${qty(l.rejected_qty)}</td><td class="r num">${money(l.rate)}</td><td>${l.due_date ? dateOnly(String(l.due_date).slice(0, 10)) : '–'}</td></tr>`)}</tbody></table></div>
      ${d.rcpt.length ? html`<h3>Receipts</h3><ul class="plain">${d.rcpt.map((r) => html`<li><span class="mono">${r.number}</span> · challan ${r.challan_no} · ${when(r.received_at)}</li>`)}</ul>` : ''}
      <h3>History</h3><ul class="plain">${s.versions.map((v: { version: number; reason: string; at: string }) => html`<li><span class="mono">v${v.version}</span> ${v.reason ?? ''} <small>${when(v.at)}</small></li>`)}</ul>
      <h3>Actions</h3>${actions()}` : html`<p class="empty">Select an order to see its lines, history and the actions available.</p>`}
    </aside>
  </section>`;
}

async function receivingView(): Promise<Raw> {
  const d = await read(async (db) => {
    const pos = (await po.listPOs(db, uid())).filter((p) => ['released', 'acknowledged', 'partial_receipt'].includes(p.status));
    const lines = pos.length ? (await db.query(
      `SELECT pl.id, pl.po_id, pl.qty, pl.received_qty, pl.rejected_qty, i.code, i.id AS item_id FROM po_line pl JOIN item i ON i.id = pl.item_id WHERE pl.po_id = ANY($1::uuid[]) ORDER BY pl.line_no`, [pos.map((p) => p.id)])).rows : [];
    const receipts = await rcv.listReceipts(db, uid());
    return { pos, lines, receipts };
  });
  const sel = S.poId && d.pos.find((p) => p.id === S.poId) ? S.poId : d.pos[0]?.id ?? '';
  const open = (l: Record<string, string>) => qSub(l.qty, qSub(l.received_qty, l.rejected_qty));
  const lines = d.lines.filter((l) => l.po_id === sel);
  return html`
  ${head('Receiving', 'Arrival never makes usable stock. Every roll lands on QC hold until quality authority releases it.')}
  <section class="split">
    <form class="card form" data-form="receive">
      <h2>Receive a roll</h2>
      ${d.pos.length ? html`
      <label>Purchase order<select id="r-po" data-reload-po>${d.pos.map((p) => html`<option value="${p.id}" ${p.id === sel ? raw('selected') : ''}>${p.number} · ${p.vendor}</option>`)}</select></label>
      <label>Line<select id="r-line">${lines.map((l) => html`<option value="${l.id}|${l.item_id}">${l.code} · ${qty(open(l))} m still open</option>`)}</select></label>
      <label>Quantity received (m)<input id="r-qty" inputmode="decimal" value="${lines[0] ? qty(open(lines[0])).replace(/,/g, '') : ''}" /></label>
      <label>Vendor challan number<input id="r-challan" value="CH-${Math.floor(Math.random() * 9000 + 1000)}" /></label>
      <p class="note">Try entering more than is open: the system blocks over-receipt. Reusing a challan number is blocked too, unless an inventory controller acknowledges the repeat.</p>
      <button class="primary" type="submit">Post receipt</button>` : html`<p class="empty">No released purchase orders to receive against. Approve and release one first (Buyer → Commercial approver), or run the worked example.</p>`}
    </form>
    <div class="card flush"><div class="tablewrap"><table>
      <thead><tr><th>Receipt</th><th>Vendor</th><th>Challan</th><th>When</th></tr></thead>
      <tbody>${d.receipts.length ? d.receipts.map((r) => html`<tr><td class="mono">${r.number}</td><td>${r.vendor}</td><td class="mono">${r.challan_no}</td><td>${when(r.received_at)}</td></tr>`) : html`<tr><td colspan="4" class="empty">No receipts yet.</td></tr>`}</tbody>
    </table></div></div>
  </section>`;
}

async function qualityView(): Promise<Raw> {
  const d = await read((db) => qc.listInspections(db, uid()));
  const sel = d.find((i) => i.id === S.inspId);
  const pend = d.filter((i) => !['accepted', 'rejected'].includes(i.status));
  const panel = !sel ? html`<p class="empty">Select an inspection to act on it.</p>` : await (async () => {
    const full = (await read((db) => db.query('SELECT * FROM qc_inspection WHERE id=$1', [sel.id]))).rows[0];
    const held = qSub(sel.qty, qAdd(sel.accepted_qty, sel.rejected_qty));
    return html`
      <div class="dh"><h2 class="mono">${sel.label}</h2>${chip(sel.status)}</div>
      ${kv('Item', sel.item_code)}${kv('Received', `${qty(sel.qty)} m`)}${kv('Still on hold', `${qty(held)} m`)}${kv('Released', `${qty(sel.accepted_qty)} m`)}${kv('Rejected', `${qty(sel.rejected_qty)} m`)}
      ${sel.status === 'pending' ? html`<button class="primary" data-act="qc-start">Start inspection</button>` : ''}
      ${sel.status === 'inspecting' ? html`<form class="form" data-form="qc-submit"><h3>Record result</h3>
        <label>Sample inspected (m)<input id="q-sample" inputmode="decimal" value="20" /></label>
        <label>Recommend accept (m)<input id="q-ra" inputmode="decimal" value="${qty(held).replace(/,/g, '')}" /></label>
        <label>Recommend reject (m)<input id="q-rr" inputmode="decimal" value="0" /></label>
        <p class="note">An inspector recommends. Only quality authority can release.</p><button class="primary" type="submit">Submit recommendation</button></form>` : ''}
      ${['submitted', 'held', 'partial'].includes(sel.status) ? html`<form class="form" data-form="qc-disp"><h3>Disposition</h3>
        <label>Release as usable (m)<input id="d-acc" inputmode="decimal" value="${qty(full.recommend_accept ?? held).replace(/,/g, '')}" /></label>
        <label>Reject (m)<input id="d-rej" inputmode="decimal" value="${qty(full.recommend_reject ?? '0').replace(/,/g, '')}" /></label>
        <p class="note">Released + rejected can never exceed what is still on hold.</p><button class="primary" type="submit">Record disposition</button></form>` : ''}
      ${['accepted', 'rejected'].includes(sel.status) ? html`<p class="note">Closed. A later reinspection would create a new linked result and never erase this one.</p>` : ''}`;
  })();
  return html`
  ${head('Quality', 'Inspectors recommend, quality managers decide. Held stock cannot be allocated.')}
  <section class="split">
    <div class="card flush"><div class="tablewrap"><table>
      <thead><tr><th>Roll</th><th>Item</th><th class="r">Metres</th><th>Status</th></tr></thead>
      <tbody>${d.length ? [...pend, ...d.filter((i) => !pend.includes(i))].map((i) => html`<tr class="pick ${i.id === S.inspId ? 'on' : ''}" data-pick-qc="${i.id}" tabindex="0"><td class="mono">${i.label}</td><td class="mono">${i.item_code}</td><td class="r num">${qty(i.qty)}</td><td>${chip(i.status)}</td></tr>`) : html`<tr><td colspan="4" class="empty">Nothing to inspect yet. Post a receipt first.</td></tr>`}</tbody>
    </table></div></div>
    <aside class="card detail">${panel}</aside>
  </section>`;
}

async function stockView(): Promise<Raw> {
  const d = await read(async (db) => {
    const stock = await q.stockSummary(db, uid());
    const adj = await q.listAdjustments(db, uid());
    const ref = await q.referenceData(db);
    const ledger = S.lotId ? await q.lotLedger(db, uid(), S.lotId).catch(() => []) : [];
    const res = S.lotId ? await q.lotReservations(db, uid(), S.lotId) : [];
    return { stock, adj, ref, ledger, res };
  });
  const loc = (kind: string) => d.ref.locations.filter((l) => l.kind === kind);
  const lotPanel = (r: (typeof d.stock)[number]) => html`
    <div class="lotpanel">
      <div class="forms">
        <form class="form" data-form="reserve"><h3>Reserve</h3><label>Metres<input id="s-qty" inputmode="decimal" value="50" /></label><label>For<input id="s-ref" value="CUT-${Math.floor(Math.random() * 900 + 100)}" /></label><button class="primary" type="submit">Reserve</button></form>
        <form class="form" data-form="putaway"><h3>Move to rack</h3><label>Metres<input id="p-qty" inputmode="decimal" value="${qty(r.accepted).replace(/,/g, '')}" /></label><label>To<select id="p-to">${[...loc('RACK'), ...loc('STORE')].map((l) => html`<option value="${l.id}">${l.code}</option>`)}</select></label><button type="submit">Move accepted stock</button></form>
        <form class="form" data-form="adjust"><h3>Propose adjustment</h3><label>Change (m, − to remove)<input id="a-qty" inputmode="decimal" value="-5" /></label><label>Reason<input id="a-reason" value="Count variance" /></label><button type="submit">Propose</button></form>
      </div>
      <div class="two">
        <div><h3>Movements</h3><div class="tablewrap"><table class="mini"><thead><tr><th>Type</th><th>Status</th><th>Where</th><th class="r">Metres</th><th>By</th></tr></thead>
          <tbody>${d.ledger.map((l) => html`<tr><td>${l.movement_type.toLowerCase()}</td><td>${l.status.toLowerCase()}</td><td class="mono">${l.location}</td><td class="r num ${l.qty.startsWith('-') ? 'neg' : ''}">${qty(l.qty)}</td><td>${l.actor}</td></tr>`)}</tbody></table></div>
          <p class="note">The ledger is append-only. There is no way to overwrite a balance.</p></div>
        <div><h3>Reservations</h3>${d.res.length ? html`<ul class="plain">${d.res.map((x) => html`<li><span class="mono">${x.demand_ref}</span> · ${qty(x.qty)} m · ${chip(x.status)} ${x.status === 'active' ? html`<button class="link" data-act="unreserve" data-id="${x.id}">release</button>` : ''}</li>`)}</ul>` : html`<p class="empty">None.</p>`}</div>
      </div>
    </div>`;
  return html`
  ${head('Stock', 'Every roll shows what is free, reserved, on quality hold or rejected. Balances come from the ledger, never typed in.')}
  ${legend}
  <section class="rolls">${d.stock.length ? d.stock.map((r) => html`
    <article class="card roll ${r.lot_id === S.lotId ? 'open' : ''}">
      <button class="rollhead" data-pick-lot="${r.lot_id}" aria-expanded="${r.lot_id === S.lotId}">
        <span class="mono lab">${r.label}</span><span class="it">${r.item_code} · ${r.item_name}</span>
        ${rollBar(r)}
        <span class="nums"><b>${qty(r.available)}</b> free · ${qty(r.reserved)} reserved · ${qty(r.held)} on hold · ${qty(r.rejected)} rejected</span>
      </button>
      ${r.lot_id === S.lotId ? lotPanel(r) : ''}
    </article>`) : html`<div class="card"><p class="empty">No rolls yet. Receive material, or run the worked example from the Overview.</p></div>`}</section>
  <h2 class="sec">Stock adjustments</h2>
  <div class="card flush"><div class="tablewrap"><table>
    <thead><tr><th>No.</th><th>Roll</th><th class="r">Change (m)</th><th>Reason</th><th>Proposed by</th><th>Status</th><th></th></tr></thead>
    <tbody>${d.adj.length ? d.adj.map((a) => html`<tr><td class="mono">${a.number}</td><td class="mono">${a.label}</td><td class="r num">${qty(a.qty_delta)}</td><td>${a.reason}</td><td>${a.proposed_by}</td><td>${chip(a.status)}</td>
      <td class="acts">${a.status === 'proposed' ? html`<button data-act="adj-yes" data-id="${a.id}" data-v="${a.version}">Approve</button><button class="ghost" data-act="adj-no" data-id="${a.id}" data-v="${a.version}">Reject</button>` : a.status === 'approved' ? html`<button data-act="adj-post" data-id="${a.id}" data-v="${a.version}">Post</button>` : ''}</td></tr>`) : html`<tr><td colspan="7" class="empty">No adjustments. Propose one from a roll above, then approve it as a different person.</td></tr>`}</tbody>
  </table></div></div>`;
}

async function auditView(): Promise<Raw> {
  const rows = await read((db) => q.recentAudit(db, uid(), 150));
  if (!rows) return html`${head('Audit trail', 'Every committed change is recorded with who did it and why.')}<div class="card"><p class="empty">Your role cannot read the audit trail. Switch to the Auditor, Finance controller or System administrator.</p></div>`;
  const f = S.filter.toLowerCase();
  const shown = rows.filter((r) => !f || `${r.action} ${r.actor} ${r.entity_type} ${r.reason ?? ''}`.toLowerCase().includes(f));
  return html`
  ${head('Audit trail', 'Append-only. Not even an administrator can edit or delete an entry.')}
  <div class="card flush"><div class="bar2"><input id="filter" placeholder="Filter by person, action or record…" value="${S.filter}" aria-label="Filter" /><span>${shown.length} of ${rows.length}</span></div>
  <div class="tablewrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Reason</th></tr></thead>
  <tbody>${shown.map((r) => html`<tr><td>${when(r.at)}</td><td>${r.actor}</td><td class="mono">${r.action}</td><td>${r.entity_type.replace(/_/g, ' ')}</td><td>${r.reason ?? ''}</td></tr>`)}</tbody></table></div></div>`;
}


const ICONS: Record<string, string> = {
  work: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z', po: 'M2 3h3l3 12h11l3-9H6 M10 20h.01M18 20h.01', receiving: 'm3 7 9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10',
  quality: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6z m-5 10 3 3 5-6', stock: 'M3 3v18h18 M7 15l4-5 4 2 6-8', audit: 'M14 2H4v20h16V8z M14 2v6h6 M8 12h8M8 16h8',
  employees: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M20 21v-2a4 4 0 0 0-3-4 M17 3a4 4 0 0 1 0 8', attendance: 'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  leave: 'M3 5h18v16H3z M3 10h18 M8 3v4 M16 3v4', payroll: 'M3 5h17v15H3z M3 5V3h14 M15 10h7v6h-7z', users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  owner: 'M3 3h18v6H3z M3 13h8v8H3z M15 13h6v8h-6z', escalations: 'M12 2 2 20h20z M12 9v5 M12 17h.01', crm: 'M16 11a4 4 0 1 0-8 0 M4 21a8 8 0 0 1 16 0', quotes: 'M6 3h9l4 4v14H6z M9 12h7 M9 16h7', materials: 'M4 7l8-4 8 4-8 4z M4 12l8 4 8-4 M4 17l8 4 8-4', mtypes: 'M3 6h18 M3 12h12 M3 18h8', vendors: 'M3 21V8l9-5 9 5v13 M9 21v-6h6v6', clients: 'M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2 M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M21 21v-2a4 4 0 0 0-3-3.9', aimodels: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',  sales: 'M3 17l5-5 4 4 8-9 M15 7h5v5', barcodes: 'M4 5v14 M7 5v14 M11 5v14 M14 5v14 M18 5v14 M21 5v14', reports: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
  roles: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6z', signins: 'M10 13a5 5 0 0 0 7 0l4-4a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-4 4a5 5 0 0 0 7 7l2-2' };
const icon = (id: string) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[id] ?? ICONS.overview}"/></svg>`);
const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

const navOpen = new Set<string>();
const ALL_ITEMS = GROUPS.flatMap((g) => g.items);
// ───────────── shell ─────────────
const DEMO_NOTE = 'Demo data lives only in this browser. Every account uses the password shown here.';

function shell(content: Raw): string {
  const me = PEOPLE[S.user] ?? { name: S.user, role: '' };
  const items = (g: (typeof GROUPS)[number]) => g.items.filter((n) => (g.key === 'control' ? (n.id === 'owner' ? vis.owner : vis.esc) : g.key === 'masters' ? (n.id === 'vendors' ? vis.ven : n.id === 'distributors' || n.id === 'retailers' ? vis.cli : n.id === 'skus' ? vis.prod : vis.mat) : g.key === 'sales' ? (n.id === 'crm' ? vis.crm : n.id === 'quotes' ? vis.quotes : vis.sord) : g.key === 'admin' ? (n.id === 'aimodels' ? vis.ai : n.id === 'roles' || (n.id === 'audit' ? vis.audit : vis.users)) : true));
  return html`
  <aside class="sidebar">
    <div class="brand"><img class="brand-logo" src="kalyani-logo.png" alt="Kalyani" /><span class="erp-label">Operations ERP · demo</span></div>
    <div class="workspace"><b>Kalyani Plant 1</b><small>Demo data, this browser only</small></div>
    <div class="nav-scroll"><nav class="side" aria-label="Sections">
      <a href="#overview" class="${S.view === 'overview' ? 'on' : ''}" data-view="overview">${icon('overview')}Overview</a>
      ${GROUPS.filter((g) => (g.key !== 'ops' || vis.ops) && (g.key !== 'control' || vis.owner || vis.esc) && (g.key !== 'reports' || vis.rep) && (g.key !== 'sales' || vis.sales) && (g.key !== 'masters' || vis.masters) && (g.key !== 'products' || vis.prod) && (g.key !== 'planning' || vis.plan) && (g.key !== 'work' || vis.work)).map((g) => { const its = items(g); const has = its.some((n) => n.id === S.view); if (has) navOpen.add(g.key); const o = navOpen.has(g.key); return html`<button type="button" class="grp ${o ? 'open' : ''} ${has ? 'cur' : ''}" data-grp="${g.key}" aria-expanded="${o}">${g.title}<span class="grp-n">${its.length}</span>${raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>')}</button><div class="grp-items ${o ? '' : 'shut'}" data-items="${g.key}">${its.map((n) => html`<a href="#${n.id}" class="${n.id === S.view ? 'on' : ''}" data-view="${n.id}" title="${n.hint}">${icon(n.id)}${n.label}</a>`)}</div>`; })}
    </nav></div>
    <div class="side-bottom"><button class="ghost reset" data-act="reset">Reset demo data</button></div>
  </aside>
  <div class="shell">
  <header class="top">
    <div class="crumbs">Kalyani Plant 1 / <b>${S.view === 'overview' ? 'Overview' : (ALL_ITEMS.find((i) => i.id === S.view)?.label ?? 'My account')}</b></div>
    <div class="who">
      <label class="actor"><span>Demo: switch person</span>
        <select id="who" aria-label="Switch person (demo shortcut: signs in with the demo password)">${ORDER.filter((k) => K.world.actors[k]).map((k) => html`<option value="${k}" ${k === S.user ? raw('selected') : ''}>${PEOPLE[k].role.split(' · ')[0]} — ${PEOPLE[k].name}</option>`)}</select></label>
      <button class="ghost" data-view="account" title="My account" style="display:flex;align-items:center;gap:8px"><span class="avatar">${initials(me.name)}</span>${me.name}</button><button data-act="signout">Sign out</button>
    </div>
  </header>
  <main id="main" class="content" aria-live="polite" aria-label="${me.role}">${S.mustChange ? html`<div class="pending"><b>Choose a new password to continue</b><span>You signed in with a temporary password.</span></div>` : ''}${content}</main>
  </div>`.s;
}

function loginScreen(error = ''): string {
  const users = ORDER.filter((k) => K.world.actors[k]);
  return html`
  <div class="login">
    <form class="card form" data-form="login" autocomplete="off">
      <div class="brand"><img class="brand-logo logo-login" src="kalyani-logo.png" alt="Kalyani" /></div>
      <h1>Sign in</h1>
      <label>Username<input id="lg-user" autocapitalize="none" spellcheck="false" autocomplete="username" /></label>
      <label>Password<input id="lg-pass" type="password" autocomplete="current-password" /></label>
      ${error ? html`<p class="err" role="alert">${error}</p>` : ''}
      <button class="primary" type="submit">Sign in</button>
      <p class="note">${DEMO_NOTE} Demo password: <span class="mono">${DEMO_PASSWORD}</span>. Try five wrong passwords to see the lockout; sign in as <span class="mono">admin</span> to unlock the account.</p>
    </form>
    <div class="card"><h2>Pick a person</h2><p class="sub">Click one to fill the sign-in form. Each sees and can do something different.</p>
      <div class="people">${users.map((k) => html`<button type="button" data-fill="${k}"><b>${PEOPLE[k].name}</b><small>${PEOPLE[k].role.split(' · ')[0]} · <span class="mono">${k}</span></small></button>`)}</div></div>
  </div>`.s;
}

async function computeVis() {
  vis = await read(async (db) => ({
    ops: (await Promise.all(['po.view', 'inventory.view', 'qc.view', 'receipt.view'].map((p) => can(db, uid(), p, { anySite: true })))).some(Boolean),
    users: await can(db, uid(), 'user.view', { anySite: true }),
    audit: await can(db, uid(), 'audit.view', { anySite: true }),
    owner: await can(db, uid(), 'owner.view', { anySite: true }),
    sales: (await Promise.all(['crm.view', 'so.view', 'quote.create'].map((p) => can(db, uid(), p, { anySite: true })))).some(Boolean),
    crm: await can(db, uid(), 'crm.view', { anySite: true }),
    quotes: await can(db, uid(), 'quote.create', { anySite: true }) || await can(db, uid(), 'sales.view', { anySite: true }),
    sord: await can(db, uid(), 'so.view', { anySite: true }),
    ai: await can(db, uid(), 'ai.manage', { anySite: true }),
    mat: await can(db, uid(), 'item.view', { anySite: true }),
    ven: await can(db, uid(), 'partner.view', { anySite: true }),
    cli: await can(db, uid(), 'partner.view', { anySite: true }) || await can(db, uid(), 'so.view', { anySite: true }),
    prod: await can(db, uid(), 'bom.view', { anySite: true }),
    plan: await can(db, uid(), 'plan.view', { anySite: true }),
    work: await can(db, uid(), 'production.view', { anySite: true }),
    masters: (await Promise.all(['item.view', 'partner.view', 'so.view'].map((p) => can(db, uid(), p, { anySite: true })))).some(Boolean),
    rep: (await P0.listReports(db, uid())).length > 0,
    esc: await can(db, uid(), 'escalation.view', { anySite: true }) || await can(db, uid(), 'owner.view', { anySite: true }),
  }));
}

const VIEWS: Record<View, () => Promise<Raw>> = {
  overview, po: poView, receiving: receivingView, quality: qualityView, stock: stockView, audit: auditView,
  employees: H.employeesView, attendance: H.attendanceView, leave: H.leaveView, payroll: H.payrollView,
  owner: O.ownerView, escalations: O.escalationsView, reports: P.reportsView, barcodes: B.barcodesView, crm: SL.crmView, quotes: SL.quotesView, sales: SL.salesView, materials: MX.materialsView, mtypes: MX.typesView, vendors: MX.vendorsView, distributors: MX.distributorsView, retailers: MX.retailersView, finished: MX.finishedView, skus: BK.skusView, clients: MX.retailersView, work: WK.workView, products: BM.productsView, planning: PN.planningView, aimodels: AI.aiView, users: A.usersView, roles: A.rolesView, signins: A.signinsView, account: A.accountView,
};

let queued = false;
function scheduleRender() { if (queued) return; queued = true; setTimeout(() => { queued = false; void render(); }, 0); }
R.scheduleRender = scheduleRender;

let prefsFor = '';
async function render() {
  if (!S.user) { if (prefsFor) { prefsFor = ''; setCurrent(DEFAULT_PREFS); } $('#app').innerHTML = loginScreen(loginError); return; }
  if (prefsFor !== S.user) { prefsFor = S.user; setCurrent(await read((db) => getPreferences(db, uid()))); }
  const keep = { y: window.scrollY, f: document.activeElement?.id };
  await computeVis();
  if (S.mustChange) S.view = 'account';
  if (!ALL_VIEWS.includes(S.view)) S.view = 'overview';
  const content = await VIEWS[S.view]().catch((e) => html`<div class="card"><h2>Something went wrong</h2><p class="note">${(e as Error).message}</p></div>`);
  $('#app').innerHTML = shell(content);
  window.scrollTo(0, keep.y);
  if (keep.f && !keep.f.startsWith('ag-')) (document.getElementById(keep.f) as HTMLElement | null)?.focus();
  void AG.sync();
}
R.render = render;

// ───────────── sign-in ─────────────
let loginError = '';
async function signIn(username: string, password: string): Promise<boolean> {
  try {
    const r = await login(K.pool as never, username, password);
    if (!K.world.actors[username]) K.world.actors[username] = r.actor;
    S.user = username; S.token = r.token; S.mustChange = r.mustChangePassword; loginError = '';
    try { sessionStorage.setItem('erp-token', r.token); } catch { /* optional */ }
    S.view = r.mustChangePassword ? 'account' : (S.view === 'account' || (username === 'own' && S.view === 'overview') ? (username === 'own' ? 'owner' : 'overview') : S.view);
    return true;
  } catch (e) { loginError = (e as Error).message; return false; }
}
async function signOut() {
  try { await logout(K.pool as never, S.token); } catch { /* already gone */ }
  try { sessionStorage.removeItem('erp-token'); } catch { /* optional */ }
  S.user = ''; S.token = ''; S.mustChange = false; S.userSel = S.roleSel = S.empId = S.attEmp = ''; S.roleDraft = null; loginError = '';
  await render();
}

// ───────────── events ─────────────
const poVer = async (c: { db: Db }) => (await c.db.query('SELECT version FROM purchase_order WHERE id=$1', [S.poId])).rows[0].version as number;
const insVer = async (c: { db: Db }) => (await c.db.query('SELECT version FROM qc_inspection WHERE id=$1', [S.inspId])).rows[0].version as number;
const reasonOr = (d: string) => val('reason') || d;

document.addEventListener('click', async (ev) => {
  const t = ev.target as HTMLElement;
  const fill = t.closest('[data-fill]') as HTMLElement | null;
  if (fill) { (document.getElementById('lg-user') as HTMLInputElement).value = fill.dataset.fill!; (document.getElementById('lg-pass') as HTMLInputElement).value = DEMO_PASSWORD; (document.getElementById('lg-pass') as HTMLElement).focus(); return; }
  const gh = t.closest('[data-grp]') as HTMLElement | null;
  if (gh) { const k = gh.dataset.grp!; const box = document.querySelector(`[data-items="${k}"]`); const o = !navOpen.has(k); o ? navOpen.add(k) : navOpen.delete(k); gh.classList.toggle('open', o); gh.setAttribute('aria-expanded', String(o)); box?.classList.toggle('shut', !o); return; }
  const nav = t.closest('[data-view]') as HTMLElement | null;
  if (nav) { ev.preventDefault(); if (S.mustChange) return toast('Choose a new password first', 'bad'); S.view = nav.dataset.view as View; history.replaceState(null, '', '#' + S.view); return render(); }
  if (await A.onClick(t)) return;
  if (await H.onClick(t)) return;
  if (await O.onClick(t)) return;
  if (await P.onClick(t)) return;
  if (await B.onClick(t)) return;
  if (await SL.onClick(t)) return;
  if (await MX.onClick(t)) return;
  if (await BM.onClick(t)) return;
  if (await BK.onClick(t)) return;
  if (await PN.onClick(t)) return;
  if (await WK.onClick(t)) return;
  if (await AI.onClick(t)) return;
  if (await PF.onClick(t, async () => (await read((db) => db.query(`SELECT id, code, name, stock_unit FROM item WHERE status='active' ORDER BY code`))).rows as never)) return;
  const pp = t.closest('[data-pick-po]') as HTMLElement | null; if (pp) { S.poId = pp.dataset.pickPo!; return render(); }
  const pq = t.closest('[data-pick-qc]') as HTMLElement | null; if (pq) { S.inspId = pq.dataset.pickQc!; return render(); }
  const pl = t.closest('[data-pick-lot]') as HTMLElement | null; if (pl) { S.lotId = S.lotId === pl.dataset.pickLot ? '' : pl.dataset.pickLot!; return render(); }
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b) return;
  const a = b.dataset.act!, id = b.dataset.id ?? '', v = Number(b.dataset.v ?? 0);
  switch (a) {
    case 'signout': return signOut();
    case 'toggle-newpo': { const its = (await read((db) => db.query(`SELECT id, code, name, stock_unit FROM item WHERE status='active' ORDER BY code`))).rows; const vs = (await read((db) => db.query(`SELECT id, code, name FROM partner WHERE status='active' AND is_vendor ORDER BY code`))).rows; if (PF.F.open) PF.F.open = false; else await PF.openNew(its, vs); await render(); if (PF.F.open) PF.requoteNow(); return; }
    case 'po-submit': return void act('Submitted for approval', async (c) => po.submitPO(c, { poId: S.poId, expectedVersion: await poVer(c) }));
    case 'po-approve': return void act('Approved', async (c) => po.approvePO(c, { poId: S.poId, expectedVersion: await poVer(c) }));
    case 'po-release': return void act('Released to vendor', async (c) => po.releasePO(c, { poId: S.poId, expectedVersion: await poVer(c) }));
    case 'po-return': return void act('Returned', async (c) => po.returnPO(c, { poId: S.poId, expectedVersion: await poVer(c), reason: reasonOr('') }));
    case 'po-cancel': return void act('Order closed', async (c) => po.cancelPO(c, { poId: S.poId, expectedVersion: await poVer(c), reason: reasonOr('') }));
    case 'po-amend': return void act('Amendment proposed. It applies only after approval', async (c) => {
      const lines = (await c.db.query('SELECT id, rate FROM po_line WHERE po_id=$1', [S.poId])).rows;
      const bump = (r: string) => (Math.round(Number(r) * 1.05 * 10000) / 10000).toFixed(4);
      return po.amendPO(c, { poId: S.poId, expectedVersion: await poVer(c), reason: reasonOr('Vendor price revision'), changes: lines.map((l) => ({ lineId: l.id, rate: bump(l.rate) })) });
    });
    case 'qc-start': return void act('Inspection started', (c) => qc.startInspection(c, { inspectionId: S.inspId }));
    case 'unreserve': return void act('Reservation released', (c) => inv.releaseReservation(c, { reservationId: id, reason: 'Released from the stock screen' }));
    case 'adj-yes': return void act('Adjustment approved', (c) => inv.approveAdjustment(c, { adjustmentId: id, expectedVersion: v, approve: true }));
    case 'adj-no': return void act('Adjustment rejected', (c) => inv.approveAdjustment(c, { adjustmentId: id, expectedVersion: v, approve: false }));
    case 'adj-post': return void act('Adjustment posted to the ledger', (c) => inv.postAdjustment(c, { adjustmentId: id, expectedVersion: v }));
    case 'walk': {
      S.running = true; S.log = []; await render();
      try { const r = await runWorkedExample(K.world, (s) => { S.log.push(s); scheduleRender(); }); S.poId = r.poId; S.lotId = r.lotId; toast('Worked example complete'); }
      catch (e) { toast((e as Error).message, 'bad'); }
      S.running = false; return render();
    }
    case 'reset': {
      b.textContent = 'Resetting…';
      try { await K.pool.db.close(); } catch { /* already closed */ }
      try { sessionStorage.removeItem('erp-token'); indexedDB.deleteDatabase('/pglite/' + dbName()); } catch { /* ignore */ }
      setTimeout(() => location.reload(), 400);
    }
  }
});

document.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = (ev.target as HTMLElement).closest('[data-form]') as HTMLElement | null; if (!f) return;
  if (f.dataset.form === 'login') { if (await signIn(val('lg-user'), (document.getElementById('lg-pass') as HTMLInputElement).value)) return render(); return render(); }
  if (await A.onSubmit(f.dataset.form!)) return;
  if (await H.onSubmit(f.dataset.form!)) return;
  if (await O.onSubmit(f.dataset.form!)) return;
  if (await P.onSubmit(f.dataset.form!)) return;
  if (await B.onSubmit(f.dataset.form!, ev)) return;
  if (await SL.onSubmit(f.dataset.form!, f)) return;
  if (await BM.onSubmit(f.dataset.form!, f)) return;
  if (await BK.onSubmit(f.dataset.form!, f, ev as SubmitEvent)) return;
  if (await PN.onSubmit(f.dataset.form!)) return;
  if (await WK.onSubmit(f.dataset.form!)) return;
  if (await MX.onSubmit(f.dataset.form!, f, ev as SubmitEvent)) return;
  if (await AI.onSubmit(f.dataset.form!, f)) return;
  switch (f.dataset.form) {
    case 'newpo': return void (await PF.onSubmit());
    case 'receive': {
      const [poLineId, itemId] = val('r-line').split('|'); const poId = val('r-po');
      return void act('Receipt posted. The roll is on QC hold', (c) => rcv.postReceipt(c, { siteId: K.world.siteId, partnerId: K.world.vendorId, poId, challanNo: val('r-challan'), lines: [{ poLineId, itemId, qty: val('r-qty') }] }));
    }
    case 'qc-submit': return void act('Recommendation recorded', async (c) => qc.submitInspection(c, { inspectionId: S.inspId, expectedVersion: await insVer(c), inspectedQty: val('q-sample'), recommendAccept: val('q-ra'), recommendReject: val('q-rr') }));
    case 'qc-disp': return void act('Disposition recorded', async (c) => qc.dispositionInspection(c, { inspectionId: S.inspId, expectedVersion: await insVer(c), acceptQty: val('d-acc'), rejectQty: val('d-rej') }));
    case 'reserve': return void act('Stock reserved', (c) => inv.reserveStock(c, { lotId: S.lotId, qty: val('s-qty'), demandType: 'cut_order', demandRef: val('s-ref') }));
    case 'putaway': return void act('Stock moved', async (c) => {
      const from = (await c.db.query(`SELECT location_id FROM stock_ledger WHERE lot_id=$1 AND status='ACCEPTED' GROUP BY location_id HAVING SUM(qty) > 0 ORDER BY SUM(qty) DESC LIMIT 1`, [S.lotId])).rows[0];
      if (!from) throw Object.assign(new Error('There is no accepted stock on this roll to move'), { code: 'NOTHING_TO_MOVE' });
      return inv.putaway(c, { lotId: S.lotId, fromLocationId: from.location_id, toLocationId: val('p-to'), qty: val('p-qty') });
    });
    case 'adjust': return void act('Adjustment proposed. A different person must approve it', async (c) => {
      const at = (await c.db.query(`SELECT location_id FROM stock_ledger WHERE lot_id=$1 AND status='ACCEPTED' GROUP BY location_id HAVING SUM(qty) > 0 ORDER BY SUM(qty) DESC LIMIT 1`, [S.lotId])).rows[0];
      return inv.proposeAdjustment(c, { lotId: S.lotId, locationId: at?.location_id ?? K.world.loc.rcv, qtyDelta: val('a-qty'), reason: val('a-reason') });
    });
  }
});

document.addEventListener('change', async (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === 'who') {
    const ok = await signIn(t.value, DEMO_PASSWORD);
    if (!ok) { toast(`Could not switch: ${loginError}. Sign in with that person's own password.`, 'bad'); S.user = ''; }
    return render();
  }
  if (await MX.onChange(t)) return;
  if (await BM.onChange(t)) return;
  if (await BK.onChange(t)) return;
  if (await PN.onChange(t)) return;
  if (await WK.onChange(t)) return;
  if (await AI.onChange(t)) return;
  if (t.dataset.perm) return A.togglePerm(t.dataset.perm);
  if (t.id === 'att-date' && t.value) { S.attDate = t.value; return render(); }
  if (t.hasAttribute('data-reload-po')) { S.poId = t.value; render(); }
});
document.addEventListener('input', async (ev) => {
  const t = ev.target as HTMLInputElement;
  if (await MX.onInput(t)) return;
  if (await BK.onInput(t)) return;
  if (t.id === 'filter') { S.filter = t.value; render(); }
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { const r = (ev.target as HTMLElement).closest('tr.pick') as HTMLElement | null; if (r) r.click(); } });

// ───────────── boot ─────────────
const dbName = () => `erp-demo-${__BUILD_ID__}`;
async function boot() {
  const stage = (s: string) => { $('#boot-msg').textContent = s; };
  try {
    stage('Loading the database engine…');
    const base = new URL('.', document.baseURI).href;
    const [wasm, initdb, data, seed] = await Promise.all([
      WebAssembly.compileStreaming(fetch(base + 'engine/pglite.wasm')),
      WebAssembly.compileStreaming(fetch(base + 'engine/initdb.wasm')),
      fetch(base + 'engine/pglite-data.ogg').then((r) => r.blob()),
      fetch(base + 'engine/demo-seed.ogg').then((r) => (r.ok ? r.blob() : null)).catch(() => null),
    ]);
    stage('Starting PostgreSQL in your browser…');
    const opts = { pgliteWasmModule: wasm, initdbWasmModule: initdb, fsBundle: data };
    const withSeed = seed ? { ...opts, loadDataDir: seed } : opts;
    const idbName = '/pglite/' + dbName();
    const exists = await indexedDB.databases?.().then((l) => l.some((d) => d.name === idbName)).catch(() => null) ?? null;
    try {
      K.pool = await LitePool.create('idb://' + dbName(), exists === true ? opts : withSeed);
      if (seed && !(await isSeeded(K.pool))) {       // an empty or half-made store: start again from the snapshot
        await K.pool.db.close(); indexedDB.deleteDatabase(idbName);
        K.pool = await LitePool.create('idb://' + dbName(), withSeed);
      }
    } catch { K.pool = await LitePool.create(undefined, withSeed); }   // storage blocked: run in memory
    K.world = await openWorld(K.pool, stage);
    try {
      const tok = sessionStorage.getItem('erp-token');
      if (tok) { const a = await actorFromToken(K.pool as never, tok); S.user = a.username; S.token = tok; S.mustChange = !!(await K.pool.query('SELECT must_change_password FROM app_user WHERE id=$1', [a.id])).rows[0]?.must_change_password; }
    } catch { /* no valid session: show sign-in */ }
    const h = location.hash.slice(1) as View; if (ALL_VIEWS.includes(h)) S.view = h;
    $('#boot').remove();
    await render();
  } catch (e) {
    $('#boot-msg').textContent = 'The demo could not start: ' + (e as Error).message;
    $('#boot').classList.add('failed');
    console.error(e);
  }
}
(window as unknown as { __erp: unknown }).__erp = { S, K };
void boot();
