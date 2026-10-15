import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as plan from '../src/domain/planning.js';
import * as po from '../src/domain/po.js';
import * as rcv from '../src/domain/receipt.js';
import * as qc from '../src/domain/qc.js';
import * as prod from '../src/domain/production.js';
import { availability } from '../src/domain/inventory.js';
import { seedSalesBase } from '../src/seed/sales-demo.js';
import { seedMastersDemo } from '../src/seed/masters-demo.js';

let w: World; let grey: string; let rib: string; let styleId: string; const sku: Record<string, string> = {};
const rejects = async (p: Promise<unknown>, m: RegExp | string) => { await expect(p).rejects.toSatisfy((e: any) => (typeof m === 'string' ? e.code === m : m.test(e.message))); };
const ver = async (t: string, id: string) => Number((await w.pool.query(`SELECT version FROM ${t} WHERE id=$1`, [id])).rows[0].version);
let seq = 0;
/** Orders, receives and passes QC, so the stock is real accepted stock. Returns the lot id. */
async function accepted(itemId: string, qty: string): Promise<string> {
  const p = await w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId, qty, rate: '1.0000' }] }));
  const s = await w.as('buy', (c) => po.submitPO(c, { poId: p.id, expectedVersion: p.version }));
  const a = await w.as('com', (c) => po.approvePO(c, { poId: p.id, expectedVersion: s.version }));
  await w.as('com', (c) => po.releasePO(c, { poId: p.id, expectedVersion: a.version }));
  const line = (await w.pool.query('SELECT id FROM po_line WHERE po_id=$1', [p.id])).rows[0].id;
  await w.as('sto', (c) => rcv.postReceipt(c, { siteId: w.siteId, partnerId: w.vendorId, poId: p.id, challanNo: `CH-P${++seq}`, lines: [{ poLineId: line, itemId, qty }] }));
  const insp = (await w.pool.query(`SELECT i.id, i.lot_id FROM qc_inspection i JOIN lot l ON l.id=i.lot_id WHERE l.item_id=$1 ORDER BY i.created_at DESC LIMIT 1`, [itemId])).rows[0];
  return passQc(insp.id, qty, insp.lot_id);
}
async function passQc(insp: string, qty: string, lot?: string): Promise<string> {
  await w.as('qci', (c) => qc.startInspection(c, { inspectionId: insp }));
  await w.as('qci', async (c) => qc.submitInspection(c, { inspectionId: insp, expectedVersion: await ver('qc_inspection', insp), inspectedQty: qty, recommendAccept: qty, recommendReject: '0' }));
  await w.as('qcm', async (c) => qc.dispositionInspection(c, { inspectionId: insp, expectedVersion: await ver('qc_inspection', insp), acceptQty: qty, rejectQty: '0' }));
  return lot ?? (await w.pool.query('SELECT lot_id FROM qc_inspection WHERE id=$1', [insp])).rows[0].lot_id;
}
const acc = async (lot: string) => Number((await availability(w.pool, lot)).available);

beforeAll(async () => {
  w = await freshWorld('production'); await seedSalesBase(w); await seedMastersDemo(w, true);
  await w.addUser('pln', 'PLN', { displayName: 'Planner' });
  grey = w.items.fabric;
  rib = (await w.pool.query(`SELECT id FROM item WHERE name LIKE 'Rib knit 220%'`)).rows[0].id;
  styleId = (await w.pool.query(`SELECT id FROM product_style WHERE code='BRF-01'`)).rows[0].id;
  for (const r of (await w.pool.query(`SELECT code, id FROM sku WHERE style_id=$1`, [styleId])).rows) sku[r.code] = r.id;
});
afterAll(async () => { await w.pool.end(); });

describe('finishing: grey fabric out, finished fabric back, loss recorded', () => {
  let greyLot = ''; let wo: any; let out: { lotId: string; inspectionId: string };
  it('plans and issues the grey roll', async () => {
    greyLot = await accepted(grey, '1000');
    wo = await w.as('pln', (c) => prod.createFinishOrder(c, { lotId: greyLot, qty: '600', outItemId: rib, finishName: 'Dyed black', colour: 'BLK' }));
    await rejects(w.as('pln', (c) => prod.createFinishOrder(c, { lotId: greyLot, qty: '500', outItemId: rib, finishName: 'x' })), /free/);
    await rejects(w.as('pln', (c) => prod.issueFinish(c, { woId: wo.id, expectedVersion: wo.version })), /Not permitted/);
    wo = await w.as('sto', (c) => prod.issueFinish(c, { woId: wo.id, expectedVersion: wo.version }));
    expect(wo.status).toBe('issued'); expect(await acc(greyLot)).toBe(400);
  });
  it('receives less than went out, puts it on QC hold, and QC makes it usable', async () => {
    const r = await w.as('sto', (c) => prod.receiveFinish(c, { woId: wo.id, expectedVersion: wo.version, qty: '552' }));
    expect(r.lossPct).toBe(8); expect(Number(r.loss)).toBe(48);
    expect(await acc(r.lotId)).toBe(0);
    await passQc(r.inspectionId, '552', r.lotId);
    expect(await acc(r.lotId)).toBe(552);
    out = r;
  });
  it('splits the finished lot by shade', async () => {
    const parts = await w.as('sto', (c) => prod.splitLot(c, { lotId: out.lotId, parts: [{ qty: '300', shade: 'A', colour: 'BLK' }, { qty: '200', shade: 'B', colour: 'BLK' }] }));
    expect(parts.lots.length).toBe(2);
    expect(await acc(out.lotId)).toBe(52);
    const kids = (await w.pool.query(`SELECT label FROM lot WHERE parent_lot_id=$1 ORDER BY label`, [out.lotId])).rows.map((r) => r.label);
    expect(kids.length).toBe(2); expect(kids[0]).toMatch(/-A$/);
  });
});

