import type { World } from './demo.js';
import * as masters from '../domain/masters.js';
import * as sales from '../domain/sales.js';
import * as inv from '../domain/inventory.js';

const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/** Sales people, approved customers with credit limits, and a handful of leads. Cheap: runs for every demo database. */
export async function seedSalesBase(w: World) {
  await w.addUser('sal', 'SAL', { displayName: 'Priya Menon' });
  await w.addUser('slm', 'SLM', { displayName: 'Rohit Verma', maxAmount: '1000000' });
  const cust = async (code: string, name: string, gstin: string, limit: string) => {
    const p = await w.as('sal', (c) => masters.createPartner(c, { code, name, isCustomer: true, gstin }));
    await w.as('sal', (c) => masters.submitPartner(c, { partnerId: p.id, expectedVersion: 1 }));
    await w.as('com', (c) => masters.approvePartner(c, { partnerId: p.id, expectedVersion: 2 }));
    await w.as('slm', (c) => sales.setCreditTerms(c, { partnerId: p.id, creditLimit: limit, paymentDays: 45 }));
    return p.id as string;
  };
  const lak = await cust('C-001', 'Lakshmi Garments', '29AAACL1234A1Z5', '500000');
  const urb = await cust('C-002', 'Urban Wear Retail', '27AAACU5678B1Z2', '200000');
  const l1 = await w.as('sal', (c) => sales.createLead(c, { name: 'Rekha Shetty', company: 'Rekha Textiles', phone: '9845012345', source: 'Referral', interest: 'Cotton lycra jersey, 2000 m a month', estValue: '450000', nextFollowUp: day(-1) }));
  await w.as('sal', (c) => sales.addActivity(c, { leadId: l1.id, kind: 'call', summary: 'Sent sample card; wants price for 2000 m', dueDate: day(-1) }));
  await w.as('sal', (c) => sales.createLead(c, { name: 'Anil Kumar', company: 'Metro Innerwear', phone: '9900112233', source: 'Trade fair', interest: 'Elastic and jersey', estValue: '120000' }));
  const l3 = await w.as('sal', (c) => sales.createLead(c, { name: 'Sheela Rao', company: 'Shree Knits', phone: '9741098765', source: 'Website', estValue: '80000', nextFollowUp: day(2) }));
  await w.as('sal', (c) => sales.addActivity(c, { leadId: l3.id, kind: 'meeting', summary: 'Visit scheduled at her unit', dueDate: day(2) }));
  const l4 = await w.as('sal', (c) => sales.createLead(c, { name: 'Dev Patel', company: 'Patel Hosiery', phone: '9822000111', estValue: '60000' }));
  await w.as('sal', async (c) => sales.setLeadStatus(c, { leadId: l4.id, status: 'lost', reason: 'Went with a cheaper local mill', expectedVersion: (await c.db.query('SELECT version FROM crm_lead WHERE id=$1', [l4.id])).rows[0].version }));
  const l5 = await w.as('sal', (c) => sales.createLead(c, { name: 'Imran Sheikh', company: 'Urban Wear Retail', phone: '9811122233', source: 'Referral', estValue: '51000' }));
  (w as unknown as { _sales?: { lak: string; urb: string; lead: string } })._sales = { lak, urb, lead: l5.id };
}

/** Orders in every state, on top of the stock the owner demo creates. */
export async function seedSalesFloor(w: World) {
  const s = (w as unknown as { _sales?: { lak: string; urb: string; lead: string } })._sales
    ?? await (async () => {
      const r = (await w.pool.query(`SELECT code, id FROM partner WHERE code IN ('C-001','C-002')`)).rows;
      return { lak: r.find((x) => x.code === 'C-001').id, urb: r.find((x) => x.code === 'C-002').id, lead: (await w.pool.query(`SELECT id FROM crm_lead WHERE company='Urban Wear Retail'`)).rows[0].id };
    })();
  const fab = w.items.fabric;
  // an order that is confirmed, stock held, and part of it already gone
  const o1 = await w.as('sal', (c) => sales.createOrder(c, { siteId: w.siteId, customerId: s.lak, dueDate: day(10), lines: [{ itemId: fab, qty: '300', rate: '320', discPct: '5' }] }));
  const o1s = await w.as('sal', (c) => sales.submitOrder(c, { orderId: o1.id, expectedVersion: o1.version }));
  await w.as('slm', (c) => sales.approveOrder(c, { orderId: o1.id, expectedVersion: o1s.version }));
  const line = (await w.pool.query('SELECT id FROM so_line WHERE so_id=$1', [o1.id])).rows[0];
  const lot = (await w.pool.query(`SELECT l.id FROM lot l WHERE l.item_id=$1 ORDER BY (SELECT COALESCE(sum(qty),0) FROM stock_ledger WHERE lot_id=l.id AND status='ACCEPTED') DESC LIMIT 1`, [fab])).rows[0];
  const avail = await inv.availability(w.pool, lot.id);
  const where = (await w.pool.query(`SELECT sl.location_id FROM stock_ledger sl JOIN location loc ON loc.id=sl.location_id WHERE sl.lot_id=$1 AND sl.status='ACCEPTED' AND loc.kind IN ('RECEIVING','STORE','RACK') GROUP BY sl.location_id HAVING sum(sl.qty) > 0 LIMIT 1`, [lot.id])).rows[0];
  const take = Number(avail.available) >= 200 ? '200' : avail.available;
  await w.as('sto', (c) => sales.allocate(c, { orderId: o1.id, lineId: line.id, lotId: lot.id, qty: '250' }).catch(() => sales.allocate(c, { orderId: o1.id, lineId: line.id, lotId: lot.id, qty: take })));
  await w.as('sto', (c) => sales.dispatch(c, { orderId: o1.id, vehicleNo: 'KA-01-AB-4821', lrNo: 'LR-7731', lines: [{ lineId: line.id, lotId: lot.id, locationId: where.location_id, qty: take }] }));
  // a quotation sent to a new customer's lead, and an order waiting for the manager
  const q = await w.as('sal', (c) => sales.createQuote(c, { siteId: w.siteId, customerId: s.urb, leadId: s.lead, lines: [{ itemId: fab, qty: '150', rate: '340', discPct: '3' }], notes: 'Delivery within 10 days' }));
  await w.as('sal', (c) => sales.sendQuote(c, { quoteId: q.id, expectedVersion: q.version }));
  const o2 = await w.as('sal', (c) => sales.createOrder(c, { siteId: w.siteId, customerId: s.urb, dueDate: day(14), lines: [{ itemId: fab, qty: '100', rate: '330' }] }));
  await w.as('sal', (c) => sales.submitOrder(c, { orderId: o2.id, expectedVersion: o2.version }));
}
