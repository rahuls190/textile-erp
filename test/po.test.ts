import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { freshWorld, rejects } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as po from '../src/domain/po.js';
import * as rcv from '../src/domain/receipt.js';
import { runCommand } from '../src/core/command.js';

let w: World;
beforeAll(async () => { w = await freshWorld('po'); });
afterAll(async () => { await w.pool.end(); });

const draft = (qty = '500', rate?: string) => w.as('buy', (c) => po.createPO(c, {
  siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty, rate, dueDate: '2026-11-30' }] }));

describe('P02 purchase order lifecycle', () => {
  it('uses the approved vendor rate as a snapshot and computes the total exactly', async () => {
    const p = await draft('500');           // 500 m × ₹250 (approved rate)
    expect(p.total).toBe('125000.00');
    const lines = (await w.pool.query('SELECT rate FROM po_line WHERE po_id=$1', [p.id])).rows;
    expect(lines[0].rate).toBe('250.0000');
  });

  it('exact decimal arithmetic: 0.1 × 3 style amounts never drift', async () => {
    const p = await draft('333.3333', '0.3000');
    expect(p.total).toBe('100.00');   // 333.3333 × 0.30 = 99.99999 → 100.00
  });

  it('draft → submit → approve → release, with each step needing its own right', async () => {
    const p = await draft();
    await rejects(w.as('com', (c) => po.approvePO(c, { poId: p.id, expectedVersion: p.version })), 'INVALID_STATE');   // not submitted yet
    const s = await w.as('buy', (c) => po.submitPO(c, { poId: p.id, expectedVersion: p.version }));
    expect(s.status).toBe('approval_pending');
    await rejects(w.as('buy', (c) => po.approvePO(c, { poId: p.id, expectedVersion: s.version })), 'FORBIDDEN', 403);   // buyer cannot approve
    await rejects(w.as('com', (c) => po.releasePO(c, { poId: p.id, expectedVersion: s.version })), 'INVALID_STATE');   // approval comes first
    const a = await w.as('com', (c) => po.approvePO(c, { poId: p.id, expectedVersion: s.version }));
    expect(a.status).toBe('approved');
    const r = await w.as('com', (c) => po.releasePO(c, { poId: p.id, expectedVersion: a.version }));
    expect(r.status).toBe('released');
    expect(r.released_by).toBe(w.actors.com.id);
  });

  it('separation of duties: a PO creator cannot approve their own PO, even with the right', async () => {
    const both = await w.addUser('buy-com', 'BUY', { maxAmount: '9999999' });
    await w.as('admin', (c) => import('../src/domain/admin.js').then((m) => m.assignRole(c, { userId: both.id, roleKey: 'COM', siteId: w.siteId, maxAmount: '9999999' })));
    const p = await w.as('buy-com', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '10' }] }));
    const s = await w.as('buy-com', (c) => po.submitPO(c, { poId: p.id, expectedVersion: 1 }));
    await rejects(w.as('buy-com', (c) => po.approvePO(c, { poId: p.id, expectedVersion: s.version })), 'FORBIDDEN', 403);
  });

  it('approval band: an approver cannot approve above their limit', async () => {
    const big = await w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '5000' }] })); // ₹12.5 lakh
    const s = await w.as('buy', (c) => po.submitPO(c, { poId: big.id, expectedVersion: 1 }));
    await rejects(w.as('com', (c) => po.approvePO(c, { poId: big.id, expectedVersion: s.version })), 'FORBIDDEN', 403);
  });

  it('draft edits only by the creator and only while draft; stale versions are refused', async () => {
    const p = await draft();
    await rejects(w.as('buy', (c) => po.updateDraftPO(c, { poId: p.id, expectedVersion: 7, lines: [{ itemId: w.items.fabric, qty: '1' }] })), 'STALE_VERSION');
    const u = await w.as('buy', (c) => po.updateDraftPO(c, { poId: p.id, expectedVersion: p.version, lines: [{ itemId: w.items.fabric, qty: '200' }] }));
    expect(u.total).toBe('50000.00');
    const s = await w.as('buy', (c) => po.submitPO(c, { poId: p.id, expectedVersion: u.version }));
    await rejects(w.as('buy', (c) => po.updateDraftPO(c, { poId: p.id, expectedVersion: s.version, lines: [{ itemId: w.items.fabric, qty: '1' }] })), 'INVALID_STATE');
  });

  it('a vendor with no approved rate blocks the PO instead of guessing', async () => {
    await rejects(w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.trim, qty: '10' }] })), 'INVALID_STATE');
  });

  it('a retried create (same request_id) returns the same PO and creates no duplicate', async () => {
    const key = randomUUID();
    const run = () => runCommand(w.pool, { requestId: key, actor: w.actors.buy, action: 'po.create' },
      (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '12' }] }));
    const a = await run(), b = await run();
    expect(b.replayed).toBe(true); expect(b.result.number).toBe(a.result.number);
    expect((await w.pool.query('SELECT count(*)::int n FROM purchase_order WHERE number=$1', [a.result.number])).rows[0].n).toBe(1);
  });

  it('document numbers are unique and sequential per site and type', async () => {
    const a = await draft('1'), b = await draft('1');
    const n = (s: string) => Number(s.split('-').pop());
    expect(n(b.number)).toBe(n(a.number) + 1);
    expect(a.number).toMatch(/^PO-KLY-\d{5}$/);
  });
});

