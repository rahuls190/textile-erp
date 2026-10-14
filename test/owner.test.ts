import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld, rejects } from './helpers.js';
import { buildWorld, type World } from '../src/seed/demo.js';
import { createPool } from '../src/db/pool.js';
import * as owner from '../src/domain/owner.js';
import * as po from '../src/domain/po.js';
import * as hr from '../src/domain/hr.js';
import * as inv from '../src/domain/inventory.js';
import { seedOwnerRecent } from '../src/seed/owner-demo.js';

let w: World;
beforeAll(async () => {
  w = await freshWorld('owner');
  await seedOwnerRecent(w);
});
afterAll(async () => { await w.pool.end(); });

const pending = (who: string) => owner.pendingItems(w.pool, w.actors[who].id);

describe('the owner desk', () => {
  it('shows the whole business to the owner and refuses it to everyone else', async () => {
    const d = await owner.ownerDashboard(w.pool, w.actors.own.id);
    expect(d).toBeTruthy();
    expect(d!.stock.accepted).toBeGreaterThan(0);
    expect(d!.approvals.length).toBeGreaterThanOrEqual(5);
    expect(d!.people.employees).toBe(20);
    expect(await owner.ownerDashboard(w.pool, w.actors.com.id)).toBeNull();
    expect(await owner.ownerDashboard(w.pool, w.actors.buy.id)).toBeNull();
  });

  it('shows each person only the pending items they are allowed to see', async () => {
    const titles = (await pending('buy')).map((x) => x.type);
    expect(titles).toContain('purchase_order');
    expect(titles).not.toContain('salary_structure');     // a buyer never sees pay
    expect(titles).not.toContain('payroll_run');
    expect((await pending('own')).map((x) => x.type)).toContain('salary_structure');
  });
});

describe('escalation ladder', () => {
  it('the seeded urgent request starts at the approver and cannot be raised twice', async () => {
    const esc = (await pending('own')).find((x) => x.escalation);
    expect(esc?.escalation?.level).toBe(1);
    await rejects(w.as('buy', (c) => owner.raiseEscalation(c, { entityType: esc!.type, entityId: esc!.id, urgency: 'urgent', reason: 'still waiting please' })), 'INVALID_STATE');
  });

  it('needs a real reason, and only things the person can see', async () => {
    const slow = (await pending('own')).find((x) => x.overdue && !x.escalation)!;
    await rejects(w.as('buy', (c) => owner.raiseEscalation(c, { entityType: slow.type, entityId: slow.id, urgency: 'urgent', reason: 'now' })), 'BAD_REQUEST');
    const sal = (await pending('own')).find((x) => x.type === 'salary_structure')!;
    await rejects(w.as('buy', (c) => owner.raiseEscalation(c, { entityType: 'salary_structure', entityId: sal.id, urgency: 'urgent', reason: 'please approve this quickly' })), 'NOT_FOUND');
  });

  it('only the raiser or senior staff can push it up, and a manual push stops at the owner', async () => {
    const leave = (await pending('own')).find((x) => x.type === 'leave_request')!;
    const e = await w.as('sup', (c) => owner.raiseEscalation(c, { entityType: 'leave_request', entityId: leave.id, urgency: 'urgent', reason: 'Order shipping tomorrow, need cover' }));
    await rejects(w.as('sto', (c) => owner.escalateUp(c, { escalationId: e.id })), 'FORBIDDEN');
    const up = await w.as('sup', (c) => owner.escalateUp(c, { escalationId: e.id }));
    expect(up.level).toBe(2);
    await w.as('md', (c) => owner.escalateUp(c, { escalationId: e.id }));            // senior management can push too
    await rejects(w.as('sup', (c) => owner.escalateUp(c, { escalationId: e.id })), 'INVALID_STATE');   // already with the owner
  });

  it('moves up by itself when nobody acts, and straight to the owner when critical', async () => {
    const soon = new Date(Date.now() + 5 * 3600000).toISOString();     // 5 hours later: level 1 has waited its 4 hours
    const r1 = await w.as('own', (c) => owner.sweepEscalations(c, { asOf: soon }));
    expect(r1.movedUp).toBeGreaterThanOrEqual(1);
    const later = new Date(Date.now() + 10 * 3600000).toISOString();
    await w.as('own', (c) => owner.sweepEscalations(c, { asOf: later }));
    const esc = (await owner.listEscalations(w.pool, w.actors.own.id)).find((e) => e.reason.includes('Sunrise'))!;
    expect(esc.level).toBe(3);

    const adj = (await pending('own')).find((x) => x.type === 'stock_adjustment')!;
    const crit = await w.as('inv', (c) => owner.raiseEscalation(c, { entityType: 'stock_adjustment', entityId: adj.id, urgency: 'critical', reason: 'Cutting line is stopped without this' }));
    expect(crit.level).toBe(3);
  });

  it('raises overdue items on its own, and resolves escalations once the item is decided', async () => {
    const week = new Date(Date.now() + 3 * 86400000).toISOString();
    const r = await w.as('own', (c) => owner.sweepEscalations(c, { asOf: week }));
    expect(r.raised).toBeGreaterThanOrEqual(1);
    const auto = (await owner.listEscalations(w.pool, w.actors.own.id)).filter((e) => e.auto);
    expect(auto.length).toBeGreaterThanOrEqual(1);
    await rejects(w.as('buy', (c) => owner.sweepEscalations(c, {})), 'FORBIDDEN');
    await rejects(w.as('own', (c) => owner.sweepEscalations(c, { asOf: new Date(Date.now() + 400 * 86400000).toISOString() })), 'BAD_REQUEST');
  });
});

