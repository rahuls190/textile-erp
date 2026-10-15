import type { World } from './demo.js';
import * as plan from '../domain/planning.js';
import * as prod from '../domain/production.js';

/** A planner, expected sales for the demo style, a cutting yield, and rib fabric made from grey fabric. Then the first purchase requests. */
export async function seedPlanningDemo(w: World) {
  await w.addUser('pln', 'PLN', { displayName: 'Sanjay Kulkarni' });
  const item = async (code: string) => (await w.pool.query('SELECT item_id FROM sku WHERE code=$1', [code])).rows[0].item_id as string;
  const demand: Record<string, string> = { 'BRF-01-BLK-S': '220', 'BRF-01-BLK-M': '480', 'BRF-01-BLK-L': '400', 'BRF-01-BLK-XL': '180', 'BRF-01-WHT-S': '200', 'BRF-01-WHT-M': '420', 'BRF-01-WHT-L': '360', 'BRF-01-WHT-XL': '150', 'BRF-01-NVY-M': '260', 'BRF-01-NVY-L': '220' };
  for (const [code, q] of Object.entries(demand)) { const itemId = await item(code); await w.as('pln', (c) => plan.setItemPlan(c, { itemId, monthlyDemand: q })); }
  const style = (await w.pool.query(`SELECT id FROM product_style WHERE code='BRF-01'`)).rows[0].id;
  await w.as('pln', (c) => plan.setCuttingYield(c, { styleId: style, yieldPct: 92 }));
  const rib = (await w.pool.query(`SELECT id FROM item WHERE name LIKE 'Rib knit 220%'`)).rows[0].id;
  await w.as('pln', (c) => plan.setItemPlan(c, { itemId: rib, greyItemId: w.items.fabric, finishLossPct: '8', leadDays: 14 }));
  await w.as('pln', (c) => plan.generateRequests(c, { withinDays: 45 }));
  // A finishing order waiting to be sent out, so the Work orders screen has something to show.
  const plid = w.actors.pln.id;
  const lots = (await prod.freeFabricLots(w.pool, plid)).filter((l: { item_id: string }) => l.item_id === w.items.fabric);
  if (lots.length) {
    const lot = lots.sort((a: { free: number }, b: { free: number }) => b.free - a.free)[0];
    await w.as('pln', (c) => prod.createFinishOrder(c, { lotId: lot.id, qty: String(Math.min(lot.free, 120)), outItemId: rib, finishName: 'Dyed black', colour: 'BLK', notes: 'Demo order' }));
  }
}
