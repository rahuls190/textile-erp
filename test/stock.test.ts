import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { freshWorld, rejects } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as po from '../src/domain/po.js';
import * as rcv from '../src/domain/receipt.js';
import * as qc from '../src/domain/qc.js';
import * as inv from '../src/domain/inventory.js';
import * as q from '../src/domain/queries.js';
import * as admin from '../src/domain/admin.js';
import { runCommand } from '../src/core/command.js';

let w: World;
beforeAll(async () => { w = await freshWorld('stock'); });
afterAll(async () => { await w.pool.end(); });

let seq = 0;
async function releasedPO(qty: string) {
  const p = await w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty }] }));
  const s = await w.as('buy', (c) => po.submitPO(c, { poId: p.id, expectedVersion: p.version }));
  const a = await w.as('com', (c) => po.approvePO(c, { poId: p.id, expectedVersion: s.version }));
  const r = await w.as('com', (c) => po.releasePO(c, { poId: p.id, expectedVersion: a.version }));
  const line = (await w.pool.query('SELECT id FROM po_line WHERE po_id=$1', [p.id])).rows[0];
  return { ...r, lineId: line.id as string };
}
async function receive(p: { id: string; lineId: string }, qty: string) {
  return w.as('sto', (c) => rcv.postReceipt(c, { siteId: w.siteId, partnerId: w.vendorId, poId: p.id, challanNo: `CH-${++seq}`,
    lines: [{ poLineId: p.lineId, itemId: w.items.fabric, qty }] }));
}
const poStatus = async (id: string) => (await w.pool.query('SELECT status FROM purchase_order WHERE id=$1', [id])).rows[0].status as string;
async function summary(lotId: string, who = 'sto') {
  const c = await w.pool.connect();
  try { return (await q.stockSummary(c, w.actors[who].id)).find((x) => x.lot_id === lotId)!; } finally { c.release(); }
}
const inspect = async (insp: string, accept: string, reject: string) => {
  await w.as('qci', (c) => qc.startInspection(c, { inspectionId: insp }));
  const v = (await w.pool.query('SELECT version FROM qc_inspection WHERE id=$1', [insp])).rows[0].version;
  await w.as('qci', (c) => qc.submitInspection(c, { inspectionId: insp, expectedVersion: v, inspectedQty: '10', recommendAccept: accept, recommendReject: reject }));
};
const disposition = async (who: string, insp: string, acceptQty: string, rejectQty: string) => {
  const v = (await w.pool.query('SELECT version FROM qc_inspection WHERE id=$1', [insp])).rows[0].version;
  return w.as(who, (c) => qc.dispositionInspection(c, { inspectionId: insp, expectedVersion: v, acceptQty, rejectQty }));
};

