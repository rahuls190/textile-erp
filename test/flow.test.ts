import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as plan from '../src/domain/planning.js';
import * as po from '../src/domain/po.js';
import * as rcv from '../src/domain/receipt.js';
import * as qc from '../src/domain/qc.js';
import { seedSalesBase } from '../src/seed/sales-demo.js';
import { seedMastersDemo } from '../src/seed/masters-demo.js';

let w: World; let grey: string; let blk: string; let rib: string;
beforeAll(async () => {
  w = await freshWorld('flow'); await seedSalesBase(w); await seedMastersDemo(w, true);
  await w.addUser('pln', 'PLN', { displayName: 'Planner' });
  grey = w.items.fabric;
  blk = (await w.pool.query(`SELECT item_id FROM sku WHERE code='BRF-01-BLK-M'`)).rows[0].item_id;
  rib = (await w.pool.query(`SELECT id FROM item WHERE name LIKE 'Rib knit 220%'`)).rows[0].id;
  await w.as('pln', (c) => plan.setItemPlan(c, { itemId: blk, monthlyDemand: '300' }));
  await w.as('pln', (c) => plan.setItemPlan(c, { itemId: rib, greyItemId: grey, finishLossPct: '10' }));
});
afterAll(async () => { await w.pool.end(); });
const uid = (u: string) => w.actors[u].id;
const greyBuy = async () => (await plan.computePlan(w.pool, uid('pln'))).buys.filter((b) => b.item_id === grey).reduce((a, b) => a + b.qty, 0);
const greyNeed = async () => (await plan.computePlan(w.pool, uid('pln'))).materials.find((m) => m.item_id === grey)!.rows.reduce((a, r) => a + r.need, 0);

describe('plan → request → order → receipt → QC, without asking twice', () => {
  let need = 0; let pr: { id: string; version: number }; let order: { poId: string }; let lineId: string; let qty = '';
  it('plans a shortage of grey fabric and raises one request', async () => {
    need = await greyNeed(); expect(need).toBeGreaterThan(0);
    const r = await w.as('pln', (c) => plan.generateRequests(c, { withinDays: 365 }));
    expect(r.requests.length).toBeGreaterThan(0);
    const list = await plan.listRequests(w.pool, uid('buy'));
    pr = list.find((x: { lines: { item_id: string }[]; status: string }) => x.status === 'open' && x.lines.some((l) => l.item_id === grey))!;
    expect(pr).toBeTruthy();
  });
  it('turning the request into a draft order does not make the shortage come back', async () => {
    order = await w.as('buy', (c) => plan.convertRequest(c, { requestId: pr.id, expectedVersion: pr.version }));
    expect(await greyBuy()).toBe(0);
    const again = await w.as('pln', (c) => plan.generateRequests(c, { withinDays: 365 }));
    expect(again.requests.flatMap((x) => x.lines)).toHaveLength(again.requests.length ? again.lines : 0);
    expect((await plan.listRequests(w.pool, uid('buy'))).filter((x: { status: string; lines: { item_id: string }[] }) => x.status === 'open' && x.lines.some((l) => l.item_id === grey))).toHaveLength(0);
  });
  it('approving and releasing the order keeps it covered', async () => {
    let p = (await w.pool.query('SELECT * FROM purchase_order WHERE id=$1', [order.poId])).rows[0];
    p = await w.as('buy', (c) => po.submitPO(c, { poId: p.id, expectedVersion: p.version }));
    p = await w.as('com', (c) => po.approvePO(c, { poId: p.id, expectedVersion: p.version }));
    p = await w.as('com', (c) => po.releasePO(c, { poId: p.id, expectedVersion: p.version }));
    expect(await greyBuy()).toBe(0);
    const l = (await w.pool.query('SELECT id, qty::text FROM po_line WHERE po_id=$1 AND item_id=$2', [order.poId, grey])).rows[0]; lineId = l.id; qty = l.qty;
  });
  it('goods that arrived and are waiting for QC count as supply', async () => {
    await w.as('sto', (c) => rcv.postReceipt(c, { siteId: w.siteId, partnerId: w.vendorId, poId: order.poId, challanNo: 'CH-F1', lines: [{ poLineId: lineId, itemId: grey, qty }] }));
    expect(await greyBuy()).toBe(0);
  });
  it('after QC accepts them, the stock is what the plan builds on', async () => {
    const insp = (await w.pool.query(`SELECT id FROM qc_inspection ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
    await w.as('qci', (c) => qc.startInspection(c, { inspectionId: insp }));
    let v = (await w.pool.query('SELECT version FROM qc_inspection WHERE id=$1', [insp])).rows[0].version;
    await w.as('qci', (c) => qc.submitInspection(c, { inspectionId: insp, expectedVersion: v, inspectedQty: qty, recommendAccept: qty, recommendReject: '0' }));
    v = (await w.pool.query('SELECT version FROM qc_inspection WHERE id=$1', [insp])).rows[0].version;
    await w.as('qcm', (c) => qc.dispositionInspection(c, { inspectionId: insp, expectedVersion: v, acceptQty: qty, rejectQty: '0' }));
    expect(await greyBuy()).toBe(0);
    const m = (await plan.computePlan(w.pool, uid('pln'))).materials.find((x) => x.item_id === grey)!;
    expect(m.on_hand).toBeGreaterThanOrEqual(Number(qty));
  });
});
