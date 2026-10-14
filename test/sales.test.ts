import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld, rejects } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as sales from '../src/domain/sales.js';
import * as inv from '../src/domain/inventory.js';
import { seedOwnerRecent } from '../src/seed/owner-demo.js';
import { seedSalesBase, seedSalesFloor } from '../src/seed/sales-demo.js';

let w: World;
let lak: string, urb: string, lot: string, lotLoc: string;
beforeAll(async () => {
  w = await freshWorld('sales');
  await seedSalesBase(w); await seedOwnerRecent(w); await seedSalesFloor(w);
  const c = (await w.pool.query(`SELECT code, id FROM partner WHERE code IN ('C-001','C-002')`)).rows;
  lak = c.find((x) => x.code === 'C-001').id; urb = c.find((x) => x.code === 'C-002').id;
  const l = (await w.pool.query(`SELECT l.id FROM lot l ORDER BY (SELECT COALESCE(sum(qty),0) FROM stock_ledger WHERE lot_id=l.id AND status='ACCEPTED') DESC LIMIT 1`)).rows[0];
  lot = l.id;
  lotLoc = (await w.pool.query(`SELECT sl.location_id FROM stock_ledger sl JOIN location loc ON loc.id=sl.location_id WHERE sl.lot_id=$1 AND sl.status='ACCEPTED' AND loc.kind IN ('RECEIVING','STORE','RACK') GROUP BY 1 HAVING sum(sl.qty)>0 LIMIT 1`, [lot])).rows[0].location_id;
});
afterAll(async () => { await w.pool.end(); });
const fab = () => w.items.fabric;
const draft = (who: string, customerId: string, qty: string, rate = '300', discPct?: string) => w.as(who, (c) => sales.createOrder(c, { siteId: w.siteId, customerId, lines: [{ itemId: fab(), qty, rate, discPct }] }));
const confirm = async (customerId: string, qty: string, rate = '300') => {
  const o = await draft('sal', customerId, qty, rate);
  const s = await w.as('sal', (c) => sales.submitOrder(c, { orderId: o.id, expectedVersion: o.version }));
  return w.as('slm', (c) => sales.approveOrder(c, { orderId: o.id, expectedVersion: s.version }));
};

describe('CRM', () => {
  it('keeps a pipeline, follow-ups, and refuses duplicates', async () => {
    const r = await sales.listLeads(w.pool, w.actors.sal.id);
    expect(r!.leads.length).toBeGreaterThanOrEqual(5);
    expect(r!.leads.some((l) => l.overdue)).toBe(true);
    expect(r!.todo.length).toBeGreaterThan(0);
    await rejects(w.as('sal', (c) => sales.createLead(c, { name: 'Again', phone: '9845012345' })), 'BAD_REQUEST');
    await rejects(w.as('buy', (c) => sales.createLead(c, { name: 'Nope' })), 'FORBIDDEN');
    expect(await sales.listLeads(w.pool, w.actors.buy.id)).toBeNull();
  });
  it('needs a reason to lose a lead and does not let anyone mark one won by hand', async () => {
    const l = await w.as('sal', (c) => sales.createLead(c, { name: 'Test Lead', phone: '9000000001' }));
    await rejects(w.as('sal', (c) => sales.setLeadStatus(c, { leadId: l.id, status: 'lost', expectedVersion: l.version })), 'BAD_REQUEST');
    await rejects(w.as('sal', (c) => sales.setLeadStatus(c, { leadId: l.id, status: 'won', expectedVersion: l.version })), 'BAD_REQUEST');
    const u = await w.as('sal', (c) => sales.setLeadStatus(c, { leadId: l.id, status: 'qualified', expectedVersion: l.version }));
    expect(u.status).toBe('qualified');
  });
});