describe('Worked example (blueprint p.55): receipt → QC → reservation', () => {
  let p: Awaited<ReturnType<typeof releasedPO>>; let rec: Awaited<ReturnType<typeof receive>>;

  it('PO 500 m; receiving roll R100 = 500 m lands in QC HOLD — nothing is usable yet', async () => {
    p = await releasedPO('500'); rec = await receive(p, '500');
    const s = await summary(rec.lines[0].lotId);
    expect(s).toMatchObject({ held: '500.0000', accepted: '0.0000', eligible: '0.0000', available: '0.0000', rejected: '0.0000' });
    expect(await poStatus(p.id)).toBe('completed'); // fully received; QC outcome may reopen it
  });

  it('arrival alone creates no usable inventory: reserving held stock is refused', async () => {
    await rejects(w.as('sto', (c) => inv.reserveStock(c, { lotId: rec.lines[0].lotId, qty: '1', demandType: 'cut_order', demandRef: 'CUT-1' })), 'INSUFFICIENT_AVAILABLE', 409);
  });

  it('QC accepts 480 m and rejects 20 m; receipt still totals 500 m; the PO reopens for 20 m replacement', async () => {
    await inspect(rec.lines[0].inspectionId, '480', '20');
    await disposition('qcm', rec.lines[0].inspectionId, '480', '20');
    const s = await summary(rec.lines[0].lotId);
    expect(s).toMatchObject({ held: '0.0000', accepted: '480.0000', eligible: '480.0000', rejected: '20.0000' });
    expect(await poStatus(p.id)).toBe('partial_receipt');
    const l = (await w.pool.query('SELECT received_qty, accepted_qty, rejected_qty FROM po_line WHERE id=$1', [p.lineId])).rows[0];
    expect(l).toEqual({ received_qty: '500.0000', accepted_qty: '480.0000', rejected_qty: '20.0000' });
  });

  it('reserve 120 m → unreserved eligible stock = 360 m; reserving 400 m is refused', async () => {
    await w.as('sto', (c) => inv.reserveStock(c, { lotId: rec.lines[0].lotId, qty: '120', demandType: 'cut_order', demandRef: 'CUT-200' }));
    const s = await summary(rec.lines[0].lotId);
    expect(s.reserved).toBe('120.0000'); expect(s.available).toBe('360.0000');
    const err = await rejects(w.as('sto', (c) => inv.reserveStock(c, { lotId: rec.lines[0].lotId, qty: '400', demandType: 'cut_order', demandRef: 'CUT-201' })), 'INSUFFICIENT_AVAILABLE', 409);
    expect((err as { details?: { available: string } }).details?.available).toBe('360.0000');
  });

  it('physical stock = 500 m (480 accepted + 20 rejected); the ledger is the single source of truth', async () => {
    const r = (await w.pool.query(`SELECT SUM(qty) AS q FROM stock_ledger WHERE lot_id=$1`, [rec.lines[0].lotId])).rows[0].q;
    expect(r).toBe('500.0000');
  });

  it('the same receipt command replayed twice (outage retry) still produces one 500 m receipt', async () => {
    const p2 = await releasedPO('100'); const key = randomUUID();
    const run = () => runCommand(w.pool, { requestId: key, actor: w.actors.sto, action: 'receipt.post' }, (c) => rcv.postReceipt(c, {
      siteId: w.siteId, partnerId: w.vendorId, poId: p2.id, challanNo: 'CH-REPLAY', lines: [{ poLineId: p2.lineId, itemId: w.items.fabric, qty: '100' }] }));
    const a = await run(), b = await run();
    expect(b.replayed).toBe(true);
    const total = (await w.pool.query(`SELECT SUM(qty) AS q FROM stock_ledger WHERE lot_id=$1`, [a.result.lines[0].lotId])).rows[0].q;
    expect(total).toBe('100.0000');
  });
});

describe('Quality separation (acceptance test)', () => {
  it('STO receives 100; an inspector recommends; only quality authority can make it allocatable', async () => {
    const p = await releasedPO('100'); const rec = await receive(p, '100'); const insp = rec.lines[0].inspectionId;
    await rejects(w.as('sto', (c) => qc.startInspection(c, { inspectionId: insp })), 'FORBIDDEN', 403);
    await inspect(insp, '100', '0');
    await rejects(disposition('qci', insp, '100', '0'), 'FORBIDDEN', 403);   // inspector recommends, cannot release
    await rejects(disposition('sto', insp, '100', '0'), 'FORBIDDEN', 403);   // storekeeper cannot release a hold
    expect((await summary(rec.lines[0].lotId)).available).toBe('0.0000');
    await disposition('qcm', insp, '100', '0');
    expect((await summary(rec.lines[0].lotId)).available).toBe('100.0000');
  });

  it('partial release leaves the remainder on hold; releasing more than is held is refused', async () => {
    const p = await releasedPO('100'); const rec = await receive(p, '100'); const insp = rec.lines[0].inspectionId;
    await inspect(insp, '60', '0');
    await disposition('qcm', insp, '60', '0');
    const s = await summary(rec.lines[0].lotId);
    expect(s.held).toBe('40.0000'); expect(s.available).toBe('60.0000');
    await rejects(disposition('qcm', insp, '50', '0'), 'EXCEEDS_HELD', 409);
    await disposition('qcm', insp, '0', '40');   // reject the rest
    expect((await summary(rec.lines[0].lotId))).toMatchObject({ held: '0.0000', rejected: '40.0000', available: '60.0000' });
  });

  it('rejecting a receipt reopens a completed PO for replacement', async () => {
    const p = await releasedPO('50'); const rec = await receive(p, '50');
    expect(await poStatus(p.id)).toBe('completed');
    await inspect(rec.lines[0].inspectionId, '0', '50');
    await disposition('qcm', rec.lines[0].inspectionId, '0', '50');
    expect(await poStatus(p.id)).toBe('partial_receipt');
    await receive(p, '50');   // replacement accepted against the same PO
  });

  it('inspection must be started and submitted before disposition', async () => {
    const p = await releasedPO('10'); const rec = await receive(p, '10');
    await rejects(disposition('qcm', rec.lines[0].inspectionId, '10', '0'), 'INVALID_STATE');
  });
});

