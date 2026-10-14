import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan, assertIndependent, can, visibleSites } from '../core/permissions.js';
import { audit, emit } from '../core/audit.js';
import { badRequest, conflict, forbidden, invalidState, notFound, staleVersion } from '../core/errors.js';
import { nextNumber } from '../core/numbering.js';
import { fromScaled, lineAmount, norm, qAdd, qGt, qLt, qSub, toScaled } from '../core/qty.js';
import * as inv from './inventory.js';

/**
 * CRM and sales.
 *
 *   lead → follow-ups → customer (the normal partner approval) → quotation → sales order → approval by value → stock reserved → dispatch
 *
 * Rules built in: a salesperson cannot give more than MAX_DISCOUNT_PCT without the manager's right; an order is approved by someone other than
 * its creator, within their value band, and only while the customer's open orders stay under the credit limit (no limit set = no credit);
 * stock for an order is reserved lot by lot and leaves the ledger only on a dispatch by the storekeeper; a dispatch can never exceed the order.
 */
export const SALES_RULES = { maxDiscountPct: 10, quoteValidDays: 15 };

const LEAD_STATES = ['new', 'contacted', 'qualified', 'quoted', 'won', 'lost'];
const sum2 = (xs: string[]) => fromScaled(xs.reduce((a, b) => a + toScaled(b), 0n)).slice(0, -2);
const inr2 = (s: string) => s;

function discounted(qty: string, rate: string, pct: string): string {
  const a = toScaled(lineAmount(qty, rate));
  const bps = BigInt(Math.round(Number(pct) * 100));
  const v = (a * (10000n - bps) + 5000n) / 10000n;
  return fromScaled(((v + 50n) / 100n) * 100n).slice(0, -2);
}