describe('quotations', () => {
  it('caps a salesperson’s discount; the manager can go further', async () => {
    await rejects(w.as('sal', (c) => sales.createQuote(c, { siteId: w.siteId, customerId: urb, lines: [{ itemId: fab(), qty: '10', rate: '300', discPct: '12' }] })), 'FORBIDDEN');
    const q = await w.as('slm', (c) => sales.createQuote(c, { siteId: w.siteId, customerId: urb, lines: [{ itemId: fab(), qty: '10', rate: '300', discPct: '12' }] }));
    expect(q.total).toBe('2640.00');
  });
  it('goes draft → sent → accepted → order, once', async () => {
    const q = await w.as('sal', (c) => sales.createQuote(c, { siteId: w.siteId, customerId: lak, lines: [{ itemId: fab(), qty: '20', rate: '300' }] }));
    await rejects(w.as('sal', (c) => sales.createOrder(c, { siteId: w.siteId, quoteId: q.id })), 'INVALID_STATE');
    const s = await w.as('sal', (c) => sales.sendQuote(c, { quoteId: q.id, expectedVersion: q.version }));
    const a = await w.as('sal', (c) => sales.decideQuote(c, { quoteId: q.id, expectedVersion: s.version, accepted: true }));
    expect(a.status).toBe('accepted');
    const o = await w.as('sal', (c) => sales.createOrder(c, { siteId: w.siteId, quoteId: q.id }));
    expect(o.total).toBe('6000.00');
    await rejects(w.as('sal', (c) => sales.createOrder(c, { siteId: w.siteId, quoteId: q.id })), 'INVALID_STATE');
  });
  it('a lost quotation closes its lead with the reason', async () => {
    const lead = (await w.pool.query(`SELECT id FROM crm_lead WHERE company='Urban Wear Retail'`)).rows[0].id;
    const q = (await w.pool.query(`SELECT id, version FROM quotation WHERE lead_id=$1`, [lead])).rows[0];
    await rejects(w.as('sal', (c) => sales.decideQuote(c, { quoteId: q.id, expectedVersion: q.version, accepted: false })), 'BAD_REQUEST');
    await w.as('sal', (c) => sales.decideQuote(c, { quoteId: q.id, expectedVersion: q.version, accepted: false, reason: 'Wanted 30 days credit' }));
    expect((await w.pool.query('SELECT status, lost_reason FROM crm_lead WHERE id=$1', [lead])).rows[0]).toMatchObject({ status: 'lost', lost_reason: 'Wanted 30 days credit' });
  });
});

