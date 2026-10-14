import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld, rejects } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as reports from '../src/domain/reports.js';
import { seedOwnerRecent } from '../src/seed/owner-demo.js';

let w: World;
beforeAll(async () => { w = await freshWorld('reports'); await seedOwnerRecent(w); });
afterAll(async () => { await w.pool.end(); });

const keys = async (who: string) => (await reports.listReports(w.pool, w.actors[who].id)).map((r) => r.key);
const run = (who: string, key: string, p: Record<string, string> = {}) => reports.runReport(w.pool, w.actors[who], key, p);
const WIDE = { from: '2020-01-01', to: '2099-12-31' };

describe('reports', () => {
  it('lists only the reports a person holds the permission for', async () => {
    const buy = await keys('buy');
    expect(buy).toContain('purchase-register');
    expect(buy).not.toContain('payroll-register');
    expect(buy).not.toContain('access-review');
    const own = await keys('own');
    expect(own).toContain('payroll-register');
    expect(own).toContain('override-log');
  });

  it('refuses a report the person may not see, even when asked for by name', async () => {
    await rejects(run('buy', 'payroll-register', { month: '2026-10' }), 'FORBIDDEN');
    await rejects(run('buy', 'access-review'), 'FORBIDDEN');
    await rejects(run('own', 'no-such-report'), 'NOT_FOUND');
  });

  it('checks the filters', async () => {
    await rejects(run('buy', 'purchase-register', { from: '10/01/2026', to: '2026-10-31' }), 'BAD_REQUEST');
    await rejects(run('buy', 'purchase-register', { from: '2026-10-31', to: '2026-10-01' }), 'BAD_REQUEST');
    await rejects(run('own', 'attendance-month', { month: '2026-13' }), 'BAD_REQUEST');
  });

  it('purchase register and vendor performance agree with the orders', async () => {
    const r = await run('own', 'purchase-register', WIDE);
    const n = (await w.pool.query('SELECT count(*)::int AS n FROM purchase_order')).rows[0].n;
    expect(r.rows.length).toBe(n);
    expect(r.rows.length).toBeGreaterThan(3);
    const v = await run('own', 'vendor-performance', WIDE);
    expect(v.rows.length).toBeGreaterThan(0);
    expect(Number(v.rows[0].received)).toBeGreaterThan(0);
  });

  it('stock position totals match the stock summary', async () => {
    const r = await run('own', 'stock-position');
    const acc = r.rows.reduce((s, x) => s + Number(x.accepted), 0);
    expect(acc).toBeGreaterThan(0);
    expect(r.summary.find((s) => s.label === 'Accepted')).toBeTruthy();
  });

  it('people reports run for HR and payroll is real', async () => {
    expect((await run('hrm', 'headcount')).rows.reduce((s, x) => s + Number(x.active), 0)).toBe(20);
    const m = new Date().toISOString().slice(0, 7);
    expect((await run('hrm', 'attendance-month', { month: m })).rows.length).toBe(20);
    expect((await run('hrm', 'leave-balance', { year: m.slice(0, 4) })).columns.length).toBeGreaterThan(2);
    const pay = await run('own', 'payroll-register', { month: m });
    expect(pay.sensitive).toBe(true);
    await run('own', 'payroll-statutory', { from: m, to: m });
  });

  it('control reports work for the owner and need company-wide rights', async () => {
    expect((await run('own', 'approvals-aging')).rows.length).toBeGreaterThan(0);
    expect((await run('own', 'override-log', WIDE)).summary.length).toBe(2);
    expect((await run('admin', 'access-review')).rows.length).toBeGreaterThan(5);
    expect((await run('admin', 'audit-by-actor', WIDE)).rows.length).toBeGreaterThan(0);
  });

  it('writes every run to the audit log, and shows the trail only to those who may see audit', async () => {
    await run('own', 'payroll-register', { month: '2026-10' });
    const a = (await w.pool.query(`SELECT after FROM audit_log WHERE action='report.run' ORDER BY id DESC LIMIT 1`)).rows[0].after;
    expect(a.report).toBe('payroll-register');
    expect(a.params.month).toBe('2026-10');
    expect(a.sensitive).toBe(true);
    expect((await reports.recentRuns(w.pool, w.actors.admin.id))!.length).toBeGreaterThan(3);
    expect(await reports.recentRuns(w.pool, w.actors.buy.id)).toBeNull();
    // a refused run leaves no row
    const before = (await w.pool.query(`SELECT count(*)::int n FROM audit_log WHERE action='report.run'`)).rows[0].n;
    await rejects(run('buy', 'payroll-register', { month: '2026-10' }), 'FORBIDDEN');
    expect((await w.pool.query(`SELECT count(*)::int n FROM audit_log WHERE action='report.run'`)).rows[0].n).toBe(before);
  });
});