describe('P02 amendments, receipts and closure', () => {
  async function releasedPO(qty = '500') {
    const p = await draft(qty);
    const s = await w.as('buy', (c) => po.submitPO(c, { poId: p.id, expectedVersion: p.version }));
    const a = await w.as('com', (c) => po.approvePO(c, { poId: p.id, expectedVersion: s.version }));
    return w.as('com', (c) => po.releasePO(c, { poId: p.id, expectedVersion: a.version }));
  }
  const receive = (p: { id: string }, qty: string, challan: string) => w.pool.query('SELECT id FROM po_line WHERE po_id=$1', [p.id])
    .then((r) => w.as('sto', (c) => rcv.postReceipt(c, { siteId: w.siteId, partnerId: w.vendorId, poId: p.id, challanNo: challan,
      lines: [{ poLineId: r.rows[0].id, itemId: w.items.fabric, qty }] })));

  it('a released PO cannot be edited directly; an amendment needs an independent approval and keeps prior versions', async () => {
    const p = await releasedPO();
    const line = (await w.pool.query('SELECT id FROM po_line WHERE po_id=$1', [p.id])).rows[0];
    const am = await w.as('buy', (c) => po.amendPO(c, { poId: p.id, expectedVersion: p.version, reason: 'Vendor price revision', changes: [{ lineId: line.id, rate: '260.0000' }] }));
    // nothing changes until approved
    expect((await w.pool.query('SELECT rate FROM po_line WHERE id=$1', [line.id])).rows[0].rate).toBe('250.0000');
    await rejects(w.as('buy', (c) => po.amendPO(c, { poId: p.id, expectedVersion: am.version, reason: 'again', changes: [] })), 'AMENDMENT_PENDING', 409);
    await rejects(w.as('buy', (c) => po.approvePO(c, { poId: p.id, expectedVersion: am.version })), 'FORBIDDEN');
    const done = await w.as('com', (c) => po.approvePO(c, { poId: p.id, expectedVersion: am.version }));
    expect(done.total).toBe('130000.00'); expect(done.revision).toBe(1);
    const versions = (await w.pool.query('SELECT version, reason FROM po_version WHERE po_id=$1 ORDER BY version', [p.id])).rows;
    expect(versions.length).toBeGreaterThanOrEqual(5);
    expect(versions.some((v) => String(v.reason).startsWith('amendment approved'))).toBe(true);
  });

  it('an amendment cannot reduce quantity below what has already been received', async () => {
    const p = await releasedPO('500');
    await receive(p, '300', 'CH-AM-1');
    const line = (await w.pool.query('SELECT id FROM po_line WHERE po_id=$1', [p.id])).rows[0];
    const cur = (await w.pool.query('SELECT version FROM purchase_order WHERE id=$1', [p.id])).rows[0].version;
    await rejects(w.as('buy', (c) => po.amendPO(c, { poId: p.id, expectedVersion: cur, reason: 'cut', changes: [{ lineId: line.id, qty: '200' }] })), 'BELOW_RECEIVED', 409);
  });

  it('receipt drives the PO status; the received quantity is never typed in', async () => {
    const p = await releasedPO('100');
    await receive(p, '60', 'CH-ST-1');
    expect((await w.pool.query('SELECT status FROM purchase_order WHERE id=$1', [p.id])).rows[0].status).toBe('partial_receipt');
    await receive(p, '40', 'CH-ST-2');
    expect((await w.pool.query('SELECT status FROM purchase_order WHERE id=$1', [p.id])).rows[0].status).toBe('completed');
  });

  it('cancelling an unreceived PO cancels it; with receipts it short-closes; unresolved QC blocks closing', async () => {
    const a = await releasedPO('50');
    const c1 = await w.as('com', (c) => po.cancelPO(c, { poId: a.id, expectedVersion: a.version, reason: 'no longer needed' }));
    expect(c1.status).toBe('cancelled');

    const b = await releasedPO('50');
    await receive(b, '20', 'CH-SC-1');
    const ver = (await w.pool.query('SELECT version FROM purchase_order WHERE id=$1', [b.id])).rows[0].version;
    await rejects(w.as('com', (c) => po.cancelPO(c, { poId: b.id, expectedVersion: ver, reason: 'short close' })), 'INVALID_STATE'); // QC still pending
  });
});
