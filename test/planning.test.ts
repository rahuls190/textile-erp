import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as plan from '../src/domain/planning.js';
import { seedSalesBase } from '../src/seed/sales-demo.js';
import { seedMastersDemo } from '../src/seed/masters-demo.js';

async function rejects(p: Promise<unknown>, part: string) {
  try { await p; } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === part || (err.message ?? '').toLowerCase().includes(part.toLowerCase())) return err;
    throw new Error(`Expected "${part}" but got ${err.code}: ${err.message}`);
  }
  throw new Error(`Expected a refusal containing "${part}" but it succeeded`);
}
let w: World; let blk: string; let rib: string; let styleId: string;
beforeAll(async () => {
  w = await freshWorld('plan'); await seedSalesBase(w); await seedMastersDemo(w, true);
  await w.addUser('pln', 'PLN', { displayName: 'Planner' });
  blk = (await w.pool.query(`SELECT item_id FROM sku WHERE code='BRF-01-BLK-M'`)).rows[0].item_id;
  rib = (await w.pool.query(`SELECT id FROM item WHERE name LIKE 'Rib knit%'`)).rows[0].id;
  styleId = (await w.pool.query(`SELECT id FROM product_style WHERE code='BRF-01'`)).rows[0].id;
});
afterAll(async () => { await w.pool.end(); });
const uid = (u: string) => w.actors[u].id;
const sku = (p: Awaited<ReturnType<typeof plan.computePlan>>, code: string) => p.skus.find((k) => k.code === code)!;
const mat = (p: Awaited<ReturnType<typeof plan.computePlan>>, id: string) => p.materials.find((m) => m.item_id === id)!;

describe('who can plan', () => {
  it('lets planners change the plan, others only look, and outsiders see nothing', async () => {
    await rejects(w.as('buy', (c) => plan.setCuttingYield(c, { styleId, yieldPct: 90 })), 'Not permitted');
    await rejects(w.as('sto', (c) => plan.generateRequests(c)), 'Not permitted');
    await rejects(plan.computePlan(w.pool, uid('emp')), 'Not permitted');
    expect((await plan.computePlan(w.pool, uid('buy'))).months).toHaveLength(6);
  });
});

describe('six months of finished pieces', () => {
  it('keeps finished stock at the minimum: a month of cover on top of each month of sales', async () => {
    await w.as('pln', (c) => plan.setItemPlan(c, { itemId: blk, monthlyDemand: '300' }));
    const p = await plan.computePlan(w.pool, uid('pln'));
    const k = sku(p, 'BRF-01-BLK-M');
    expect(k.min).toBe(300);                                   // 300 a month × 30 days of cover ÷ 30
    expect(k.rows[0]).toMatchObject({ demand: 300, opening: 0, production: 600, closing: 300 }); // first month also builds the minimum
    expect(k.rows.slice(1).every((r) => r.production === 300 && r.closing === 300)).toBe(true);
    expect(k.pieces).toBe(2100);
    expect(p.skus.filter((x) => x.idle).length).toBe(p.skus.length - 1); // every other SKU has no sales, so nothing to make
  });
  it('uses a typed manual minimum when it is higher, and a planned figure for one month', async () => {
    await w.as('pln', (c) => plan.setItemPlan(c, { itemId: blk, monthlyDemand: '300', manualMin: '1000' }));
    await w.as('pln', (c) => plan.setDemand(c, { itemId: blk, month: (new Date().toISOString().slice(0, 8) + '01'), qty: '50' }));
    const k = sku(await plan.computePlan(w.pool, uid('pln')), 'BRF-01-BLK-M');
    expect(k.min).toBe(1000);
    expect(k.rows[0].demand).toBe(50);
    expect(k.rows[0].production).toBe(1050);
    await w.as('pln', (c) => plan.setDemand(c, { itemId: blk, month: (new Date().toISOString().slice(0, 8) + '01'), qty: null }));
    await w.as('pln', (c) => plan.setItemPlan(c, { itemId: blk, monthlyDemand: '300' }));
  });
  it('works out the average from real sales when no figure is typed', async () => {
    const cust = (await w.pool.query(`SELECT id FROM partner WHERE code='C-001'`)).rows[0].id;
    const so = (await w.pool.query(`INSERT INTO sales_order(site_id, number, customer_id, status, total, created_by, created_at) VALUES ($1,'SO-T-1',$2,'confirmed',90000,$3, now() - interval '40 days') RETURNING id`, [w.siteId, cust, uid('sal')])).rows[0];
    await w.pool.query(`INSERT INTO so_line(so_id, line_no, item_id, qty, unit, rate, amount) VALUES ($1, 99, $2, 900, 'PC', 100, 90000)`, [so.id, (await w.pool.query(`SELECT item_id FROM sku WHERE code='BRF-01-WHT-L'`)).rows[0].item_id]);
    const k = sku(await plan.computePlan(w.pool, uid('pln')), 'BRF-01-WHT-L');
    expect(k.avg_demand).toBe(300);                            // 900 pieces in the last 3 months
  });
});

