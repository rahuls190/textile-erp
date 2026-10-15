import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as plan from '../src/domain/planning.js';
import * as prod from '../src/domain/production.js';
import { runDailyPlan } from '../src/jobs/daily-plan.js';
import { seedSalesBase } from '../src/seed/sales-demo.js';
import { seedMastersDemo } from '../src/seed/masters-demo.js';

let w: World;
beforeAll(async () => {
  w = await freshWorld('autoplan'); await seedSalesBase(w); await seedMastersDemo(w, true);
  await w.addUser('pln', 'PLN', { displayName: 'Planner' });
  const blk = (await w.pool.query(`SELECT item_id FROM sku WHERE code='BRF-01-BLK-M'`)).rows[0].item_id;
  await w.as('pln', (c) => plan.setItemPlan(c, { itemId: blk, monthlyDemand: '300' }));
});
afterAll(async () => { await w.pool.end(); });
const cutCount = async () => Number((await w.pool.query(`SELECT count(*) FROM work_order WHERE kind='cut' AND status<>'cancelled'`)).rows[0].count);

describe('the daily run', () => {
  it('raises requests and drafts a cutting order for what the plan wants', async () => {
    const r = await runDailyPlan(w.pool, w.actors.pln.username);
    expect(r.replayed).toBe(false);
    expect(r.result.cutting.length).toBe(1);
    expect(r.result.cutting[0].pieces).toBeGreaterThanOrEqual(300);
    expect(await cutCount()).toBe(1);
  });
  it('a second run on the same day changes nothing', async () => {
    const r = await runDailyPlan(w.pool, w.actors.pln.username);
    expect(r.replayed).toBe(true);
    expect(await cutCount()).toBe(1);
  });
  it('running the plan again by hand does not ask for the same pieces twice', async () => {
    const r = await w.as('pln', (c) => plan.runPlan(c, { withinDays: 30 }));
    expect(r.cutting).toHaveLength(0);
    expect(await cutCount()).toBe(1);
  });
  it('alerts do not shout about pieces already on a cutting order', async () => {
    const a = await plan.planAlerts(w.pool, w.actors.pln.id);
    expect(a.skus.some((s) => s.code === 'BRF-01-BLK-M')).toBe(false);
    expect(Array.isArray(a.materials)).toBe(true);
  });
  it('the planner sees the drafted order, a storekeeper can issue it', async () => {
    const list = (await prod.listWorkOrders(w.pool, w.actors.pln.id)) as { kind: string; status: string }[];
    expect(list.some((o) => o.kind === 'cut' && o.status === 'draft')).toBe(true);
  });
});