describe('Concurrent allocation (acceptance test)', () => {
  it('two users request the same remaining roll quantity at once: only one is committed', async () => {
    const p = await releasedPO('360'); const rec = await receive(p, '360');
    await inspect(rec.lines[0].inspectionId, '360', '0'); await disposition('qcm', rec.lines[0].inspectionId, '360', '0');
    const lotId = rec.lines[0].lotId;
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      w.as(i % 2 ? 'sto' : 'inv', (c) => inv.reserveStock(c, { lotId, qty: '100', demandType: 'cut_order', demandRef: `RACE-${i}` }))));
    const ok = attempts.filter((a) => a.status === 'fulfilled').length;
    const lost = attempts.filter((a) => a.status === 'rejected' && (a.reason as { code: string }).code === 'INSUFFICIENT_AVAILABLE').length;
    expect(ok).toBe(3); expect(lost).toBe(3);          // 3 × 100 fits in 360; the rest get an explicit rejection
    const s = await summary(lotId);
    expect(s.reserved).toBe('300.0000'); expect(s.available).toBe('60.0000');
  });

  it('concurrent putaways cannot overdraw a bucket', async () => {
    const p = await releasedPO('100'); const rec = await receive(p, '100');
    await inspect(rec.lines[0].inspectionId, '100', '0'); await disposition('qcm', rec.lines[0].inspectionId, '100', '0');
    const lotId = rec.lines[0].lotId;
    const res = await Promise.allSettled([0, 1, 2].map(() =>
      w.as('sto', (c) => inv.putaway(c, { lotId, fromLocationId: w.loc.rcv, toLocationId: w.loc.rack, qty: '60' }))));
    expect(res.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const bal = (await w.pool.query(`SELECT location_id, SUM(qty) q FROM stock_ledger WHERE lot_id=$1 AND status='ACCEPTED' GROUP BY location_id`, [lotId])).rows;
    for (const b of bal) expect(Number(b.q)).toBeGreaterThanOrEqual(0);
  });
});

