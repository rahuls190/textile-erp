import type { World } from './demo.js';
import * as po from '../domain/po.js';
import * as rcv from '../domain/receipt.js';
import * as qc from '../domain/qc.js';
import * as inv from '../domain/inventory.js';
import * as hr from '../domain/hr.js';
import * as owner from '../domain/owner.js';

/** The owner's login. Company-wide, sees everything, can override approvals. */
export async function seedOwnerBase(w: World) {
  await w.addUser('own', 'OWN', { siteId: null, displayName: 'Business owner' });
}

const backdate = (w: World, table: string, id: string, hours: number) =>
  w.pool.query(`UPDATE ${table} SET created_at = now() - ($2 || ' hours')::interval WHERE id=$1`, [id, String(hours)]);

/**
 * Part 1 (slow, done once when the demo snapshot is built): a working factory — stock that went through receiving and quality,
 * and several things waiting for approval, one of them over the commercial approver's limit so only the owner can unblock it.
 * Part 2 (`refreshOwnerDemo`, instant, done when the demo is opened) moves the clock so ages are always fresh.
 *
 * (original description:)
 * A working factory on the day the owner opens it: stock that has gone through receiving and quality, and several things
 * waiting for approval — one of them over the commercial approver's limit, so only the owner can unblock it.
 * Run when the demo is first opened so ages are always fresh.
 */
export async function seedOwnerFloor(w: World) {
  const ver = async (db: { query: (q: string, p?: unknown[]) => Promise<any> }, table: string, id: string) => (await db.query(`SELECT version FROM ${table} WHERE id=$1`, [id])).rows[0].version as number;
  const tag = 'DN-' + Math.floor(Math.random() * 9000 + 1000);

  // One order that went the whole way: approved, released, received, inspected, released from hold, partly reserved
  const done = await w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '800' }] }));
  const s1 = await w.as('buy', (c) => po.submitPO(c, { poId: done.id, expectedVersion: done.version }));
  const a1 = await w.as('com', (c) => po.approvePO(c, { poId: done.id, expectedVersion: s1.version }));
  await w.as('com', (c) => po.releasePO(c, { poId: done.id, expectedVersion: a1.version }));
  const line = (await w.pool.query('SELECT id FROM po_line WHERE po_id=$1', [done.id])).rows[0];
  const rec = await w.as('sto', (c) => rcv.postReceipt(c, { siteId: w.siteId, partnerId: w.vendorId, poId: done.id, challanNo: tag, lines: [{ poLineId: line.id, itemId: w.items.fabric, qty: '800' }] }));
  const lot = rec.lines[0];
  await w.as('qci', (c) => qc.startInspection(c, { inspectionId: lot.inspectionId }));
  await w.as('qci', async (c) => qc.submitInspection(c, { inspectionId: lot.inspectionId, expectedVersion: await ver(c.db, 'qc_inspection', lot.inspectionId), inspectedQty: '30', recommendAccept: '780', recommendReject: '20', defects: [] } as never));
  await w.as('qcm', async (c) => qc.dispositionInspection(c, { inspectionId: lot.inspectionId, expectedVersion: await ver(c.db, 'qc_inspection', lot.inspectionId), acceptQty: '780', rejectQty: '20' }));
  await w.as('sto', (c) => inv.reserveStock(c, { lotId: lot.lotId, qty: '300', demandType: 'cut_order', demandRef: 'CUT-310' }));

  // A second delivery still sitting on quality hold
  const held = await w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '500' }] }));
  const s2 = await w.as('buy', (c) => po.submitPO(c, { poId: held.id, expectedVersion: held.version }));
  const a2 = await w.as('com', (c) => po.approvePO(c, { poId: held.id, expectedVersion: s2.version }));
  await w.as('com', (c) => po.releasePO(c, { poId: held.id, expectedVersion: a2.version }));
  const line2 = (await w.pool.query('SELECT id FROM po_line WHERE po_id=$1', [held.id])).rows[0];
  await w.as('sto', (c) => rcv.postReceipt(c, { siteId: w.siteId, partnerId: w.vendorId, poId: held.id, challanNo: tag + 'B', lines: [{ poLineId: line2.id, itemId: w.items.fabric, qty: '500' }] }));

  // Waiting for approval
  const slow = await w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '1200' }] }));
  await w.as('buy', (c) => po.submitPO(c, { poId: slow.id, expectedVersion: slow.version }));
  await backdate(w, 'purchase_order', slow.id, 30);                                    // overdue
  const big = await w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '2400' }] }));
  await w.as('buy', (c) => po.submitPO(c, { poId: big.id, expectedVersion: big.version }));
  await backdate(w, 'purchase_order', big.id, 6);                                      // ₹6,00,000: above the commercial approver's ₹5,00,000 limit

  const adj = await w.as('inv', (c) => inv.proposeAdjustment(c, { lotId: lot.lotId, locationId: w.loc.store, qtyDelta: '-12', reason: 'Count variance found at the rack', evidence: 'Cycle count sheet 14' }));
  await backdate(w, 'stock_adjustment', adj.id, 9);

  const sal = (await w.pool.query(`SELECT e.id FROM employee e WHERE e.name='Sunita Kamble'`)).rows[0];
  const s = await w.as('hrm', (c) => hr.proposeSalary(c, { employeeId: sal.id, effectiveFrom: new Date().toISOString().slice(0, 10), basic: '15000', hra: '3500', otherAllowance: '1500' }));
  await backdate(w, 'salary_structure', s.id, 20);
}

/** Makes the ages and dates fresh and raises the one urgent request. Cheap, so it can run every time the demo is opened for the first time. */
export async function refreshOwnerDemo(w: World) {
  const q = (sql: string) => w.pool.query(sql);
  await q(`UPDATE purchase_order SET created_at = now() - interval '30 hours' WHERE status='approval_pending' AND total = 300000`);
  await q(`UPDATE purchase_order SET created_at = now() - interval '6 hours' WHERE status='approval_pending' AND total = 600000`);
  await q(`UPDATE stock_adjustment SET created_at = now() - interval '9 hours' WHERE status='proposed'`);
  await q(`UPDATE salary_structure SET created_at = now() - interval '20 hours' WHERE status='proposed'`);
  await q(`UPDATE receipt SET received_at = now() - interval '1 day'`);
  const big = (await w.pool.query(`SELECT id FROM purchase_order WHERE status='approval_pending' AND total = 600000`)).rows[0];
  if (big && !(await w.pool.query(`SELECT 1 FROM escalation LIMIT 1`)).rowCount)
    await w.as('buy', (c) => owner.raiseEscalation(c, { entityType: 'purchase_order', entityId: big.id, urgency: 'urgent', reason: 'Sunrise Textiles holds this price only until tomorrow noon' }));
}

export async function seedOwnerRecent(w: World) { await seedOwnerFloor(w); await refreshOwnerDemo(w); }