describe('owner override', () => {
  it('lets the owner approve what no one else can: above the approver limit', async () => {
    const big = (await pending('own')).find((x) => x.type === 'purchase_order' && Number(x.amount) > 500000)!;
    expect(big).toBeTruthy();
    // the commercial approver is refused: it is over their limit
    const v = (await w.pool.query('SELECT version FROM purchase_order WHERE id=$1', [big.id])).rows[0].version;
    await rejects(w.as('com', (c) => po.approvePO(c, { poId: big.id, expectedVersion: v })), 'FORBIDDEN');
    await rejects(w.as('own', (c) => owner.ownerOverride(c, { entityType: 'purchase_order', entityId: big.id, decision: 'approve', reason: 'short' })), 'BAD_REQUEST');
    await rejects(w.as('com', (c) => owner.ownerOverride(c, { entityType: 'purchase_order', entityId: big.id, decision: 'approve', reason: 'I would like to approve this myself' })), 'FORBIDDEN');
    await w.as('own', (c) => owner.ownerOverride(c, { entityType: 'purchase_order', entityId: big.id, decision: 'approve', reason: 'Price valid only until noon tomorrow; I accept the commercial risk' }));
    const row = (await w.pool.query('SELECT status, approved_by FROM purchase_order WHERE id=$1', [big.id])).rows[0];
    expect(row.status).toBe('approved');
    expect(row.approved_by).toBe(w.actors.own.id);                                      // the record says the owner decided
  });

  it('logs every override for good and resolves the escalation', async () => {
    const log = (await owner.listOverrides(w.pool, w.actors.own.id))!;
    expect(log[0]).toMatchObject({ decision: 'approve', decided_by: 'own', entity_type: 'purchase_order' });
    expect(log[0].reason).toContain('commercial risk');
    await expect(w.pool.query(`UPDATE override_log SET reason='x'`)).rejects.toThrow();
    await expect(w.pool.query(`DELETE FROM override_log`)).rejects.toThrow();
    const open = (await owner.listEscalations(w.pool, w.actors.own.id)).find((e) => e.reason.includes('Sunrise'));
    expect(open).toBeUndefined();                                                      // resolved by the override
    const audit = (await w.pool.query(`SELECT 1 FROM audit_log WHERE action='owner.override'`)).rowCount;
    expect(audit).toBeGreaterThanOrEqual(1);
  });

  it('works for rejections, salary (own-proposal rules waived), leave and adjustments', async () => {
    const sal = (await pending('own')).find((x) => x.type === 'salary_structure')!;
    await w.as('own', (c) => owner.ownerOverride(c, { entityType: 'salary_structure', entityId: sal.id, decision: 'approve', reason: 'Agreed with the employee at review meeting' }));
    expect((await w.pool.query('SELECT status FROM salary_structure WHERE id=$1', [sal.id])).rows[0].status).toBe('approved');
    const adj = (await pending('own')).find((x) => x.type === 'stock_adjustment')!;
    await w.as('own', (c) => owner.ownerOverride(c, { entityType: 'stock_adjustment', entityId: adj.id, decision: 'reject', reason: 'Recount first, variance looks too large' }));
    expect((await w.pool.query('SELECT status FROM stock_adjustment WHERE id=$1', [adj.id])).rows[0].status).toBe('rejected');
    const leave = (await pending('own')).find((x) => x.type === 'leave_request')!;
    await w.as('own', (c) => owner.ownerOverride(c, { entityType: 'leave_request', entityId: leave.id, decision: 'reject', reason: 'Export order ships that week, cannot spare' }));
    expect((await w.pool.query('SELECT status FROM leave_request WHERE id=$1', [leave.id])).rows[0].status).toBe('rejected');
    const slow = (await pending('own')).find((x) => x.type === 'purchase_order')!;
    await w.as('own', (c) => owner.ownerOverride(c, { entityType: 'purchase_order', entityId: slow.id, decision: 'reject', reason: 'Vendor quote is stale, ask for a new one' }));
    expect((await w.pool.query('SELECT status FROM purchase_order WHERE id=$1', [slow.id])).rows[0].status).toBe('draft');
    await rejects(w.as('own', (c) => owner.ownerOverride(c, { entityType: 'purchase_order', entityId: slow.id, decision: 'approve', reason: 'Trying again after the return' })), 'NOT_FOUND');   // no longer pending
  });

  it('the normal rules still hold for the owner everywhere else', async () => {
    await rejects(w.as('own', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '10' }] })), 'FORBIDDEN');
    await rejects(w.as('own', (c) => hr.createPayrollRun(c, { siteId: w.siteId, period: '2026-09' })), 'FORBIDDEN');
    void inv; void buildWorld; void createPool;
  });
});