describe('Receipt controls (W01)', () => {
  it('blocks excess receipt, repeated challans, wrong vendor, wrong unit and unapproved POs', async () => {
    const p = await releasedPO('100');
    await rejects(receive(p, '100.0001'), 'EXCESS_RECEIPT', 409);
    await receive(p, '40');
    await rejects(w.as('sto', (c) => rcv.postReceipt(c, { siteId: w.siteId, partnerId: w.vendorId, poId: p.id, challanNo: 'CH-' + seq,
      lines: [{ poLineId: p.lineId, itemId: w.items.fabric, qty: '10' }] })), 'DUPLICATE_CHALLAN', 409);
    await rejects(w.as('sto', (c) => rcv.postReceipt(c, { siteId: w.siteId, partnerId: w.vendorId, poId: p.id, challanNo: 'CH-U',
      lines: [{ poLineId: p.lineId, itemId: w.items.fabric, qty: '10', unit: 'KG' }] })), 'BAD_REQUEST');
    const draftPO = await w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '5' }] }));
    const dl = (await w.pool.query('SELECT id FROM po_line WHERE po_id=$1', [draftPO.id])).rows[0];
    await rejects(w.as('sto', (c) => rcv.postReceipt(c, { siteId: w.siteId, partnerId: w.vendorId, poId: draftPO.id, challanNo: 'CH-D',
      lines: [{ poLineId: dl.id, itemId: w.items.fabric, qty: '5' }] })), 'INVALID_STATE');
  });

  it('a repeat challan can be received only when an inventory controller acknowledges it', async () => {
    const p = await releasedPO('100'); await receive(p, '10');
    const dupArgs = { siteId: w.siteId, partnerId: w.vendorId, poId: p.id, challanNo: 'CH-' + seq, acknowledgeDuplicate: true,
      lines: [{ poLineId: p.lineId, itemId: w.items.fabric, qty: '10' }] };
    await rejects(w.as('sto', (c) => rcv.postReceipt(c, dupArgs)), 'DUPLICATE_CHALLAN');   // storekeeper cannot self-acknowledge
    await w.addUser('inv-recv', 'INV', { maxAmount: '1' });
    await w.as('admin', (c) => admin.assignRole(c, { userId: w.actors['inv-recv'].id, roleKey: 'STO', siteId: w.siteId }));
    await w.as('inv-recv', (c) => rcv.postReceipt(c, dupArgs));
  });

  it('a user at another site cannot receive here or see this stock', async () => {
    const wh2 = await w.as('md', (c) => admin.createSite(c, { entityId: w.entityId, code: 'WH9', name: 'Other warehouse' }));
    const u = await w.addUser('sto-wh9', 'STO', { siteId: wh2.id });
    const p = await releasedPO('10');
    await rejects(w.as('sto-wh9', (c) => rcv.postReceipt(c, { siteId: w.siteId, partnerId: w.vendorId, poId: p.id, challanNo: 'CH-X',
      lines: [{ poLineId: p.lineId, itemId: w.items.fabric, qty: '10' }] })), 'FORBIDDEN', 403);
    const c = await w.pool.connect();
    try { expect(await q.stockSummary(c, u.id)).toEqual([]); } finally { c.release(); }
  });
});

