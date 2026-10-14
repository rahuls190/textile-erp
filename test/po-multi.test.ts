import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as po from '../src/domain/po.js';
import * as masters from '../src/domain/masters.js';

async function rejects(p: Promise<unknown>, part: string) {
  try { await p; } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === part || (err.message ?? '').toLowerCase().includes(part.toLowerCase())) return err;
    throw new Error(`Expected "${part}" but got ${err.code}: ${err.message}`);
  }
  throw new Error(`Expected a refusal containing "${part}" but it succeeded`);
}
let w: World;
beforeAll(async () => {
  w = await freshWorld('pomulti');
  // an approved price for the trim too, so one order can hold two different items
  const r = await w.as('buy', (c) => masters.proposeRate(c, { partnerId: w.vendorId, itemId: w.items.trim, rate: '12.5000', effectiveFrom: '2026-01-01' }));
  await w.as('com', (c) => masters.approveRate(c, { rateId: r.id }));
});
afterAll(async () => { await w.pool.end(); });

describe('purchase order with several items', () => {
  it('keeps each item\'s own quantity, price and due date, and totals them', async () => {
    const p = await w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [
      { itemId: w.items.fabric, qty: '500', dueDate: '2026-11-30' }, { itemId: w.items.trim, qty: '2000', dueDate: '2026-12-10' }, { itemId: w.items.fabric, qty: '100', dueDate: '2027-01-15' }] }));
    const lines = (await w.pool.query('SELECT line_no, qty::text, rate::text, due_date::text FROM po_line WHERE po_id=$1 ORDER BY line_no', [p.id])).rows;
    expect(lines.map((l) => l.due_date)).toEqual(['2026-11-30', '2026-12-10', '2027-01-15']);
    expect(lines.map((l) => Number(l.qty))).toEqual([500, 2000, 100]);
    expect(Number(p.total)).toBe(500 * 250 + 2000 * 12.5 + 100 * 250);
  });
  it('lets the creator change the items of a draft, and nobody else', async () => {
    const p = await w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '10' }] }));
    const u = await w.as('buy', (c) => po.updateDraftPO(c, { poId: p.id, expectedVersion: p.version, lines: [{ itemId: w.items.fabric, qty: '20', dueDate: '2026-12-01' }, { itemId: w.items.trim, qty: '30', dueDate: '2026-12-05' }] }));
    expect(Number(u.total)).toBe(20 * 250 + 30 * 12.5);
    expect((await w.pool.query('SELECT count(*)::int n FROM po_line WHERE po_id=$1', [p.id])).rows[0].n).toBe(2);
    await rejects(w.as('com', (c) => po.updateDraftPO(c, { poId: p.id, expectedVersion: u.version, lines: [{ itemId: w.items.fabric, qty: '1' }] })), 'Not permitted');
  });
  it('refuses empty, zero, text quantities and bad dates, and names the item', async () => {
    const base = { siteId: w.siteId, partnerId: w.vendorId };
    await rejects(w.as('buy', (c) => po.createPO(c, { ...base, lines: [] })), 'at least one item');
    await rejects(w.as('buy', (c) => po.createPO(c, { ...base, lines: [{ itemId: w.items.fabric, qty: '5' }, { itemId: w.items.trim, qty: '0' }] })), 'Item 2');
    await rejects(w.as('buy', (c) => po.createPO(c, { ...base, lines: [{ itemId: w.items.fabric, qty: 'abc' }] })), 'positive number');
    await rejects(w.as('buy', (c) => po.createPO(c, { ...base, lines: [{ itemId: w.items.fabric, qty: '5', dueDate: '31/12/2026' }] })), 'due date');
  });
  it('shows the approved price per line before saving', async () => {
    const q = await po.quoteLines(w.pool, w.actors.buy.id, { partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '4' }, { itemId: w.items.trim, qty: '8' }, { itemId: w.items.trim, qty: '' }] });
    expect(q[0].amount).toBe('1000.00'); expect(q[1].rate).toBe('12.5000'); expect(q[2].rate).toBeNull();
  });
});