describe('sales orders', () => {
  it('needs an independent approver within their value band', async () => {
    const o = await draft('slm', lak, '100', '300');
    const s = await w.as('slm', (c) => sales.submitOrder(c, { orderId: o.id, expectedVersion: o.version }));
    await rejects(w.as('slm', (c) => sales.approveOrder(c, { orderId: o.id, expectedVersion: s.version })), 'FORBIDDEN');
    await rejects(w.as('sal', (c) => sales.approveOrder(c, { orderId: o.id, expectedVersion: s.version })), 'FORBIDDEN');
    const huge = await draft('sal', lak, '4000', '300');          // ₹12,00,000: above the manager's ₹10,00,000 band
    const hs = await w.as('sal', (c) => sales.submitOrder(c, { orderId: huge.id, expectedVersion: huge.version }));
    const e = await rejects(w.as('slm', (c) => sales.approveOrder(c, { orderId: huge.id, expectedVersion: hs.version })), 'FORBIDDEN');
    expect(e.message).toContain('amount');
  });
  it('stops an order that would exceed the customer’s credit limit, and one with no limit at all', async () => {
    const big = await draft('sal', urb, '1000', '300');         // ₹3,00,000 against a ₹2,00,000 limit
    const s = await w.as('sal', (c) => sales.submitOrder(c, { orderId: big.id, expectedVersion: big.version }));
    const e = await rejects(w.as('slm', (c) => sales.approveOrder(c, { orderId: big.id, expectedVersion: s.version })), 'CREDIT_LIMIT');
    expect(e.message).toContain('credit limit');
    const p = await w.as('sal', (c) => import('../src/domain/masters.js').then((m) => m.createPartner(c, { code: 'C-009', name: 'Fresh Customer Co', isCustomer: true })));
    await w.as('sal', (c) => import('../src/domain/masters.js').then((m) => m.submitPartner(c, { partnerId: p.id, expectedVersion: 1 })));
    await w.as('com', (c) => import('../src/domain/masters.js').then((m) => m.approvePartner(c, { partnerId: p.id, expectedVersion: 2 })));
    const o = await draft('sal', p.id, '10', '300');
    const s2 = await w.as('sal', (c) => sales.submitOrder(c, { orderId: o.id, expectedVersion: o.version }));
    await rejects(w.as('slm', (c) => sales.approveOrder(c, { orderId: o.id, expectedVersion: s2.version })), 'NO_CREDIT');
    await rejects(w.as('sal', (c) => sales.setCreditTerms(c, { partnerId: p.id, creditLimit: '100000' })), 'FORBIDDEN');
    await w.as('slm', (c) => sales.setCreditTerms(c, { partnerId: p.id, creditLimit: '100000' }));
    expect((await w.as('slm', (c) => sales.approveOrder(c, { orderId: o.id, expectedVersion: s2.version }))).status).toBe('confirmed');
  });
  it('only sells approved customers and released items', async () => {
    const p = await w.as('sal', (c) => import('../src/domain/masters.js').then((m) => m.createPartner(c, { code: 'C-010', name: 'Draft Customer', isCustomer: true })));
    await rejects(draft('sal', p.id, '5'), 'INVALID_STATE');
    await rejects(draft('buy', urb, '5'), 'FORBIDDEN');
  });

  it('holds stock for an order, never more than is free, then dispatches it out of the ledger', async () => {
    const o = await confirm(lak, '40', '300');                    // within what is left of Lakshmi's limit
    const line = (await w.pool.query('SELECT id FROM so_line WHERE so_id=$1', [o.id])).rows[0].id;
    const free0 = Number((await inv.availability(w.pool, lot)).available);
    await rejects(w.as('sto', (c) => sales.allocate(c, { orderId: o.id, lineId: line, lotId: lot, qty: '41' })), 'OVER_ALLOCATED');
    await rejects(w.as('sto', (c) => sales.allocate(c, { orderId: o.id, lineId: line, lotId: lot, qty: String(free0 + 1000) })), 'OVER_ALLOCATED');
    await w.as('sto', (c) => sales.allocate(c, { orderId: o.id, lineId: line, lotId: lot, qty: '40' }));
    expect(Number((await inv.availability(w.pool, lot)).available)).toBe(free0 - 40);
    const before = Number((await inv.availability(w.pool, lot)).physicalAccepted);
    await rejects(w.as('buy', (c) => sales.dispatch(c, { orderId: o.id, lines: [{ lineId: line, lotId: lot, locationId: lotLoc, qty: '10' }] })), 'FORBIDDEN');
    await rejects(w.as('sto', (c) => sales.dispatch(c, { orderId: o.id, lines: [{ lineId: line, lotId: lot, locationId: lotLoc, qty: '41' }] })), 'OVER_DISPATCH');
    const r1 = await w.as('sto', (c) => sales.dispatch(c, { orderId: o.id, vehicleNo: 'KA-05-1', lines: [{ lineId: line, lotId: lot, locationId: lotLoc, qty: '15' }] }));
    expect(r1.order.status).toBe('part_dispatched');
    const mid = await inv.availability(w.pool, lot);
    expect(Number(mid.physicalAccepted)).toBe(before - 15);
    expect(Number(mid.available)).toBe(free0 - 40);                 // the order's hold shrank by what left; nothing else changed
    const r2 = await w.as('sto', (c) => sales.dispatch(c, { orderId: o.id, lines: [{ lineId: line, lotId: lot, locationId: lotLoc, qty: '25' }] }));
    expect(r2.order.status).toBe('dispatched');
    const end = await inv.availability(w.pool, lot);
    expect(Number(end.reserved)).toBe(Number(mid.reserved) - 25);
    await rejects(w.as('sto', (c) => sales.dispatch(c, { orderId: o.id, lines: [{ lineId: line, lotId: lot, locationId: lotLoc, qty: '1' }] })), 'INVALID_STATE');
    // a dispatch is a fact
    await expect(w.pool.query('UPDATE dispatch SET vehicle_no = $1', ['x'])).rejects.toThrow();
  });

  it('cancelling an order gives the held stock back, but not after goods have left', async () => {
    const o = await confirm(lak, '10', '300');
    const line = (await w.pool.query('SELECT id FROM so_line WHERE so_id=$1', [o.id])).rows[0].id;
    const free0 = Number((await inv.availability(w.pool, lot)).available);
    await w.as('sto', (c) => sales.allocate(c, { orderId: o.id, lineId: line, lotId: lot, qty: '10' }));
    await rejects(w.as('sal', (c) => sales.cancelOrder(c, { orderId: o.id, expectedVersion: o.version, reason: 'changed mind' })), 'FORBIDDEN');
    await w.as('slm', (c) => sales.cancelOrder(c, { orderId: o.id, expectedVersion: o.version, reason: 'Customer changed mind' }));
    expect(Number((await inv.availability(w.pool, lot)).available)).toBe(free0);
    const first = (await w.pool.query(`SELECT id, version FROM sales_order WHERE status='part_dispatched' LIMIT 1`)).rows[0];
    await rejects(w.as('slm', (c) => sales.cancelOrder(c, { orderId: first.id, expectedVersion: first.version, reason: 'too late' })), 'INVALID_STATE');
  });

  it('summarises the sales desk and respects who may see it', async () => {
    const s = await sales.salesSummary(w.pool, w.actors.slm.id);
    expect(s.sales!.booked).toBeGreaterThan(0);
    expect(s.pipeline!.length).toBeGreaterThan(2);
    const b = await sales.salesSummary(w.pool, w.actors.hrm.id);
    expect(b.sales).toBeNull(); expect(b.pipeline).toBeNull();
    expect((await sales.listOrders(w.pool, w.actors.hrm.id)).length).toBe(0);
  });
});