// ───────────────────────── CRM ─────────────────────────
async function loadLead(db: Db, id: string, v?: number) {
  const l = (await db.query('SELECT * FROM crm_lead WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!l) throw notFound('Lead');
  if (v !== undefined && l.version !== v) throw staleVersion(v, l.version);
  return l;
}

export async function createLead(ctx: Ctx, i: { name: string; company?: string; phone?: string; email?: string; source?: string; interest?: string; estValue?: string; nextFollowUp?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'crm.manage', { anySite: true });
  if (!i.name?.trim()) throw badRequest('A lead needs a name');
  if (i.email && !/^\S+@\S+\.\S+$/.test(i.email)) throw badRequest('That email address does not look right');
  const dup = (await ctx.db.query(`SELECT number FROM crm_lead WHERE status NOT IN ('won','lost') AND ((phone IS NOT NULL AND phone = $1) OR (email IS NOT NULL AND lower(email) = lower($2)))`, [i.phone ?? null, i.email ?? null])).rows[0];
  if (dup) throw badRequest(`This looks like lead ${dup.number}, which is still open`);
  const r = (await ctx.db.query(
    `INSERT INTO crm_lead(name, company, phone, email, source, interest, est_value, owner_id, next_follow_up, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8) RETURNING *`,
    [i.name.trim(), i.company ?? null, i.phone ?? null, i.email ?? null, i.source ?? null, i.interest ?? null, i.estValue ?? '0', ctx.actor.id, i.nextFollowUp ?? null])).rows[0];
  await audit(ctx, { action: 'crm.lead.create', entityType: 'crm_lead', entityId: r.id, after: { number: r.number, name: r.name } });
  return r;
}

export async function setLeadStatus(ctx: Ctx, i: { leadId: string; status: string; reason?: string; expectedVersion: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'crm.manage', { anySite: true });
  const l = await loadLead(ctx.db, i.leadId, i.expectedVersion);
  if (!['contacted', 'qualified', 'lost'].includes(i.status)) throw badRequest('A lead is moved to contacted, qualified or lost. It becomes quoted and won through quotations and orders.');
  if (['won', 'lost'].includes(l.status)) throw invalidState(`Lead is already ${l.status}`);
  if (i.status === 'lost' && !i.reason?.trim()) throw badRequest('Say why the lead was lost');
  if (LEAD_STATES.indexOf(i.status) < LEAD_STATES.indexOf(l.status) && i.status !== 'lost') throw invalidState(`Lead is already ${l.status}`);
  const r = (await ctx.db.query(`UPDATE crm_lead SET status=$2, lost_reason=$3, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`, [l.id, i.status, i.reason ?? null])).rows[0];
  await audit(ctx, { action: 'crm.lead.status', entityType: 'crm_lead', entityId: l.id, before: { status: l.status }, after: { status: i.status }, reason: i.reason ?? null });
  return r;
}

export async function addActivity(ctx: Ctx, i: { leadId?: string; customerId?: string; kind: string; summary: string; dueDate?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'crm.manage', { anySite: true });
  if (!i.leadId && !i.customerId) throw badRequest('Say which lead or customer this is about');
  if (!['call', 'visit', 'email', 'meeting', 'note'].includes(i.kind)) throw badRequest('Unknown kind of activity');
  if (!i.summary?.trim()) throw badRequest('Write what happened or what to do');
  if (i.leadId) await loadLead(ctx.db, i.leadId);
  const todo = !!i.dueDate;
  const r = (await ctx.db.query(`INSERT INTO crm_activity(lead_id, customer_id, kind, summary, due_date, done, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [i.leadId ?? null, i.customerId ?? null, i.kind, i.summary.trim(), i.dueDate ?? null, !todo, ctx.actor.id])).rows[0];
  if (i.leadId) await ctx.db.query(`UPDATE crm_lead SET updated_at=now(), next_follow_up = COALESCE($2::date, next_follow_up), status = CASE WHEN status='new' AND $3 <> 'note' THEN 'contacted' ELSE status END, version=version+1 WHERE id=$1`, [i.leadId, i.dueDate ?? null, i.kind]);
  await audit(ctx, { action: 'crm.activity', entityType: 'crm_activity', entityId: r.id, after: { kind: i.kind, due: i.dueDate ?? null } });
  return r;
}

export async function completeActivity(ctx: Ctx, i: { activityId: string; outcome?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'crm.manage', { anySite: true });
  const a = (await ctx.db.query('SELECT * FROM crm_activity WHERE id=$1 FOR UPDATE', [i.activityId])).rows[0];
  if (!a) throw notFound('Activity');
  if (a.done) throw invalidState('Already done');
  const r = (await ctx.db.query(`UPDATE crm_activity SET done=true, summary = summary || COALESCE(' → ' || $2::text, '') WHERE id=$1 RETURNING *`, [a.id, i.outcome ?? null])).rows[0];
  await audit(ctx, { action: 'crm.activity.done', entityType: 'crm_activity', entityId: a.id });
  return r;
}

export async function listLeads(db: Db, userId: string) {
  if (!(await can(db, userId, 'crm.view', { anySite: true }))) return null;
  const leads = (await db.query(
    `SELECT l.*, u.username AS owner, (l.next_follow_up IS NOT NULL AND l.next_follow_up < current_date AND l.status NOT IN ('won','lost')) AS overdue
       FROM crm_lead l JOIN app_user u ON u.id = l.owner_id ORDER BY l.updated_at DESC LIMIT 300`)).rows;
  const todo = (await db.query(
    `SELECT a.id, a.kind, a.summary, to_char(a.due_date,'YYYY-MM-DD') AS due_date, a.lead_id, l.number AS lead_number, l.name AS lead_name, (a.due_date < current_date) AS overdue
       FROM crm_activity a LEFT JOIN crm_lead l ON l.id = a.lead_id WHERE NOT a.done ORDER BY a.due_date LIMIT 50`)).rows;
  return { leads, todo };
}
export async function getLead(db: Db, userId: string, id: string) {
  if (!(await can(db, userId, 'crm.view', { anySite: true }))) throw notFound('Lead');
  const lead = (await db.query(`SELECT l.*, u.username AS owner FROM crm_lead l JOIN app_user u ON u.id = l.owner_id WHERE l.id=$1`, [id])).rows[0];
  if (!lead) throw notFound('Lead');
  const acts = (await db.query(`SELECT a.*, u.username AS by FROM crm_activity a JOIN app_user u ON u.id = a.created_by WHERE a.lead_id=$1 ORDER BY a.created_at DESC`, [id])).rows;
  return { lead, activities: acts };
}

// ───────────────────────── Customers ─────────────────────────
/** Open order value for a customer: confirmed orders, less what has already gone out. */
export async function exposure(db: Db, customerId: string): Promise<string> {
  const r = (await db.query(
    `SELECT COALESCE(sum(l.amount * (l.qty - l.dispatched_qty) / l.qty),0)::numeric(16,2)::text AS v
       FROM so_line l JOIN sales_order o ON o.id = l.so_id WHERE o.customer_id = $1 AND o.status IN ('confirmed','part_dispatched')`, [customerId])).rows[0].v;
  return norm(r).slice(0, -2);
}

export async function listCustomers(db: Db, userId: string) {
  if (!(await can(db, userId, 'partner.view', { anySite: true })) && !(await can(db, userId, 'so.view', { anySite: true }))) return [];
  const rows = (await db.query(
    `SELECT p.id, p.code, p.name, p.status, p.gstin, COALESCE(t.credit_limit,0)::text AS credit_limit, t.payment_days
       FROM partner p LEFT JOIN customer_terms t ON t.partner_id = p.id WHERE p.is_customer ORDER BY p.name`)).rows;
  for (const r of rows) r.exposure = await exposure(db, r.id);
  return rows;
}

export async function setCreditTerms(ctx: Ctx, i: { partnerId: string; creditLimit: string; paymentDays?: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'customer.terms', { anySite: true });
  const p = (await ctx.db.query('SELECT id, is_customer, code FROM partner WHERE id=$1', [i.partnerId])).rows[0];
  if (!p?.is_customer) throw notFound('Customer');
  if (!(Number(i.creditLimit) >= 0)) throw badRequest('Credit limit must be zero or more');
  const before = (await ctx.db.query('SELECT credit_limit, payment_days FROM customer_terms WHERE partner_id=$1', [p.id])).rows[0] ?? null;
  await ctx.db.query(
    `INSERT INTO customer_terms(partner_id, credit_limit, payment_days, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (partner_id) DO UPDATE SET credit_limit=EXCLUDED.credit_limit, payment_days=EXCLUDED.payment_days, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [p.id, i.creditLimit, i.paymentDays ?? 30, ctx.actor.id]);
  await audit(ctx, { action: 'customer.terms', entityType: 'partner', entityId: p.id, before, after: { credit_limit: i.creditLimit, payment_days: i.paymentDays ?? 30 } });
  return { ok: true };
}

// ───────────────────────── Quotations ─────────────────────────
export interface SalesLineInput { itemId: string; qty: string; rate: string; discPct?: string }

async function buildLines(ctx: Ctx, lines: SalesLineInput[], canOverDiscount: boolean) {
  if (!lines?.length) throw badRequest('At least one line is needed');
  const out = [];
  for (const l of lines) {
    if (!qGt(l.qty, '0')) throw badRequest('Quantity must be positive');
    if (!(Number(l.rate) >= 0) || l.rate === '') throw badRequest('Give a rate for every line');
    const pct = l.discPct ?? '0';
    if (!(Number(pct) >= 0 && Number(pct) <= 100)) throw badRequest('Discount must be between 0 and 100');
    if (Number(pct) > SALES_RULES.maxDiscountPct && !canOverDiscount) throw forbidden(`A discount above ${SALES_RULES.maxDiscountPct}% needs the sales manager`);
    const it = (await ctx.db.query('SELECT id, code, status, stock_unit FROM item WHERE id=$1', [l.itemId])).rows[0];
    if (!it) throw notFound('Item');
    if (it.status !== 'active') throw invalidState(`Item ${it.code} is ${it.status}; only released items can be sold`);
    out.push({ itemId: l.itemId, qty: l.qty, unit: it.stock_unit, rate: l.rate, discPct: pct, amount: discounted(l.qty, l.rate, pct) });
  }
  return out;
}
async function activeCustomer(db: Db, id: string) {
  const c = (await db.query('SELECT id, code, name, status, is_customer FROM partner WHERE id=$1', [id])).rows[0];
  if (!c || !c.is_customer) throw notFound('Customer');
  if (c.status !== 'active') throw invalidState(`Customer ${c.code} is ${c.status}; it must be approved first`);
  return c;
}
async function loadQuote(db: Db, id: string, v?: number) {
  const q = (await db.query('SELECT * FROM quotation WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!q) throw notFound('Quotation');
  if (v !== undefined && q.version !== v) throw staleVersion(v, q.version);
  return q;
}

export async function createQuote(ctx: Ctx, i: { siteId: string; customerId: string; leadId?: string; validUntil?: string; lines: SalesLineInput[]; notes?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'quote.create', { siteId: i.siteId });
  await activeCustomer(ctx.db, i.customerId);
  const over = await can(ctx.db, ctx.actor.id, 'quote.discount.over', { siteId: i.siteId });
  const lines = await buildLines(ctx, i.lines, over);
  const valid = i.validUntil ?? new Date(Date.now() + SALES_RULES.quoteValidDays * 86400000).toISOString().slice(0, 10);
  if (valid < new Date().toISOString().slice(0, 10)) throw badRequest('“Valid until” is in the past');
  const number = await nextNumber(ctx, i.siteId, 'QT');
  const q = (await ctx.db.query(`INSERT INTO quotation(site_id, number, customer_id, lead_id, valid_until, total, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [i.siteId, number, i.customerId, i.leadId ?? null, valid, sum2(lines.map((l) => l.amount)), i.notes ?? null, ctx.actor.id])).rows[0];
  for (const [n, l] of lines.entries())
    await ctx.db.query(`INSERT INTO quotation_line(quotation_id, line_no, item_id, qty, unit, rate, disc_pct, amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [q.id, n + 1, l.itemId, l.qty, l.unit, l.rate, l.discPct, l.amount]);
  if (i.leadId) await ctx.db.query(`UPDATE crm_lead SET status='quoted', customer_id=$2, updated_at=now(), version=version+1 WHERE id=$1 AND status NOT IN ('won','lost')`, [i.leadId, i.customerId]);
  await audit(ctx, { action: 'quote.create', entityType: 'quotation', entityId: q.id, after: { number, total: q.total } });
  return q;
}

export async function sendQuote(ctx: Ctx, i: { quoteId: string; expectedVersion: number }) {
  const q = await loadQuote(ctx.db, i.quoteId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'quote.send', { siteId: q.site_id });
  if (q.status !== 'draft') throw invalidState(`Quotation is ${q.status}`);
  const r = (await ctx.db.query(`UPDATE quotation SET status='sent', version=version+1 WHERE id=$1 RETURNING *`, [q.id])).rows[0];
  await audit(ctx, { action: 'quote.send', entityType: 'quotation', entityId: q.id });
  return r;
}

export async function decideQuote(ctx: Ctx, i: { quoteId: string; expectedVersion: number; accepted: boolean; reason?: string }) {
  const q = await loadQuote(ctx.db, i.quoteId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'quote.send', { siteId: q.site_id });
  if (q.status !== 'sent') throw invalidState(`Quotation is ${q.status}; record the customer's answer once it has been sent`);
  if (i.accepted && q.valid_until < new Date().toISOString().slice(0, 10)) throw invalidState('This quotation has expired; make a new one');
  if (!i.accepted && !i.reason?.trim()) throw badRequest('Note why the customer said no');
  const r = (await ctx.db.query(`UPDATE quotation SET status=$2, notes = COALESCE(notes,'') || COALESCE(E'\\n' || $3::text,''), version=version+1 WHERE id=$1 RETURNING *`, [q.id, i.accepted ? 'accepted' : 'rejected', i.reason ?? null])).rows[0];
  if (!i.accepted && q.lead_id) await ctx.db.query(`UPDATE crm_lead SET status='lost', lost_reason=$2, updated_at=now(), version=version+1 WHERE id=$1 AND status='quoted'`, [q.lead_id, i.reason]);
  await audit(ctx, { action: i.accepted ? 'quote.accept' : 'quote.reject', entityType: 'quotation', entityId: q.id, reason: i.reason ?? null });
  return r;
}

export async function cancelQuote(ctx: Ctx, i: { quoteId: string; expectedVersion: number; reason: string }) {
  const q = await loadQuote(ctx.db, i.quoteId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'quote.create', { siteId: q.site_id });
  if (!['draft', 'sent'].includes(q.status)) throw invalidState(`Quotation is ${q.status}`);
  if (!i.reason?.trim()) throw badRequest('A reason is required');
  const r = (await ctx.db.query(`UPDATE quotation SET status='cancelled', version=version+1 WHERE id=$1 RETURNING *`, [q.id])).rows[0];
  await audit(ctx, { action: 'quote.cancel', entityType: 'quotation', entityId: q.id, reason: i.reason });
  return r;
}

export async function listQuotes(db: Db, userId: string) {
  const sites = await visibleSites(db, userId, 'so.view');
  const s2 = await visibleSites(db, userId, 'quote.create');
  const allowed = sites === null || s2 === null ? null : [...new Set([...(sites ?? []), ...(s2 ?? [])])];
  if (allowed && !allowed.length) return [];
  return (await db.query(
    `SELECT q.id, q.number, q.status, q.total, q.valid_until::text, q.version, q.site_id, c.name AS customer, (q.status='sent' AND q.valid_until < current_date) AS expired
       FROM quotation q JOIN partner c ON c.id = q.customer_id WHERE ($1::uuid[] IS NULL OR q.site_id = ANY($1::uuid[])) ORDER BY q.created_at DESC LIMIT 200`, [allowed])).rows;
}
export async function getQuote(db: Db, userId: string, id: string) {
  const q = (await db.query(`SELECT q.*, c.name AS customer, c.code AS customer_code FROM quotation q JOIN partner c ON c.id = q.customer_id WHERE q.id=$1`, [id])).rows[0];
  if (!q) throw notFound('Quotation');
  const sites = [await visibleSites(db, userId, 'so.view'), await visibleSites(db, userId, 'quote.create')];
  if (!sites.some((s) => s === null || s.includes(q.site_id))) throw notFound('Quotation');
  const lines = (await db.query(`SELECT l.*, i.code AS item_code, i.name AS item_name FROM quotation_line l JOIN item i ON i.id = l.item_id WHERE l.quotation_id=$1 ORDER BY l.line_no`, [id])).rows;
  return { ...q, lines };
}

// ───────────────────────── Sales orders ─────────────────────────
async function loadOrder(db: Db, id: string, v?: number) {
  const o = (await db.query('SELECT * FROM sales_order WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!o) throw notFound('Sales order');
  if (v !== undefined && o.version !== v) throw staleVersion(v, o.version);
  return o;
}
const bumpO = async (ctx: Ctx, id: string, set: string, params: unknown[] = []) =>
  (await ctx.db.query(`UPDATE sales_order SET ${set}, version = version + 1 WHERE id=$1 RETURNING *`, [id, ...params])).rows[0];

export async function createOrder(ctx: Ctx, i: { siteId: string; customerId?: string; quoteId?: string; dueDate?: string; lines?: SalesLineInput[] }) {
  await assertCan(ctx.db, ctx.actor.id, 'so.create', { siteId: i.siteId });
  let customerId = i.customerId, lines = i.lines, quoteId: string | null = null;
  if (i.quoteId) {
    const q = await loadQuote(ctx.db, i.quoteId);
    if (q.status !== 'accepted') throw invalidState('Only an accepted quotation can become an order');
    if (q.site_id !== i.siteId) throw badRequest('The quotation belongs to another site');
    if ((await ctx.db.query('SELECT 1 FROM sales_order WHERE quotation_id=$1 AND status <> \'cancelled\'', [q.id])).rowCount) throw invalidState('This quotation already has an order');
    customerId = q.customer_id; quoteId = q.id;
    lines = (await ctx.db.query('SELECT item_id, qty, rate, disc_pct FROM quotation_line WHERE quotation_id=$1 ORDER BY line_no', [q.id])).rows.map((r) => ({ itemId: r.item_id, qty: norm(r.qty), rate: norm(r.rate), discPct: String(r.disc_pct) }));
  }
  if (!customerId) throw badRequest('Choose a customer');
  await activeCustomer(ctx.db, customerId);
  const over = await can(ctx.db, ctx.actor.id, 'quote.discount.over', { siteId: i.siteId });
  const built = await buildLines(ctx, lines ?? [], over || !!quoteId);        // a quoted price was already checked
  const number = await nextNumber(ctx, i.siteId, 'SO');
  const o = (await ctx.db.query(`INSERT INTO sales_order(site_id, number, customer_id, quotation_id, total, due_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [i.siteId, number, customerId, quoteId, sum2(built.map((l) => l.amount)), i.dueDate ?? null, ctx.actor.id])).rows[0];
  for (const [n, l] of built.entries())
    await ctx.db.query(`INSERT INTO so_line(so_id, line_no, item_id, qty, unit, rate, disc_pct, amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [o.id, n + 1, l.itemId, l.qty, l.unit, l.rate, l.discPct, l.amount]);
  await audit(ctx, { action: 'so.create', entityType: 'sales_order', entityId: o.id, after: { number, total: o.total, quote: quoteId } });
  return o;
}

export async function submitOrder(ctx: Ctx, i: { orderId: string; expectedVersion: number }) {
  const o = await loadOrder(ctx.db, i.orderId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'so.submit', { siteId: o.site_id });
  if (o.status !== 'draft') throw invalidState(`Order is ${o.status}`);
  const u = await bumpO(ctx, o.id, `status='approval_pending'`);
  await audit(ctx, { action: 'so.submit', entityType: 'sales_order', entityId: o.id });
  return u;
}

export async function approveOrder(ctx: Ctx, i: { orderId: string; expectedVersion: number }) {
  const o = await loadOrder(ctx.db, i.orderId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'so.approve', { siteId: o.site_id, amount: o.total });
  if (o.status !== 'approval_pending') throw invalidState(`Order is ${o.status}; only submitted orders are approved`);
  assertIndependent(ctx.actor.id, o.created_by, 'sales order');
  const terms = (await ctx.db.query('SELECT credit_limit FROM customer_terms WHERE partner_id=$1', [o.customer_id])).rows[0];
  const limit = terms ? terms.credit_limit : '0';
  if (!qGt(norm(limit), '0')) throw conflict('NO_CREDIT', 'No credit limit is set for this customer. The sales manager must set one before orders can be approved.');
  const open = await exposure(ctx.db, o.customer_id);
  const after = fromScaled(toScaled(open) + toScaled(o.total)).slice(0, -2);
  if (qGt(norm(after), norm(limit))) throw conflict('CREDIT_LIMIT', `This order would take the customer to ₹${after} of open orders; the credit limit is ₹${limit}.`, { open, total: o.total, limit });
  const u = await bumpO(ctx, o.id, `status='confirmed', approved_by=$2`, [ctx.actor.id]);
  await audit(ctx, { action: 'so.approve', entityType: 'sales_order', entityId: o.id, before: { status: o.status }, after: { status: 'confirmed', openAfter: after } });
  await emit(ctx, { type: 'so.confirmed', entityType: 'sales_order', entityId: o.id, version: u.version, siteId: o.site_id, payload: { number: o.number, total: o.total } });
  if (o.quotation_id) { const l = (await ctx.db.query('SELECT lead_id FROM quotation WHERE id=$1', [o.quotation_id])).rows[0]?.lead_id; if (l) await ctx.db.query(`UPDATE crm_lead SET status='won', updated_at=now(), version=version+1 WHERE id=$1 AND status <> 'lost'`, [l]); }
  return u;
}

export async function returnOrder(ctx: Ctx, i: { orderId: string; expectedVersion: number; reason: string }) {
  const o = await loadOrder(ctx.db, i.orderId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'so.approve', { siteId: o.site_id });
  if (o.status !== 'approval_pending') throw invalidState(`Order is ${o.status}`);
  if (!i.reason?.trim()) throw badRequest('A reason is required');
  const u = await bumpO(ctx, o.id, `status='draft'`);
  await audit(ctx, { action: 'so.return', entityType: 'sales_order', entityId: o.id, reason: i.reason });
  return u;
}

export async function cancelOrder(ctx: Ctx, i: { orderId: string; expectedVersion: number; reason: string }) {
  const o = await loadOrder(ctx.db, i.orderId, i.expectedVersion);
  if (!(await can(ctx.db, ctx.actor.id, 'so.cancel', { siteId: o.site_id })) && !(o.status === 'draft' && o.created_by === ctx.actor.id)) throw forbidden('Not permitted: so.cancel');
  if (!['draft', 'approval_pending', 'confirmed'].includes(o.status)) throw invalidState(`Order is ${o.status}; goods have already gone out`);
  if (!i.reason?.trim()) throw badRequest('A reason is required');
  await ctx.db.query(`UPDATE reservation SET status='released', released_at=now(), reason='Order cancelled' WHERE demand_type='sales_order' AND demand_ref LIKE $1 AND status='active'`, [o.number + '#%']);
  const u = await bumpO(ctx, o.id, `status='cancelled', cancel_reason=$2`, [i.reason]);
  await audit(ctx, { action: 'so.cancel', entityType: 'sales_order', entityId: o.id, reason: i.reason });
  return u;
}

/** Hold stock from a lot for one order line. Reuses the stock engine, so it can never promise more than is free. */
export async function allocate(ctx: Ctx, i: { orderId: string; lineId: string; lotId: string; qty: string }) {
  const o = await loadOrder(ctx.db, i.orderId);
  await assertCan(ctx.db, ctx.actor.id, 'reservation.allocate', { siteId: o.site_id });
  if (!['confirmed', 'part_dispatched'].includes(o.status)) throw invalidState(`Order is ${o.status}; stock is held only for confirmed orders`);
  const l = (await ctx.db.query('SELECT * FROM so_line WHERE id=$1 AND so_id=$2', [i.lineId, o.id])).rows[0];
  if (!l) throw notFound('Order line');
  const lot = (await ctx.db.query('SELECT item_id, site_id FROM lot WHERE id=$1', [i.lotId])).rows[0];
  if (!lot || lot.item_id !== l.item_id) throw badRequest('That roll is a different item');
  if (lot.site_id !== o.site_id) throw badRequest('That roll is at another site');
  const held = (await ctx.db.query(`SELECT COALESCE(sum(qty),0)::text AS q FROM reservation WHERE demand_type='sales_order' AND demand_ref=$1 AND status='active'`, [`${o.number}#${l.line_no}`])).rows[0].q;
  const outstanding = qSub(norm(l.qty), norm(l.dispatched_qty));
  if (qGt(qAdd(norm(held), i.qty), outstanding)) throw conflict('OVER_ALLOCATED', `Only ${qSub(outstanding, norm(held))} still needs stock on this line`);
  return inv.reserveStock(ctx, { lotId: i.lotId, qty: i.qty, demandType: 'sales_order', demandRef: `${o.number}#${l.line_no}` });
}

/** Goods leave. Reduces the order's reservations first, then posts one outbound ledger movement per roll. */
export async function dispatch(ctx: Ctx, i: { orderId: string; vehicleNo?: string; lrNo?: string; lines: { lineId: string; lotId: string; locationId: string; qty: string }[] }) {
  const o = await loadOrder(ctx.db, i.orderId);
  await assertCan(ctx.db, ctx.actor.id, 'dispatch.post', { siteId: o.site_id });
  if (!['confirmed', 'part_dispatched'].includes(o.status)) throw invalidState(`Order is ${o.status}; only confirmed orders are dispatched`);
  if (!i.lines?.length) throw badRequest('Choose what is going out');
  const number = await nextNumber(ctx, o.site_id, 'DN');
  const d = (await ctx.db.query(`INSERT INTO dispatch(site_id, number, so_id, vehicle_no, lr_no, dispatched_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [o.site_id, number, o.id, i.vehicleNo ?? null, i.lrNo ?? null, ctx.actor.id])).rows[0];
  for (const x of i.lines) {
    if (!qGt(x.qty, '0')) throw badRequest('Quantity must be positive');
    const l = (await ctx.db.query('SELECT * FROM so_line WHERE id=$1 AND so_id=$2 FOR UPDATE', [x.lineId, o.id])).rows[0];
    if (!l) throw notFound('Order line');
    const left = qSub(norm(l.qty), norm(l.dispatched_qty));
    if (qGt(x.qty, left)) throw conflict('OVER_DISPATCH', `Only ${left} ${l.unit} is left to send on line ${l.line_no}`);
    const lot = (await ctx.db.query('SELECT id, item_id, site_id FROM lot WHERE id=$1', [x.lotId])).rows[0];
    if (!lot || lot.item_id !== l.item_id || lot.site_id !== o.site_id) throw badRequest('That roll does not match the order line');
    const loc = (await ctx.db.query('SELECT id, site_id, kind FROM location WHERE id=$1', [x.locationId])).rows[0];
    if (!loc || loc.site_id !== o.site_id) throw notFound('Location');
    if (!['RECEIVING', 'STORE', 'RACK'].includes(loc.kind)) throw conflict('LOCATION_NOT_ALLOWED', 'Goods are dispatched from receiving, store or rack');
    // what this order has reserved on this roll is released first, in order
    const ref = `${o.number}#${l.line_no}`;
    let need = x.qty;
    const reserved = (await ctx.db.query(`SELECT id, qty FROM reservation WHERE lot_id=$1 AND demand_type='sales_order' AND demand_ref=$2 AND status='active' ORDER BY created_at, id FOR UPDATE`, [lot.id, ref])).rows;
    const mine = reserved.reduce((s, r) => qAdd(s, norm(r.qty)), '0');
    const extra = qGt(x.qty, mine) ? qSub(x.qty, mine) : '0';
    if (qGt(extra, '0')) { const a = await inv.availability(ctx.db, lot.id); if (qGt(extra, a.available)) throw conflict('INSUFFICIENT_AVAILABLE', `Only ${a.available} of this roll is free beyond what is reserved for this order`); }
    for (const r of reserved) {
      if (!qGt(need, '0')) break;
      if (!qLt(norm(r.qty), need)) { // reservation covers the rest
        const rest = qSub(norm(r.qty), need);
        if (qGt(rest, '0')) { await ctx.db.query('UPDATE reservation SET qty=$2 WHERE id=$1', [r.id, rest]); await ctx.db.query(`INSERT INTO reservation(site_id, lot_id, qty, demand_type, demand_ref, status, requested_by, released_at, reason) VALUES ($1,$2,$3,'sales_order',$4,'consumed',$5,now(),$6)`, [o.site_id, lot.id, need, ref, ctx.actor.id, 'Dispatched ' + number]); }
        else await ctx.db.query(`UPDATE reservation SET status='consumed', released_at=now(), reason=$2 WHERE id=$1`, [r.id, 'Dispatched ' + number]);
        need = '0';
      } else { await ctx.db.query(`UPDATE reservation SET status='consumed', released_at=now(), reason=$2 WHERE id=$1`, [r.id, 'Dispatched ' + number]); need = qSub(need, norm(r.qty)); }
    }
    const unit = l.unit;
    await inv.postMovement(ctx, { type: 'DISPATCH', sourceType: 'dispatch', sourceId: d.id, consumesReservation: true, legs: [{ siteId: o.site_id, lotId: lot.id, itemId: lot.item_id, locationId: loc.id, status: 'ACCEPTED', qty: qSub('0', x.qty), unit }] });
    await ctx.db.query('UPDATE so_line SET dispatched_qty = dispatched_qty + $2 WHERE id=$1', [l.id, x.qty]);
    await ctx.db.query('INSERT INTO dispatch_line(dispatch_id, so_line_id, lot_id, location_id, qty) VALUES ($1,$2,$3,$4,$5)', [d.id, l.id, lot.id, loc.id, x.qty]);
  }
  const left = (await ctx.db.query('SELECT count(*)::int AS n FROM so_line WHERE so_id=$1 AND dispatched_qty < qty', [o.id])).rows[0].n;
  const u = await bumpO(ctx, o.id, `status=$2`, [left ? 'part_dispatched' : 'dispatched']);
  await audit(ctx, { action: 'so.dispatch', entityType: 'sales_order', entityId: o.id, after: { dispatch: number, status: u.status } });
  await emit(ctx, { type: 'so.dispatched', entityType: 'sales_order', entityId: o.id, version: u.version, siteId: o.site_id, payload: { number: o.number, dispatch: number } });
  return { dispatch: d, order: u };
}

export async function listOrders(db: Db, userId: string) {
  const sites = await visibleSites(db, userId, 'so.view');
  if (sites && !sites.length) return [];
  return (await db.query(
    `SELECT o.id, o.number, o.status, o.total, o.version, o.site_id, o.due_date::text, c.name AS customer, to_char(o.created_at,'YYYY-MM-DD') AS date,
            (o.due_date IS NOT NULL AND o.due_date < current_date AND o.status IN ('confirmed','part_dispatched')) AS late
       FROM sales_order o JOIN partner c ON c.id = o.customer_id WHERE ($1::uuid[] IS NULL OR o.site_id = ANY($1::uuid[])) ORDER BY o.created_at DESC LIMIT 200`, [sites])).rows;
}

export async function getOrder(db: Db, userId: string, id: string) {
  const o = (await db.query(`SELECT o.*, c.name AS customer, c.code AS customer_code, cb.username AS created_name FROM sales_order o JOIN partner c ON c.id = o.customer_id JOIN app_user cb ON cb.id = o.created_by WHERE o.id=$1`, [id])).rows[0];
  if (!o) throw notFound('Sales order');
  const sites = await visibleSites(db, userId, 'so.view');
  if (sites && !sites.includes(o.site_id)) throw notFound('Sales order');
  const lines = (await db.query(
    `SELECT l.*, i.code AS item_code, i.name AS item_name,
            COALESCE((SELECT sum(r.qty) FROM reservation r WHERE r.demand_type='sales_order' AND r.demand_ref = $2 || '#' || l.line_no AND r.status='active'),0)::text AS reserved
       FROM so_line l JOIN item i ON i.id = l.item_id WHERE l.so_id=$1 ORDER BY l.line_no`, [id, o.number])).rows.map((l) => ({ ...l, reserved: norm(l.reserved) }));
  const dispatches = (await db.query(
    `SELECT d.number, d.vehicle_no, d.lr_no, to_char(d.dispatched_at,'YYYY-MM-DD HH24:MI') AS at, u.username AS by,
            (SELECT json_agg(json_build_object('lot', lot.label, 'qty', dl.qty::text, 'from', loc.code)) FROM dispatch_line dl JOIN lot ON lot.id = dl.lot_id JOIN location loc ON loc.id = dl.location_id WHERE dl.dispatch_id = d.id) AS lines
       FROM dispatch d JOIN app_user u ON u.id = d.dispatched_by WHERE d.so_id=$1 ORDER BY d.dispatched_at`, [id])).rows;
  const terms = (await db.query('SELECT credit_limit::text AS credit_limit FROM customer_terms WHERE partner_id=$1', [o.customer_id])).rows[0];
  return { ...o, lines, dispatches, creditLimit: terms?.credit_limit ?? '0', exposure: await exposure(db, o.customer_id) };
}

/** Rolls that could fill an order line right now (same item, free stock), for the allocation and dispatch pickers. */
export async function stockForLine(db: Db, userId: string, lineId: string) {
  const l = (await db.query('SELECT l.item_id, o.site_id FROM so_line l JOIN sales_order o ON o.id = l.so_id WHERE l.id=$1', [lineId])).rows[0];
  if (!l) throw notFound('Order line');
  const sites = await visibleSites(db, userId, 'inventory.view');
  if (sites && !sites.includes(l.site_id)) throw notFound('Order line');
  const lots = (await db.query(`SELECT id, label FROM lot WHERE item_id=$1 AND site_id=$2 ORDER BY created_at`, [l.item_id, l.site_id])).rows;
  const out = [];
  for (const lot of lots) {
    const a = await inv.availability(db, lot.id);
    const where = (await db.query(
      `SELECT loc.id AS location_id, loc.code, sum(sl.qty)::text AS qty FROM stock_ledger sl JOIN location loc ON loc.id = sl.location_id
        WHERE sl.lot_id=$1 AND sl.status='ACCEPTED' AND loc.kind IN ('RECEIVING','STORE','RACK') GROUP BY loc.id, loc.code HAVING sum(sl.qty) > 0 ORDER BY loc.code`, [lot.id])).rows.map((w) => ({ ...w, qty: norm(w.qty) }));
    if (where.length) out.push({ lotId: lot.id, label: lot.label, available: a.available, reserved: a.reserved, where });
  }
  return out;
}

/** Numbers for the sales desk: open pipeline, what is waiting to go out, and sales by month. */
export async function salesSummary(db: Db, userId: string) {
  const sites = await visibleSites(db, userId, 'so.view');
  const crm = await can(db, userId, 'crm.view', { anySite: true });
  const sales = !(sites && !sites.length) ? await (async () => {
    const q = (sql: string) => db.query(sql, [sites]).then((r) => r.rows);
    const [tot] = await q(`SELECT COALESCE(sum(total) FILTER (WHERE status IN ('confirmed','part_dispatched','dispatched')),0)::float8 AS booked,
        COALESCE(sum(total) FILTER (WHERE status='approval_pending'),0)::float8 AS awaiting,
        count(*) FILTER (WHERE status IN ('confirmed','part_dispatched'))::int AS open_orders,
        count(*) FILTER (WHERE status IN ('confirmed','part_dispatched') AND due_date < current_date)::int AS late
      FROM sales_order WHERE ($1::uuid[] IS NULL OR site_id = ANY($1::uuid[]))`);
    const [out] = await q(`SELECT COALESCE(sum(l.amount * (l.qty - l.dispatched_qty) / l.qty),0)::float8 AS to_ship FROM so_line l JOIN sales_order o ON o.id = l.so_id WHERE o.status IN ('confirmed','part_dispatched') AND ($1::uuid[] IS NULL OR o.site_id = ANY($1::uuid[]))`);
    const months = await q(`SELECT to_char(created_at,'YYYY-MM') AS month, sum(total)::float8 AS total FROM sales_order WHERE status IN ('confirmed','part_dispatched','dispatched') AND created_at > now() - interval '6 months' AND ($1::uuid[] IS NULL OR site_id = ANY($1::uuid[])) GROUP BY 1 ORDER BY 1`);
    const top = await q(`SELECT c.name AS customer, sum(o.total)::float8 AS total FROM sales_order o JOIN partner c ON c.id = o.customer_id WHERE o.status IN ('confirmed','part_dispatched','dispatched') AND ($1::uuid[] IS NULL OR o.site_id = ANY($1::uuid[])) GROUP BY 1 ORDER BY 2 DESC LIMIT 5`);
    return { ...tot, to_ship: out.to_ship, months, top };
  })() : null;
  const pipeline = crm ? (await db.query(`SELECT status, count(*)::int AS n, COALESCE(sum(est_value),0)::float8 AS value FROM crm_lead GROUP BY status`)).rows : null;
  return { sales, pipeline };
}
void inr2;