describe('materials and requests', () => {
  it('turns pieces into material need, with the BOM size quantities, wastage and cutting yield', async () => {
    const a = mat(await plan.computePlan(w.pool, uid('pln')), rib);
    const perPiece = 0.21 * 1.06;                              // size M quantity with 6% wastage
    const wht = 0.24 * 1.06;                                   // size L; the confirmed order for 900 pieces is firm demand in its month
    expect(a.rows.reduce((s, r) => s + r.need, 0)).toBeCloseTo(2100 * perPiece + (1200 + 300 * 5) * wht, 1);
    await w.as('pln', (c) => plan.setCuttingYield(c, { styleId, yieldPct: 80 }));
    const b = mat(await plan.computePlan(w.pool, uid('pln')), rib);
    expect(b.rows.reduce((s, r) => s + r.need, 0)).toBeCloseTo(a.rows.reduce((s, r) => s + r.need, 0) / 0.8, 0);
    await rejects(w.as('pln', (c) => plan.setCuttingYield(c, { styleId, yieldPct: 30 })), '50 to 100');
  });
  it('buys what falls below the minimum, dated by lead time, and counts stock and open orders', async () => {
    const p = await plan.computePlan(w.pool, uid('pln'));
    const m = mat(p, rib);
    expect(m.vendor).toBeTruthy();
    expect(m.min).toBeGreaterThan(0);
    expect(m.rows[0].buy).toBeGreaterThan(0);
    const line = p.buys.find((b) => b.item_id === rib && b.month === p.months[0])!;
    expect(line.needed_by).toBe(p.asOf);
    expect(line.late).toBe(true);                              // 21 days of lead time cannot fit before today
    expect(line.est_cost).toBeCloseTo(line.qty * 165, 0);
    const later = p.buys.find((b) => b.item_id === rib && b.month === p.months[3])!;
    expect(later.order_by < later.needed_by).toBe(true);
    // every closing balance stays at or above the minimum
    for (const r of m.rows) expect(r.closing).toBeGreaterThanOrEqual(m.min - 0.001);
  });
  it('raises one request per vendor, once, and the buyer turns it into a draft order', async () => {
    const first = await w.as('pln', (c) => plan.generateRequests(c, { withinDays: 30 }));
    expect(first.requests.length).toBeGreaterThan(0);
    expect(first.lines).toBeGreaterThan(0);
    const again = await w.as('pln', (c) => plan.generateRequests(c, { withinDays: 30 }));
    expect(again.requests).toHaveLength(0);                    // open requests already cover it
    const list = await plan.listRequests(w.pool, uid('buy'));
    const open = list.filter((r: { status: string }) => r.status === 'open');
    expect(open.length).toBe(first.requests.length);
    const pick = open.find((r: { partner_id: string | null; lines: { code: string }[] }) => r.partner_id && r.lines.some((l) => l.code === 'FAB-002'))!;
    await rejects(w.as('pln', (c) => plan.convertRequest(c, { requestId: pick.id, expectedVersion: pick.version })), 'Not permitted');
    const r = await w.as('buy', (c) => plan.convertRequest(c, { requestId: pick.id, expectedVersion: pick.version }));
    expect(r.poNumber).toMatch(/^PO-/);
    const po = (await w.pool.query('SELECT status FROM purchase_order WHERE id=$1', [r.poId])).rows[0];
    expect(po.status).toBe('draft');
    await rejects(w.as('buy', (c) => plan.convertRequest(c, { requestId: pick.id, expectedVersion: pick.version + 1 })), 'already converted');
  });
  it('cancels a request with a reason, and the shortage comes back on the next run', async () => {
    const open = (await plan.listRequests(w.pool, uid('buy'))).filter((x: { status: string }) => x.status === 'open');
    expect(open.length).toBeGreaterThan(0);
    await rejects(w.as('pln', (c) => plan.cancelRequest(c, { requestId: open[0].id, expectedVersion: open[0].version, reason: '' })), 'why');
    await w.as('pln', (c) => plan.cancelRequest(c, { requestId: open[0].id, expectedVersion: open[0].version, reason: 'Vendor closed' }));
    const re = await w.as('pln', (c) => plan.generateRequests(c, { withinDays: 30 }));
    expect(re.lines).toBeGreaterThan(0);
  });
});

describe('finishing: grey fabric becomes finished fabric', () => {
  it('buys the grey fabric for what the finished fabric needs, with the loss in finishing added', async () => {
    const grey = w.items.fabric;
    await rejects(w.as('pln', (c) => plan.setItemPlan(c, { itemId: rib, greyItemId: rib })), 'itself');
    await w.as('pln', (c) => plan.setItemPlan(c, { itemId: rib, greyItemId: grey, finishLossPct: '10' }));
    const p = await plan.computePlan(w.pool, uid('pln'));
    const finished = mat(p, rib), g = mat(p, grey);
    expect(finished.make).toBe(true);
    expect(p.buys.some((b) => b.item_id === rib)).toBe(false);          // finished fabric is made, not bought
    const made = finished.rows.reduce((s, r) => s + r.buy, 0);
    expect(g.rows.reduce((s, r) => s + r.need, 0)).toBeCloseTo(made / 0.9, 1);
    expect(p.buys.some((b) => b.item_id === grey)).toBe(true);
    await rejects(w.as('pln', (c) => plan.setItemPlan(c, { itemId: grey, greyItemId: rib })), 'made from another');
  });
});

describe('company settings', () => {
  it('changes the months averaged and refuses nonsense', async () => {
    await rejects(w.as('pln', (c) => plan.updateSettings(c, { horizonMonths: 24 })), '1 to 12');
    await w.as('pln', (c) => plan.updateSettings(c, { horizonMonths: 3 }));
    expect((await plan.computePlan(w.pool, uid('pln'))).months).toHaveLength(3);
    await w.as('pln', (c) => plan.updateSettings(c, { horizonMonths: 6 }));
  });
});
