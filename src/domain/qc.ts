import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan, visibleSites } from '../core/permissions.js';
import { audit, emit } from '../core/audit.js';
import { badRequest, conflict, invalidState, notFound, staleVersion } from '../core/errors.js';
import { qAdd, qGt, qLt, qSub } from '../core/qty.js';
import { postMovement } from './inventory.js';
import { refreshPoStatus } from './po.js';

async function loadInspection(db: Db, id: string, expectedVersion?: number) {
  const q = (await db.query(
    `SELECT q.*, rl.qty AS lot_qty, rl.po_line_id, rl.item_id, rl.unit
       FROM qc_inspection q JOIN receipt_line rl ON rl.id = q.receipt_line_id WHERE q.id=$1 FOR UPDATE OF q`, [id])).rows[0];
  if (!q) throw notFound('Inspection');
  if (expectedVersion !== undefined && q.version !== expectedVersion) throw staleVersion(expectedVersion, q.version);
  return q;
}

export async function startInspection(ctx: Ctx, i: { inspectionId: string }) {
  const q = await loadInspection(ctx.db, i.inspectionId);
  await assertCan(ctx.db, ctx.actor.id, 'qc.inspect', { siteId: q.site_id });
  if (q.status !== 'pending') throw invalidState(`Inspection is ${q.status}`);
  const r = await ctx.db.query(`UPDATE qc_inspection SET status='inspecting', inspector_id=$2, version=version+1 WHERE id=$1 RETURNING id, status, version`, [q.id, ctx.actor.id]);
  await audit(ctx, { action: 'qc.start', entityType: 'qc_inspection', entityId: q.id });
  return r.rows[0];
}

/** Sample size is recorded separately from the lot disposition quantity (blueprint W02 controls). */
export async function submitInspection(ctx: Ctx, i: {
  inspectionId: string; expectedVersion: number; inspectedQty: string; recommendAccept: string; recommendReject: string; defects?: unknown[];
}) {
  const q = await loadInspection(ctx.db, i.inspectionId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'qc.submit', { siteId: q.site_id });
  if (q.status !== 'inspecting') throw invalidState(`Inspection is ${q.status}; start it first`);
  if (qLt(i.inspectedQty, '0') || qGt(i.inspectedQty, q.lot_qty)) throw badRequest('Inspected quantity must be between 0 and the lot quantity');
  if (qLt(i.recommendAccept, '0') || qLt(i.recommendReject, '0')) throw badRequest('Quantities cannot be negative');
  if (qGt(qAdd(i.recommendAccept, i.recommendReject), q.lot_qty)) throw badRequest('Accept + reject exceeds the received quantity');
  const r = await ctx.db.query(
    `UPDATE qc_inspection SET status='submitted', inspected_qty=$2, recommend_accept=$3, recommend_reject=$4, defects=$5, version=version+1
      WHERE id=$1 RETURNING id, status, version`,
    [q.id, i.inspectedQty, i.recommendAccept, i.recommendReject, JSON.stringify(i.defects ?? [])]);
  await audit(ctx, { action: 'qc.submit', entityType: 'qc_inspection', entityId: q.id, after: i });
  return r.rows[0];
}

/**
 * Quality authority decides. Releasing moves HOLD → ACCEPTED (now allocatable); rejecting moves HOLD → REJECTED.
 * Received = accepted + rejected + still-held, always, on the same unit basis.
 */
