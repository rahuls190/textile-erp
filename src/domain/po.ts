import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan, assertIndependent, can, visibleSites } from '../core/permissions.js';
import { audit, emit } from '../core/audit.js';
import { badRequest, conflict, forbidden, invalidState, notFound, staleVersion } from '../core/errors.js';
import { nextNumber } from '../core/numbering.js';
import { lineAmount, qAdd, qGt, qLt, qSub } from '../core/qty.js';
import { currentRate } from './masters.js';

const RECEIVABLE = ['released', 'acknowledged', 'partial_receipt'];
const AMENDABLE = ['released', 'acknowledged', 'partial_receipt'];

export interface PoLineInput { itemId: string; qty: string; rate?: string; dueDate?: string | null }

async function loadPO(db: Db, id: string, expectedVersion?: number) {
  const po = (await db.query('SELECT * FROM purchase_order WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!po) throw notFound('Purchase order');
  if (expectedVersion !== undefined && po.version !== expectedVersion) throw staleVersion(expectedVersion, po.version);
  return po;
}

async function snapshot(ctx: Ctx, poId: string, reason?: string) {
  const po = (await ctx.db.query('SELECT * FROM purchase_order WHERE id=$1', [poId])).rows[0];
  const lines = (await ctx.db.query('SELECT * FROM po_line WHERE po_id=$1 ORDER BY line_no', [poId])).rows;
  await ctx.db.query(
    `INSERT INTO po_version(po_id, version, snapshot, actor_id, reason) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (po_id, version) DO UPDATE SET snapshot=EXCLUDED.snapshot`,
    [poId, po.version, JSON.stringify({ ...po, lines }), ctx.actor.id, reason ?? null]);
}

async function bump(ctx: Ctx, poId: string, set: string, params: unknown[] = []) {
  const r = await ctx.db.query(`UPDATE purchase_order SET ${set}, version = version + 1 WHERE id=$1 RETURNING *`, [poId, ...params]);
  return r.rows[0];
}

async function buildLines(ctx: Ctx, partnerId: string, lines: PoLineInput[]) {
  if (!lines.length) throw badRequest('A purchase order needs at least one item');
  if (lines.length > 50) throw badRequest('A purchase order can hold up to 50 items; split it into two orders');
  const out: { itemId: string; qty: string; unit: string; rate: string; dueDate: string | null; amount: string }[] = [];
  for (const [n, l] of lines.entries()) {
    if (!/^\d+(\.\d{1,4})?$/.test(String(l.qty ?? '').trim()) || !qGt(String(l.qty).trim(), '0')) throw badRequest(`Item ${n + 1}: quantity must be a positive number`);
    if (l.dueDate && !(/^\d{4}-\d{2}-\d{2}$/.test(l.dueDate) && !Number.isNaN(Date.parse(l.dueDate)))) throw badRequest(`Item ${n + 1}: due date is not a valid date`);
    const it = (await ctx.db.query('SELECT id, code, status, stock_unit FROM item WHERE id=$1', [l.itemId])).rows[0];
    if (!it) throw notFound('Item');
    if (it.status !== 'active') throw invalidState(`Item ${it.code} is ${it.status}; only released items can be purchased`);
    let rate: string | undefined = l.rate;
    if (rate === undefined) {
      const r = await currentRate(ctx.db, partnerId, l.itemId, l.qty);
      if (!r) throw invalidState(`No approved rate for ${it.code} with this vendor; propose and approve one, or enter a rate`);
      rate = r.rate;
    }
    const finalRate: string = rate as string;
    out.push({ itemId: l.itemId, qty: l.qty, unit: it.stock_unit, rate: finalRate, dueDate: l.dueDate ?? null, amount: lineAmount(l.qty, finalRate) });
  }
  return out;
}

const sum = (xs: string[]) => xs.reduce((a, b) => qAdd(a, b), '0.0000').slice(0, -2);

export async function createPO(ctx: Ctx, i: { siteId: string; partnerId: string; lines: PoLineInput[]; terms?: object }) {
  await assertCan(ctx.db, ctx.actor.id, 'po.create', { siteId: i.siteId });
  const partner = (await ctx.db.query('SELECT * FROM partner WHERE id=$1', [i.partnerId])).rows[0];
  if (!partner) throw notFound('Vendor');
  if (partner.status !== 'active' || !partner.is_vendor) throw invalidState(`Partner ${partner.code} is not an active vendor`);
  const lines = await buildLines(ctx, i.partnerId, i.lines);
  const number = await nextNumber(ctx, i.siteId, 'PO');
  const po = (await ctx.db.query(
    `INSERT INTO purchase_order(site_id, number, partner_id, total, terms, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [i.siteId, number, i.partnerId, sum(lines.map((l) => l.amount)), JSON.stringify(i.terms ?? {}), ctx.actor.id])).rows[0];
  for (const [n, l] of lines.entries())
    await ctx.db.query(`INSERT INTO po_line(po_id, line_no, item_id, qty, unit, rate, due_date) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [po.id, n + 1, l.itemId, l.qty, l.unit, l.rate, l.dueDate]);
  await snapshot(ctx, po.id, 'created');
  await audit(ctx, { action: 'po.create', entityType: 'purchase_order', entityId: po.id, after: { number, total: po.total } });
  return po;
}

/** Items this vendor has an approved price for today (the only ones that can be ordered without typing a rate). */
export async function pricedItems(db: Db, userId: string, partnerId: string): Promise<string[]> {
  await assertCan(db, userId, 'po.create', { anySite: true });
  return (await db.query(`SELECT DISTINCT item_id FROM rate WHERE partner_id=$1 AND status IN ('approved','superseded') AND effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)`, [partnerId])).rows.map((r) => r.item_id as string);
}

/** What each line would cost at today's approved rates, so the form can show prices before the order is saved. */
export async function quoteLines(db: Db, userId: string, i: { partnerId: string; lines: { itemId: string; qty: string }[] }) {
  await assertCan(db, userId, 'po.create', { anySite: true });
  const out: { rate: string | null; unit: string | null; amount: string | null }[] = [];
  for (const l of i.lines) {
    const it = (await db.query('SELECT stock_unit FROM item WHERE id=$1', [l.itemId])).rows[0];
    const ok = /^\d+(\.\d{1,4})?$/.test(String(l.qty ?? '').trim()) && qGt(String(l.qty).trim(), '0');
    const r = ok ? await currentRate(db, i.partnerId, l.itemId, String(l.qty).trim()) : null;
    out.push({ rate: r ? String(r.rate) : null, unit: it?.stock_unit ?? null, amount: r && ok ? lineAmount(String(l.qty).trim(), String(r.rate)) : null });
  }
  return out;
}

export async function updateDraftPO(ctx: Ctx, i: { poId: string; expectedVersion: number; lines: PoLineInput[]; terms?: object }) {
  const po = await loadPO(ctx.db, i.poId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'po.edit', { siteId: po.site_id });
  if (po.status !== 'draft') throw invalidState(`PO is ${po.status}; released values change only through an amendment`);
  if (po.created_by !== ctx.actor.id) throw forbidden('Only the creator can edit a draft');
  const lines = await buildLines(ctx, po.partner_id, i.lines);
  await ctx.db.query('DELETE FROM po_line WHERE po_id=$1', [po.id]);
  for (const [n, l] of lines.entries())
    await ctx.db.query(`INSERT INTO po_line(po_id, line_no, item_id, qty, unit, rate, due_date) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [po.id, n + 1, l.itemId, l.qty, l.unit, l.rate, l.dueDate]);
  const u = await bump(ctx, po.id, 'total=$2, terms=COALESCE($3::jsonb, terms)', [sum(lines.map((l) => l.amount)), i.terms ? JSON.stringify(i.terms) : null]);
  await snapshot(ctx, po.id, 'draft edited');
  await audit(ctx, { action: 'po.edit', entityType: 'purchase_order', entityId: po.id, before: { total: po.total }, after: { total: u.total } });
  return u;
}

export async function submitPO(ctx: Ctx, i: { poId: string; expectedVersion: number }) {
  const po = await loadPO(ctx.db, i.poId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'po.submit', { siteId: po.site_id });
  if (po.status !== 'draft') throw invalidState(`PO is ${po.status}`);
  const n = (await ctx.db.query('SELECT count(*)::int AS n FROM po_line WHERE po_id=$1', [po.id])).rows[0].n;
  if (!n) throw badRequest('PO has no lines');
  const u = await bump(ctx, po.id, `status='approval_pending'`);
  await snapshot(ctx, po.id, 'submitted');
  await audit(ctx, { action: 'po.submit', entityType: 'purchase_order', entityId: po.id, before: { status: po.status }, after: { status: u.status } });
  return u;
}

/**
 * Approves either a new PO (approval_pending) or a pending amendment on a released PO.
 * The approver must be independent of whoever created/amended it, and within their value band.
 * Approval does NOT release the order — releasing needs its own right.
 */
export async function approvePO(ctx: Ctx, i: { poId: string; expectedVersion: number }) {
  const po = await loadPO(ctx.db, i.poId, i.expectedVersion);
  const amendment = po.pending_amendment as null | { reason: string; lines: { lineId: string; qty: string; rate: string; dueDate: string | null }[]; newTotal: string };

  if (amendment) {
    if (!ctx.override) { await assertCan(ctx.db, ctx.actor.id, 'po.approve', { siteId: po.site_id, amount: amendment.newTotal });
    assertIndependent(ctx.actor.id, po.amended_by, 'amendment'); }
    for (const l of amendment.lines)
      await ctx.db.query('UPDATE po_line SET qty=$2, rate=$3, due_date=$4 WHERE id=$1', [l.lineId, l.qty, l.rate, l.dueDate]);
    const u = await bump(ctx, po.id, 'total=$2, revision=revision+1, pending_amendment=NULL, amended_by=NULL', [amendment.newTotal]);
    await snapshot(ctx, po.id, `amendment approved: ${amendment.reason}`);
    await audit(ctx, { action: 'po.amend.approve', entityType: 'purchase_order', entityId: po.id, before: { total: po.total }, after: { total: u.total, revision: u.revision }, reason: amendment.reason });
    await emit(ctx, { type: 'po.amended', entityType: 'purchase_order', entityId: po.id, version: u.version, siteId: po.site_id, payload: { number: po.number, revision: u.revision } });
    await refreshPoStatus(ctx, po.id);
    return (await ctx.db.query('SELECT * FROM purchase_order WHERE id=$1', [po.id])).rows[0];
  }

  if (po.status !== 'approval_pending') throw invalidState(`PO is ${po.status}; only submitted POs can be approved`);
  if (!ctx.override) { await assertCan(ctx.db, ctx.actor.id, 'po.approve', { siteId: po.site_id, amount: po.total });
  assertIndependent(ctx.actor.id, po.created_by, 'purchase order'); }
  const u = await bump(ctx, po.id, `status='approved', approved_by=$2`, [ctx.actor.id]);
  await snapshot(ctx, po.id, 'approved');
  await audit(ctx, { action: 'po.approve', entityType: 'purchase_order', entityId: po.id, before: { status: po.status }, after: { status: u.status } });
  return u;
}

/** Return a submitted PO to draft, or discard a pending amendment. Needs the approver's right, with a reason. */
export async function returnPO(ctx: Ctx, i: { poId: string; expectedVersion: number; reason: string }) {
  if (!i.reason) throw badRequest('A reason is required');
  const po = await loadPO(ctx.db, i.poId, i.expectedVersion);
  if (!ctx.override) await assertCan(ctx.db, ctx.actor.id, 'po.approve', { siteId: po.site_id, amount: po.pending_amendment?.newTotal ?? po.total });
  let u;
  if (po.pending_amendment) u = await bump(ctx, po.id, 'pending_amendment=NULL, amended_by=NULL');
  else if (po.status === 'approval_pending') u = await bump(ctx, po.id, `status='draft'`);
  else throw invalidState(`PO is ${po.status}; nothing to return`);
  await audit(ctx, { action: 'po.return', entityType: 'purchase_order', entityId: po.id, reason: i.reason });
  return u;
}

export async function releasePO(ctx: Ctx, i: { poId: string; expectedVersion: number }) {
  const po = await loadPO(ctx.db, i.poId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'po.release', { siteId: po.site_id, amount: po.total });
  if (po.status !== 'approved') throw invalidState(`PO is ${po.status}; it must be approved before release`);
  const u = await bump(ctx, po.id, `status='released', released_by=$2, released_at=now()`, [ctx.actor.id]);
  await snapshot(ctx, po.id, 'released');
  await audit(ctx, { action: 'po.release', entityType: 'purchase_order', entityId: po.id, before: { status: po.status }, after: { status: 'released' } });
  await emit(ctx, { type: 'po.released', entityType: 'purchase_order', entityId: po.id, version: u.version, siteId: po.site_id, payload: { number: po.number, partnerId: po.partner_id, total: po.total } });
  return u;
}

/** Post-release change: proposed now, applied only when an independent approver accepts it. Prior versions stay visible. */
export async function amendPO(ctx: Ctx, i: {
  poId: string; expectedVersion: number; reason: string; changes: { lineId: string; qty?: string; rate?: string; dueDate?: string | null }[];
}) {
  if (!i.reason) throw badRequest('An amendment reason is required');
  const po = await loadPO(ctx.db, i.poId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'po.amend', { siteId: po.site_id });
  if (!AMENDABLE.includes(po.status)) throw invalidState(`PO is ${po.status}; only released orders can be amended`);
  if (po.pending_amendment) throw conflict('AMENDMENT_PENDING', 'An amendment is already awaiting approval');
  const lines = (await ctx.db.query('SELECT * FROM po_line WHERE po_id=$1 ORDER BY line_no', [po.id])).rows;
  const proposed = lines.map((l) => ({ lineId: l.id, qty: l.qty as string, rate: l.rate as string, dueDate: (l.due_date as string | null) ?? null, fulfilled: qSub(l.received_qty, l.rejected_qty) }));
  for (const c of i.changes) {
    const p = proposed.find((x) => x.lineId === c.lineId);
    if (!p) throw notFound('PO line');
    if (c.qty !== undefined) {
      if (qLt(c.qty, p.fulfilled)) throw conflict('BELOW_RECEIVED', `Quantity cannot go below the ${p.fulfilled} already received and not rejected`);
      p.qty = c.qty;
    }
    if (c.rate !== undefined) p.rate = c.rate;
    if (c.dueDate !== undefined) p.dueDate = c.dueDate;
  }
  const newTotal = sum(proposed.map((p) => lineAmount(p.qty, p.rate)));
  const pending = { reason: i.reason, newTotal, lines: proposed.map(({ lineId, qty, rate, dueDate }) => ({ lineId, qty, rate, dueDate })) };
  const u = await bump(ctx, po.id, 'pending_amendment=$2::jsonb, amended_by=$3', [JSON.stringify(pending), ctx.actor.id]);
  await audit(ctx, { action: 'po.amend.propose', entityType: 'purchase_order', entityId: po.id, before: { total: po.total }, after: { newTotal }, reason: i.reason });
  return u;
}

/** Cancel an unreceived PO, or short-close the remaining quantity. Unresolved QC blocks closure. */
export async function cancelPO(ctx: Ctx, i: { poId: string; expectedVersion: number; reason: string }) {
  if (!i.reason) throw badRequest('A reason is required');
  const po = await loadPO(ctx.db, i.poId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'po.cancel', { siteId: po.site_id, amount: po.total });
  if (['closed', 'cancelled', 'completed'].includes(po.status)) throw invalidState(`PO is already ${po.status}`);
  const open = (await ctx.db.query(
    `SELECT count(*)::int AS n FROM qc_inspection q JOIN receipt_line rl ON rl.id=q.receipt_line_id JOIN po_line pl ON pl.id=rl.po_line_id
      WHERE pl.po_id=$1 AND q.status IN ('pending','inspecting','submitted','held','partial')`, [po.id])).rows[0].n;
  if (open) throw invalidState(`${open} inspection(s) on this PO are unresolved; finish QC before closing`);
  const received = (await ctx.db.query('SELECT COALESCE(SUM(received_qty),0) AS q FROM po_line WHERE po_id=$1', [po.id])).rows[0].q;
  const next = qGt(received, '0') ? 'closed' : 'cancelled';
  const u = await bump(ctx, po.id, `status=$2, pending_amendment=NULL, amended_by=NULL`, [next]);
  await snapshot(ctx, po.id, `${next}: ${i.reason}`);
  await audit(ctx, { action: `po.${next === 'closed' ? 'short_close' : 'cancel'}`, entityType: 'purchase_order', entityId: po.id, before: { status: po.status }, after: { status: next }, reason: i.reason });
  await emit(ctx, { type: next === 'closed' ? 'po.short_closed' : 'po.cancelled', entityType: 'purchase_order', entityId: po.id, version: u.version, siteId: po.site_id, payload: { number: po.number } });
  return u;
}

/**
 * Receipt/QC drive PO status; nobody types a received quantity.
 * Open balance counts accepted + still-pending stock; rejected stock reopens demand for replacement.
 */
export async function refreshPoStatus(ctx: Ctx, poId: string) {
  const po = (await ctx.db.query('SELECT status, version FROM purchase_order WHERE id=$1', [poId])).rows[0];
  if (!['released', 'acknowledged', 'partial_receipt', 'completed'].includes(po.status)) return;
  const agg = (await ctx.db.query(
    `SELECT COALESCE(SUM(received_qty),0) AS received,
            COALESCE(SUM(GREATEST(qty - (received_qty - rejected_qty), 0)),0) AS remaining
       FROM po_line WHERE po_id=$1`, [poId])).rows[0];
  let next = po.status;
  if (!qGt(agg.remaining, '0')) next = 'completed';
  else if (qGt(agg.received, '0')) next = 'partial_receipt';
  if (next !== po.status) {
    await ctx.db.query(`UPDATE purchase_order SET status=$2, version=version+1 WHERE id=$1`, [poId, next]);
    await snapshot(ctx, poId, `status → ${next}`);
    await audit(ctx, { action: 'po.status', entityType: 'purchase_order', entityId: poId, before: { status: po.status }, after: { status: next } });
  }
}

export const isReceivable = (status: string) => RECEIVABLE.includes(status);

// ───────────────────────── reads (row scope enforced in the query) ─────────────────────────

export async function getPO(db: Db, userId: string, poId: string) {
  const po = (await db.query('SELECT * FROM purchase_order WHERE id=$1', [poId])).rows[0];
  if (!po || !(await can(db, userId, 'po.view', { siteId: po.site_id }))) throw notFound('Purchase order');
  const lines = (await db.query('SELECT * FROM po_line WHERE po_id=$1 ORDER BY line_no', [poId])).rows;
  const versions = (await db.query('SELECT version, reason, at FROM po_version WHERE po_id=$1 ORDER BY version', [poId])).rows;
  return { ...po, lines, versions };
}

export async function listPOs(db: Db, userId: string, f: { status?: string } = {}) {
  const sites = await visibleSites(db, userId, 'po.view');
  if (sites && !sites.length) return [];
  const r = await db.query(
    `SELECT po.id, po.number, po.status, po.total, po.version, po.site_id, p.name AS vendor
       FROM purchase_order po JOIN partner p ON p.id = po.partner_id
      WHERE ($1::uuid[] IS NULL OR po.site_id = ANY($1::uuid[])) AND ($2::text IS NULL OR po.status = $2)
      ORDER BY po.created_at DESC LIMIT 200`, [sites, f.status ?? null]);
  return r.rows;
}