describe('Putaway, reservations and adjustments (W03/W04/W06)', () => {
  let lotId: string;
  beforeAll(async () => {
    const p = await releasedPO('200'); const rec = await receive(p, '200'); lotId = rec.lines[0].lotId;
    await inspect(rec.lines[0].inspectionId, '200', '0'); await disposition('qcm', rec.lines[0].inspectionId, '200', '0');
  });

  it('held stock may not be placed in an allocation pool; accepted stock moves rack to rack without changing the total', async () => {
    const p = await releasedPO('10'); const rec = await receive(p, '10');
    await rejects(w.as('sto', (c) => inv.putaway(c, { lotId: rec.lines[0].lotId, fromLocationId: w.loc.rcv, toLocationId: w.loc.store, qty: '10', status: 'HOLD' })), 'LOCATION_NOT_ALLOWED', 409);
    await w.as('sto', (c) => inv.putaway(c, { lotId, fromLocationId: w.loc.rcv, toLocationId: w.loc.rack, qty: '120' }));
    expect((await summary(lotId)).accepted).toBe('200.0000');
    await rejects(w.as('sto', (c) => inv.putaway(c, { lotId, fromLocationId: w.loc.rcv, toLocationId: w.loc.rack, qty: '81' })), 'INSUFFICIENT_STOCK', 409);
    await rejects(w.as('sto', (c) => inv.putaway(c, { lotId, fromLocationId: w.loc.rack, toLocationId: w.loc.transit, qty: '10' })), 'LOCATION_NOT_ALLOWED', 409);
  });

  it('stock cannot be adjusted away from under an active reservation', async () => {
    const res = await w.as('sto', (c) => inv.reserveStock(c, { lotId, qty: '150', demandType: 'cut_order', demandRef: 'CUT-ADJ' }));
    const adj = await w.as('sto', async () => null).then(() => w.addUser('inv-p', 'INV', { maxAmount: '1000' }))
      .then(() => w.as('inv-p', (c) => inv.proposeAdjustment(c, { lotId, locationId: w.loc.rack, qtyDelta: '-60', reason: 'damaged roll end' })));
    const approved = await w.as('inv', (c) => inv.approveAdjustment(c, { adjustmentId: adj.id, expectedVersion: adj.version, approve: true }));
    await rejects(w.as('inv-p', (c) => inv.postAdjustment(c, { adjustmentId: adj.id, expectedVersion: approved.version })), 'RESERVED_STOCK', 409);
    await w.as('sto', (c) => inv.releaseReservation(c, { reservationId: res.id, reason: 'demand cancelled' }));
    const posted = await w.as('inv-p', (c) => inv.postAdjustment(c, { adjustmentId: adj.id, expectedVersion: approved.version }));
    expect(posted.status).toBe('posted');
    expect((await summary(lotId)).accepted).toBe('140.0000');
  });

  it('an adjustment needs an independent approver within their quantity band; nobody can type over a balance', async () => {
    const adj = await w.as('inv', (c) => inv.proposeAdjustment(c, { lotId, locationId: w.loc.rack, qtyDelta: '-5', reason: 'count variance' }));
    await rejects(w.as('inv', (c) => inv.approveAdjustment(c, { adjustmentId: adj.id, expectedVersion: adj.version, approve: true })), 'FORBIDDEN', 403); // own proposal
    await rejects(w.as('inv', (c) => inv.postAdjustment(c, { adjustmentId: adj.id, expectedVersion: adj.version })), 'INVALID_STATE');          // not approved yet
    const big = await w.as('inv-p', (c) => inv.proposeAdjustment(c, { lotId, locationId: w.loc.rack, qtyDelta: '-5000', reason: 'huge' }));
    await rejects(w.as('inv', (c) => inv.approveAdjustment(c, { adjustmentId: big.id, expectedVersion: big.version, approve: true })), 'FORBIDDEN', 403); // above band
    // there is no API to set a balance: the only path is a ledger movement
    await rejects(w.pool.query(`UPDATE stock_ledger SET qty = 999 WHERE lot_id=$1`, [lotId]).catch((e) => { throw Object.assign(new Error(e.message), { code: 'IMMUTABLE' }); }), 'IMMUTABLE');
  });

  it('ledger integrity: no negative bucket anywhere, and every movement has an actor and a source', async () => {
    const neg = (await w.pool.query(`SELECT count(*)::int n FROM (SELECT lot_id, location_id, status, SUM(qty) q FROM stock_ledger GROUP BY 1,2,3 HAVING SUM(qty) < 0) x`)).rows[0].n;
    expect(neg).toBe(0);
    const orphan = (await w.pool.query(`SELECT count(*)::int n FROM stock_ledger WHERE actor_id IS NULL OR source_id IS NULL`)).rows[0].n;
    expect(orphan).toBe(0);
  });

  it('every stock movement and its audit entry carry the same request identity (full trace)', async () => {
    const t = (await w.pool.query(`SELECT count(*)::int n FROM stock_ledger sl JOIN audit_log a ON a.request_id = sl.request_id`)).rows[0].n;
    expect(t).toBeGreaterThan(0);
    const events = (await w.pool.query(`SELECT count(*)::int n FROM outbox_event WHERE event_type IN ('receipt.posted','qc.dispositioned','reservation.created')`)).rows[0].n;
    expect(events).toBeGreaterThan(0);
  });
});