export async function dispositionInspection(ctx: Ctx, i: { inspectionId: string; expectedVersion: number; acceptQty: string; rejectQty: string; reason?: string }) {
  const q = await loadInspection(ctx.db, i.inspectionId, i.expectedVersion);
  if (qLt(i.acceptQty, '0') || qLt(i.rejectQty, '0')) throw badRequest('Quantities cannot be negative');
  const accept = qGt(i.acceptQty, '0'), reject = qGt(i.rejectQty, '0');
  if (accept) await assertCan(ctx.db, ctx.actor.id, 'qc.release', { siteId: q.site_id });
  if (reject) await assertCan(ctx.db, ctx.actor.id, 'qc.reject', { siteId: q.site_id });
  if (!accept && !reject) await assertCan(ctx.db, ctx.actor.id, 'qc.release', { siteId: q.site_id });
  if (!['submitted', 'held', 'partial'].includes(q.status)) throw invalidState(`Inspection is ${q.status}; it must be submitted before disposition`);

  const heldNow = qSub(q.lot_qty, qAdd(q.accepted_qty, q.rejected_qty));
  if (qGt(qAdd(i.acceptQty, i.rejectQty), heldNow))
    throw conflict('EXCEEDS_HELD', `Only ${heldNow} ${q.unit} is still on hold`, { held: heldNow });

  const bucket = (await ctx.db.query(
    `SELECT location_id, SUM(qty) AS qty FROM stock_ledger WHERE lot_id=$1 AND status='HOLD' GROUP BY location_id HAVING SUM(qty) > 0`, [q.lot_id])).rows;
  const need = qAdd(i.acceptQty, i.rejectQty);
  if (qGt(need, '0') && bucket.length !== 1) throw invalidState('Held stock is split across locations; consolidate it before disposition');

  const base = { siteId: q.site_id, lotId: q.lot_id, itemId: q.item_id, unit: q.unit, locationId: bucket[0]?.location_id as string };
  const legs = [];
  if (accept) legs.push({ ...base, status: 'HOLD' as const, qty: qSub('0', i.acceptQty) }, { ...base, status: 'ACCEPTED' as const, qty: i.acceptQty });
  if (reject) legs.push({ ...base, status: 'HOLD' as const, qty: qSub('0', i.rejectQty) }, { ...base, status: 'REJECTED' as const, qty: i.rejectQty });
  if (legs.length) await postMovement(ctx, { type: accept && reject ? 'QC_PARTIAL' : accept ? 'QC_RELEASE' : 'QC_REJECT', sourceType: 'qc_inspection', sourceId: q.id, legs });

  const acc = qAdd(q.accepted_qty, i.acceptQty), rej = qAdd(q.rejected_qty, i.rejectQty);
  const decided = qAdd(acc, rej);
  const status = !qGt(decided, '0') ? 'held' : qGt(q.lot_qty, decided) ? 'partial' : !qGt(rej, '0') ? 'accepted' : !qGt(acc, '0') ? 'rejected' : 'partial';
  const u = await ctx.db.query(
    `UPDATE qc_inspection SET status=$2, accepted_qty=$3, rejected_qty=$4, released_by=$5, version=version+1 WHERE id=$1 RETURNING *`,
    [q.id, status, acc, rej, ctx.actor.id]);
  if (q.po_line_id && (accept || reject))
    await ctx.db.query('UPDATE po_line SET accepted_qty = accepted_qty + $2, rejected_qty = rejected_qty + $3 WHERE id=$1', [q.po_line_id, i.acceptQty, i.rejectQty]);
  if (q.po_line_id) {
    const po = (await ctx.db.query('SELECT po_id FROM po_line WHERE id=$1', [q.po_line_id])).rows[0];
    await refreshPoStatus(ctx, po.po_id);
  }
  await audit(ctx, { action: 'qc.disposition', entityType: 'qc_inspection', entityId: q.id, before: { status: q.status }, after: { status, accepted: acc, rejected: rej }, reason: i.reason ?? null });
  await emit(ctx, { type: 'qc.dispositioned', entityType: 'qc_inspection', entityId: q.id, version: u.rows[0].version, siteId: q.site_id, payload: { lotId: q.lot_id, accepted: acc, rejected: rej, status } });
  return u.rows[0];
}

export async function listInspections(db: Db, userId: string, f: { status?: string } = {}) {
  const sites = await visibleSites(db, userId, 'qc.view');
  if (sites && !sites.length) return [];
  return (await db.query(
    `SELECT q.id, q.status, q.version, q.site_id, l.label, rl.qty, rl.unit, q.accepted_qty, q.rejected_qty, i.code AS item_code
       FROM qc_inspection q JOIN receipt_line rl ON rl.id = q.receipt_line_id JOIN lot l ON l.id = q.lot_id JOIN item i ON i.id = rl.item_id
      WHERE ($1::uuid[] IS NULL OR q.site_id = ANY($1::uuid[])) AND ($2::text IS NULL OR q.status = $2)
      ORDER BY q.created_at DESC LIMIT 200`, [sites, f.status ?? null])).rows;
}

