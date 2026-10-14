import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan, can, visibleSites } from '../core/permissions.js';
import { audit, emit } from '../core/audit.js';
import { badRequest, conflict, invalidState, notFound } from '../core/errors.js';
import { nextNumber } from '../core/numbering.js';
import { qGt, qSub } from '../core/qty.js';
import { postMovement } from './inventory.js';
import { isReceivable, refreshPoStatus } from './po.js';

export interface ReceiptLineInput { poLineId?: string; itemId: string; qty: string; unit?: string; attributes?: object }

/**
 * W01: record what physically arrived. Arrival NEVER creates usable stock — every line lands in
 * QC HOLD at the receiving location and raises an inspection. Only quality authority can release it.
 */
export async function postReceipt(ctx: Ctx, i: {
  siteId: string; partnerId: string; poId?: string | null; challanNo: string; vehicleNo?: string; notes?: string;
  receivingLocationId?: string; acknowledgeDuplicate?: boolean; lines: ReceiptLineInput[];
}) {
  await assertCan(ctx.db, ctx.actor.id, 'receipt.post', { siteId: i.siteId });
  if (!i.lines.length) throw badRequest('A receipt needs at least one line');
  if (!i.challanNo.trim()) throw badRequest('Challan / invoice number is required');

  const partner = (await ctx.db.query('SELECT id, status FROM partner WHERE id=$1', [i.partnerId])).rows[0];
  if (!partner) throw notFound('Partner');

  const dup = await ctx.db.query(`SELECT number FROM receipt WHERE partner_id=$1 AND challan_no=$2 AND status='posted'`, [i.partnerId, i.challanNo]);
  if (dup.rowCount) {
    const allowed = i.acknowledgeDuplicate && (await can(ctx.db, ctx.actor.id, 'receipt.exception.approve', { siteId: i.siteId }));
    if (!allowed) throw conflict('DUPLICATE_CHALLAN', `Challan ${i.challanNo} was already received as ${dup.rows[0].number}; an inventory controller must acknowledge a repeat`);
  }

  let recvLoc: { id: string };
  if (i.receivingLocationId) {
    const l = (await ctx.db.query(`SELECT id FROM location WHERE id=$1 AND site_id=$2 AND kind='RECEIVING'`, [i.receivingLocationId, i.siteId])).rows[0];
    if (!l) throw badRequest('Receiving location is not a RECEIVING location at this site');
    recvLoc = l;
  } else {
    const ls = (await ctx.db.query(`SELECT id FROM location WHERE site_id=$1 AND kind='RECEIVING'`, [i.siteId])).rows;
    if (ls.length !== 1) throw invalidState(ls.length ? 'Several receiving locations exist; choose one' : 'This site has no receiving location configured');
    recvLoc = ls[0];
  }

  // PO linkage: lock the order, then validate every line against its remaining receivable balance
  const room = new Map<string, string>();
  if (i.poId) {
    const po = (await ctx.db.query('SELECT * FROM purchase_order WHERE id=$1 FOR UPDATE', [i.poId])).rows[0];
    if (!po) throw notFound('Purchase order');
    if (po.partner_id !== i.partnerId) throw badRequest('Vendor does not match the purchase order');
    if (!isReceivable(po.status)) throw invalidState(`PO ${po.number} is ${po.status}; it cannot receive material`);
    for (const pl of (await ctx.db.query('SELECT * FROM po_line WHERE po_id=$1', [i.poId])).rows)
      room.set(pl.id, qSub(pl.qty, qSub(pl.received_qty, pl.rejected_qty)));
  }

  const number = await nextNumber(ctx, i.siteId, 'MR');
  const rc = (await ctx.db.query(
    `INSERT INTO receipt(site_id, number, po_id, partner_id, challan_no, vehicle_no, received_by, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [i.siteId, number, i.poId ?? null, i.partnerId, i.challanNo, i.vehicleNo ?? null, ctx.actor.id, i.notes ?? null])).rows[0];

  const created: { lineNo: number; lotId: string; label: string; qty: string; inspectionId: string }[] = [];
  for (const [idx, l] of i.lines.entries()) {
    const lineNo = idx + 1;
    if (!qGt(l.qty, '0')) throw badRequest(`Line ${lineNo}: quantity must be positive`);
    const item = (await ctx.db.query('SELECT id, code, status, stock_unit FROM item WHERE id=$1', [l.itemId])).rows[0];
    if (!item) throw notFound(`Item on line ${lineNo}`);
    if (item.status !== 'active') throw invalidState(`Line ${lineNo}: item ${item.code} is ${item.status}`);
    if (l.unit && l.unit !== item.stock_unit) throw badRequest(`Line ${lineNo}: unit ${l.unit} is not the stock unit ${item.stock_unit}; no conversion is configured`);

    if (i.poId) {
      if (!l.poLineId || !room.has(l.poLineId)) throw badRequest(`Line ${lineNo}: must reference a line of the purchase order`);
      const pl = (await ctx.db.query('SELECT item_id FROM po_line WHERE id=$1', [l.poLineId])).rows[0];
      if (pl.item_id !== l.itemId) throw badRequest(`Line ${lineNo}: item does not match the PO line`);
      const left = room.get(l.poLineId)!;
      if (qGt(l.qty, left)) throw conflict('EXCESS_RECEIPT', `Line ${lineNo}: receiving ${l.qty} exceeds the ${left} still open on the PO line`, { open: left, received: l.qty });
      room.set(l.poLineId, qSub(left, l.qty));
    }

    const label = `${number}/${lineNo}`;
    const lot = (await ctx.db.query(
      `INSERT INTO lot(site_id, item_id, label, source_receipt_id, source_po_line_id, attributes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [i.siteId, l.itemId, label, rc.id, l.poLineId ?? null, JSON.stringify(l.attributes ?? {})])).rows[0];
    const rl = (await ctx.db.query(
      `INSERT INTO receipt_line(receipt_id, line_no, po_line_id, item_id, lot_id, qty, unit) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [rc.id, lineNo, l.poLineId ?? null, l.itemId, lot.id, l.qty, item.stock_unit])).rows[0];

    await postMovement(ctx, {
      type: 'RECEIPT', sourceType: 'receipt', sourceId: rc.id,
      legs: [{ siteId: i.siteId, lotId: lot.id, itemId: l.itemId, locationId: recvLoc.id, status: 'HOLD', qty: l.qty, unit: item.stock_unit }],
    });
    const q = (await ctx.db.query(`INSERT INTO qc_inspection(site_id, receipt_line_id, lot_id) VALUES ($1,$2,$3) RETURNING id`, [i.siteId, rl.id, lot.id])).rows[0];
    if (l.poLineId) await ctx.db.query('UPDATE po_line SET received_qty = received_qty + $2 WHERE id=$1', [l.poLineId, l.qty]);
    created.push({ lineNo, lotId: lot.id, label, qty: l.qty, inspectionId: q.id });
  }
  if (i.poId) await refreshPoStatus(ctx, i.poId);

  await audit(ctx, { action: 'receipt.post', entityType: 'receipt', entityId: rc.id, after: { number, challan: i.challanNo, lines: created.length } });
  await emit(ctx, { type: 'receipt.posted', entityType: 'receipt', entityId: rc.id, siteId: i.siteId, payload: { number, poId: i.poId ?? null, lines: created } });
  return { id: rc.id, number, lines: created };
}

export async function getReceipt(db: Db, userId: string, id: string) {
  const rc = (await db.query('SELECT * FROM receipt WHERE id=$1', [id])).rows[0];
  if (!rc || !(await can(db, userId, 'receipt.view', { siteId: rc.site_id }))) throw notFound('Receipt');
  const lines = (await db.query(
    `SELECT rl.*, l.label, q.id AS inspection_id, q.status AS qc_status
       FROM receipt_line rl JOIN lot l ON l.id = rl.lot_id LEFT JOIN qc_inspection q ON q.receipt_line_id = rl.id
      WHERE rl.receipt_id=$1 ORDER BY rl.line_no`, [id])).rows;
  return { ...rc, lines };
}

export async function listReceipts(db: Db, userId: string) {
  const sites = await visibleSites(db, userId, 'receipt.view');
  if (sites && !sites.length) return [];
  return (await db.query(
    `SELECT r.id, r.number, r.challan_no, r.received_at, p.name AS vendor, r.site_id
       FROM receipt r JOIN partner p ON p.id = r.partner_id
      WHERE ($1::uuid[] IS NULL OR r.site_id = ANY($1::uuid[])) ORDER BY r.received_at DESC LIMIT 200`, [sites])).rows;
}

