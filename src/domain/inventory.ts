import { randomUUID } from 'node:crypto';
import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan, assertIndependent } from '../core/permissions.js';
import { audit, emit } from '../core/audit.js';
import { badRequest, conflict, invalidState, notFound, staleVersion } from '../core/errors.js';
import { nextNumber } from '../core/numbering.js';
import { norm, qAdd, qGt, qLt, qSub, toScaled } from '../core/qty.js';

export type StockStatus = 'HOLD' | 'ACCEPTED' | 'REJECTED';
export interface Leg { siteId: string; lotId: string; itemId: string; locationId: string; status: StockStatus; qty: string; unit: string }

// Locations whose ACCEPTED stock can be promised to demand. In-transit, vendor-held and scrap are not eligible.
const ELIGIBLE = `('RECEIVING','STORE','RACK','FLOOR')`;

/**
 * Post one movement (one or more ledger legs) atomically.
 * Lots are locked in a stable order first, so concurrent commands on the same roll are serialised
 * and cannot overdraw a bucket or over-commit stock (blueprint W03/W04).
 */
export async function postMovement(ctx: Ctx, m: {
  type: string; sourceType: string; sourceId: string; legs: Leg[]; reversesId?: string | null; consumesReservation?: boolean;
}): Promise<string> {
  const movementId = randomUUID();
  const lotIds = [...new Set(m.legs.map((l) => l.lotId))].sort();
  await ctx.db.query('SELECT id FROM lot WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [lotIds]);

  for (const l of m.legs) {
    await ctx.db.query(
      `INSERT INTO stock_ledger(movement_id, site_id, lot_id, item_id, location_id, status, qty, unit, movement_type,
                                source_type, source_id, reverses_id, actor_id, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [movementId, l.siteId, l.lotId, l.itemId, l.locationId, l.status, l.qty, l.unit, m.type, m.sourceType, m.sourceId,
       m.reversesId ?? null, ctx.actor.id, ctx.requestId]);
  }
  // No bucket (lot × location × status) may go negative
  for (const l of m.legs.filter((x) => qLt(x.qty, '0'))) {
    const b = (await ctx.db.query(
      `SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger WHERE lot_id=$1 AND location_id=$2 AND status=$3`,
      [l.lotId, l.locationId, l.status])).rows[0].q;
    if (qLt(b, '0')) throw conflict('INSUFFICIENT_STOCK', `Only ${qAdd(b, qSub('0', l.qty))} ${l.unit} ${l.status} is available at that location`, { available: qAdd(b, qSub('0', l.qty)), requested: qSub('0', l.qty) });
  }
  // Removing ACCEPTED stock must not leave active reservations uncovered
  if (!m.consumesReservation) {
    for (const lotId of new Set(m.legs.filter((l) => l.status === 'ACCEPTED' && qLt(l.qty, '0')).map((l) => l.lotId))) {
      const a = await availability(ctx.db, lotId);
      if (qLt(a.available, '0')) throw conflict('RESERVED_STOCK', `That would leave ${qSub('0', a.available)} reserved quantity uncovered; release the reservation first`, a);
    }
  }
  return movementId;
}

export interface Availability { physicalAccepted: string; eligible: string; held: string; rejected: string; reserved: string; available: string }

/** available = eligible accepted stock − active reservations; QC hold, rejected and in-transit are excluded. */
export async function availability(db: Db, lotId: string): Promise<Availability> {
  const s = (await db.query(
    `SELECT
       COALESCE(SUM(l.qty) FILTER (WHERE l.status='ACCEPTED'),0) AS accepted,
       COALESCE(SUM(l.qty) FILTER (WHERE l.status='ACCEPTED' AND loc.kind IN ${ELIGIBLE}),0) AS eligible,
       COALESCE(SUM(l.qty) FILTER (WHERE l.status='HOLD'),0) AS held,
       COALESCE(SUM(l.qty) FILTER (WHERE l.status='REJECTED'),0) AS rejected
     FROM stock_ledger l JOIN location loc ON loc.id = l.location_id WHERE l.lot_id=$1`, [lotId])).rows[0];
  const reserved = (await db.query(`SELECT COALESCE(SUM(qty),0) AS q FROM reservation WHERE lot_id=$1 AND status='active'`, [lotId])).rows[0].q;
  return { physicalAccepted: norm(s.accepted), eligible: norm(s.eligible), held: norm(s.held), rejected: norm(s.rejected), reserved: norm(reserved), available: qSub(s.eligible, reserved) };
}

// ───────────────────────── W04 Reservations ─────────────────────────

export async function reserveStock(ctx: Ctx, i: { lotId: string; qty: string; demandType: string; demandRef: string }) {
  if (!qGt(i.qty, '0')) throw badRequest('Quantity must be positive');
  const lot = (await ctx.db.query('SELECT id, site_id FROM lot WHERE id=$1 FOR UPDATE', [i.lotId])).rows[0];
  if (!lot) throw notFound('Lot');
  await assertCan(ctx.db, ctx.actor.id, 'reservation.allocate', { siteId: lot.site_id });
  // Lot is locked: concurrent requests are serialised, so only valid availability is ever committed.
  const a = await availability(ctx.db, i.lotId);
  if (qGt(i.qty, a.available))
    throw conflict('INSUFFICIENT_AVAILABLE', `Requested ${i.qty}, only ${a.available} available`, { requested: i.qty, available: a.available });
  const r = await ctx.db.query(
    `INSERT INTO reservation(site_id, lot_id, qty, demand_type, demand_ref, requested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [lot.site_id, i.lotId, i.qty, i.demandType, i.demandRef, ctx.actor.id]);
  await audit(ctx, { action: 'reservation.create', entityType: 'reservation', entityId: r.rows[0].id, after: r.rows[0] });
  await emit(ctx, { type: 'reservation.created', entityType: 'reservation', entityId: r.rows[0].id, siteId: lot.site_id, payload: r.rows[0] });
  return r.rows[0];
}

export async function releaseReservation(ctx: Ctx, i: { reservationId: string; reason: string }) {
  if (!i.reason) throw badRequest('A reason is required');
  const r = (await ctx.db.query('SELECT * FROM reservation WHERE id=$1 FOR UPDATE', [i.reservationId])).rows[0];
  if (!r) throw notFound('Reservation');
  await assertCan(ctx.db, ctx.actor.id, 'reservation.allocate', { siteId: r.site_id });
  if (r.status !== 'active') throw invalidState(`Reservation is ${r.status}`);
  const u = await ctx.db.query(`UPDATE reservation SET status='released', released_at=now(), reason=$2 WHERE id=$1 RETURNING *`, [i.reservationId, i.reason]);
  await audit(ctx, { action: 'reservation.release', entityType: 'reservation', entityId: i.reservationId, reason: i.reason });
  return u.rows[0];
}

// ───────────────────────── W03 Putaway / location move ─────────────────────────

const PUTAWAY_KINDS: Record<StockStatus, string[]> = {
  HOLD: ['RECEIVING'],                           // held material never enters an allocation pool
  ACCEPTED: ['RECEIVING', 'STORE', 'RACK'],
  REJECTED: ['RECEIVING'],
};

export async function putaway(ctx: Ctx, i: { lotId: string; fromLocationId: string; toLocationId: string; qty: string; status?: StockStatus }) {
  const status = i.status ?? 'ACCEPTED';
  if (!qGt(i.qty, '0')) throw badRequest('Quantity must be positive');
  const lot = (await ctx.db.query('SELECT * FROM lot WHERE id=$1', [i.lotId])).rows[0];
  if (!lot) throw notFound('Lot');
  await assertCan(ctx.db, ctx.actor.id, 'putaway.execute', { siteId: lot.site_id });
  const locs = (await ctx.db.query('SELECT * FROM location WHERE id = ANY($1::uuid[])', [[i.fromLocationId, i.toLocationId]])).rows;
  const from = locs.find((l) => l.id === i.fromLocationId), to = locs.find((l) => l.id === i.toLocationId);
  if (!from || !to) throw notFound('Location');
  if (from.site_id !== lot.site_id || to.site_id !== lot.site_id) throw badRequest('Putaway stays within the lot\'s site; use an inter-site transfer');
  if (from.id === to.id) throw badRequest('Source and destination are the same');
  if (!PUTAWAY_KINDS[status].includes(to.kind)) throw conflict('LOCATION_NOT_ALLOWED', `${status} stock cannot be placed in a ${to.kind} location`);
  const item = (await ctx.db.query('SELECT stock_unit FROM item WHERE id=$1', [lot.item_id])).rows[0];
  const base = { siteId: lot.site_id, lotId: lot.id, itemId: lot.item_id, status, unit: item.stock_unit };
  const sourceId = randomUUID();
  const movementId = await postMovement(ctx, {
    type: 'PUTAWAY', sourceType: 'putaway', sourceId,
    legs: [{ ...base, locationId: from.id, qty: qSub('0', i.qty) }, { ...base, locationId: to.id, qty: i.qty }],
  });
  await audit(ctx, { action: 'inventory.putaway', entityType: 'lot', entityId: lot.id, after: { from: from.code, to: to.code, qty: i.qty, status } });
  await emit(ctx, { type: 'stock.moved', entityType: 'lot', entityId: lot.id, siteId: lot.site_id, payload: { movementId, from: from.code, to: to.code, qty: i.qty, status } });
  return { movementId };
}

// ───────────────────────── W06 Adjustments (never type over a balance) ─────────────────────────

export async function proposeAdjustment(ctx: Ctx, i: { lotId: string; locationId: string; qtyDelta: string; reason: string; evidence?: string }) {
  if (!i.reason) throw badRequest('A reason is required');
  if (toScaled(i.qtyDelta) === 0n) throw badRequest('Adjustment cannot be zero');
  const lot = (await ctx.db.query('SELECT * FROM lot WHERE id=$1', [i.lotId])).rows[0];
  if (!lot) throw notFound('Lot');
  await assertCan(ctx.db, ctx.actor.id, 'adjustment.propose', { siteId: lot.site_id });
  const loc = (await ctx.db.query('SELECT site_id FROM location WHERE id=$1', [i.locationId])).rows[0];
  if (!loc || loc.site_id !== lot.site_id) throw badRequest('Location is not at the lot\'s site');
  const number = await nextNumber(ctx, lot.site_id, 'ADJ');
  const r = await ctx.db.query(
    `INSERT INTO stock_adjustment(site_id, number, lot_id, location_id, qty_delta, reason, evidence, proposed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [lot.site_id, number, i.lotId, i.locationId, i.qtyDelta, i.reason, i.evidence ?? null, ctx.actor.id]);
  await audit(ctx, { action: 'adjustment.propose', entityType: 'stock_adjustment', entityId: r.rows[0].id, after: r.rows[0], reason: i.reason });
  return r.rows[0];
}

async function loadAdjustment(db: Db, id: string, expectedVersion: number) {
  const a = (await db.query('SELECT * FROM stock_adjustment WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!a) throw notFound('Adjustment');
  if (a.version !== expectedVersion) throw staleVersion(expectedVersion, a.version);
  return a;
}

/** Approval band is applied to |quantity| until valuation (A03) supplies a value basis. */
export async function approveAdjustment(ctx: Ctx, i: { adjustmentId: string; expectedVersion: number; approve: boolean }) {
  const a = await loadAdjustment(ctx.db, i.adjustmentId, i.expectedVersion);
  const size = toScaled(a.qty_delta) < 0n ? qSub('0', a.qty_delta) : a.qty_delta;
  if (!ctx.override) await assertCan(ctx.db, ctx.actor.id, 'adjustment.approve', { siteId: a.site_id, amount: size });
  if (a.status !== 'proposed') throw invalidState(`Adjustment is ${a.status}`);
  if (!ctx.override) assertIndependent(ctx.actor.id, a.proposed_by, 'stock adjustment');
  const r = await ctx.db.query(
    `UPDATE stock_adjustment SET status=$2, approved_by=$3, version=version+1 WHERE id=$1 RETURNING *`,
    [a.id, i.approve ? 'approved' : 'rejected', ctx.actor.id]);
  await audit(ctx, { action: i.approve ? 'adjustment.approve' : 'adjustment.reject', entityType: 'stock_adjustment', entityId: a.id });
  return r.rows[0];
}

export async function postAdjustment(ctx: Ctx, i: { adjustmentId: string; expectedVersion: number }) {
  const a = await loadAdjustment(ctx.db, i.adjustmentId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'adjustment.post', { siteId: a.site_id });
  if (a.status !== 'approved') throw invalidState(`Adjustment is ${a.status}; it must be approved first`);
  const lot = (await ctx.db.query('SELECT * FROM lot WHERE id=$1', [a.lot_id])).rows[0];
  const item = (await ctx.db.query('SELECT stock_unit FROM item WHERE id=$1', [lot.item_id])).rows[0];
  const movementId = await postMovement(ctx, {
    type: 'ADJUSTMENT', sourceType: 'stock_adjustment', sourceId: a.id,
    legs: [{ siteId: a.site_id, lotId: a.lot_id, itemId: lot.item_id, locationId: a.location_id, status: 'ACCEPTED', qty: a.qty_delta, unit: item.stock_unit }],
  });
  const r = await ctx.db.query(`UPDATE stock_adjustment SET status='posted', version=version+1 WHERE id=$1 RETURNING *`, [a.id]);
  await audit(ctx, { action: 'adjustment.post', entityType: 'stock_adjustment', entityId: a.id, after: { movementId, qtyDelta: a.qty_delta } });
  await emit(ctx, { type: 'stock.adjusted', entityType: 'stock_adjustment', entityId: a.id, siteId: a.site_id, payload: { movementId, lotId: a.lot_id, qtyDelta: a.qty_delta } });
  return r.rows[0];
}