describe('cutting: issue by BOM, yield below plan, QC, shortfall re-planned', () => {
  let wo: any;
  it('refuses to issue without stock and says what is missing', async () => {
    wo = await w.as('pln', (c) => prod.createCutOrder(c, { siteId: w.siteId, styleId, lines: [{ skuId: sku['BRF-01-BLK-M'], qty: 100 }, { skuId: sku['BRF-01-BLK-L'], qty: 50 }] }));
    const needs = await prod.cutNeeds(w.pool, wo.id);
    expect(needs.length).toBeGreaterThan(2);
    await rejects(w.as('sto', (c) => prod.issueCut(c, { woId: wo.id, expectedVersion: wo.version })), /Not enough accepted stock/);
  });
  it('issues once all materials are accepted, then completes with fewer pieces', async () => {
    for (const n of await prod.cutNeeds(w.pool, wo.id)) {
      const have = n.itemId === rib ? 0 : 0; void have;
      if (n.itemId === rib) continue;
      await accepted(n.itemId, String(Math.ceil(n.qty) + 5));
    }
    const bk = (await w.pool.query(`SELECT l.id FROM lot l WHERE l.item_id=$1 AND l.attributes->>'colour'='BLK' AND l.parent_lot_id IS NOT NULL`, [rib])).rows;
    expect(bk.length).toBeGreaterThanOrEqual(2);
    wo = await w.as('sto', (c) => prod.issueCut(c, { woId: wo.id, expectedVersion: wo.version }));
    expect(wo.status).toBe('issued');
    await rejects(w.as('sto', (c) => prod.completeCut(c, { woId: wo.id, expectedVersion: wo.version, actual: [{ skuId: sku['BRF-01-BLK-M'], qty: 101 }] })), /more than/);
    const r = await w.as('sto', (c) => prod.completeCut(c, { woId: wo.id, expectedVersion: wo.version, actual: [{ skuId: sku['BRF-01-BLK-M'], qty: 94 }, { skuId: sku['BRF-01-BLK-L'], qty: 47 }] }));
    expect(r.planned).toBe(150); expect(r.actual).toBe(141); expect(r.shortfall).toBe(9); expect(r.yieldPct).toBe(94);
    for (const m of r.made) { expect(await acc(m.lotId!)).toBe(0); await passQc(m.inspectionId!, String(m.actual), m.lotId); expect(await acc(m.lotId!)).toBe(m.actual); }
  });
  it('lists the orders for those who may see them, and hides them from others', async () => {
    expect((await prod.listWorkOrders(w.pool, w.actors.pln.id)).length).toBe(2);
    expect((await prod.listWorkOrders(w.pool, w.actors.sto.id)).length).toBe(2);
    await rejects(w.as('sal', (c) => prod.createCutOrder(c, { siteId: w.siteId, styleId, lines: [{ skuId: sku['BRF-01-BLK-M'], qty: 1 }] })), /Not permitted/);
  });
  it('cancels only a draft', async () => {
    let d = await w.as('pln', (c) => prod.createCutOrder(c, { siteId: w.siteId, styleId, lines: [{ skuId: sku['BRF-01-WHT-M'], qty: 10 }] }));
    d = await w.as('pln', (c) => prod.cancelWorkOrder(c, { woId: d.id, expectedVersion: d.version, reason: 'changed plan' }));
    expect(d.status).toBe('cancelled');
    await rejects(w.as('pln', (c) => prod.cancelWorkOrder(c, { woId: wo.id, expectedVersion: wo.version, reason: 'x' })), /./);
  });
});

describe('planning sees work in progress', () => {
  it('counts a draft cut order as pieces arriving', async () => {
    const p0 = await plan.computePlan(w.pool, w.actors.pln.id);
    const open0 = (p0.skus.find((s: any) => s.code === 'BRF-01-WHT-M') as any).rows[0];
    const d = await w.as('pln', (c) => prod.createCutOrder(c, { siteId: w.siteId, styleId, lines: [{ skuId: sku['BRF-01-WHT-M'], qty: 40 }] }));
    const p1 = await plan.computePlan(w.pool, w.actors.pln.id);
    const open1 = (p1.skus.find((s: any) => s.code === 'BRF-01-WHT-M') as any).rows[0];
    expect(open1.opening).toBe(open0.opening + 40);
    expect(d.status).toBe('draft');
  });
});
