import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld, rejects } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as cr from '../src/domain/custom-reports.js';
import * as ai from '../src/domain/ai.js';
import { seedOwnerRecent } from '../src/seed/owner-demo.js';
import { seedSalesBase, seedSalesFloor } from '../src/seed/sales-demo.js';

let w: World;
beforeAll(async () => { w = await freshWorld('customrep'); await seedSalesBase(w); await seedOwnerRecent(w); await seedSalesFloor(w); });
afterAll(async () => { await w.pool.end(); });

const run = (who: string, spec: unknown) => cr.runCustom(w.pool, w.actors[who], spec);
const ask = (who: string, q: string, p?: ai.Provider) => ai.interpret(w.pool, w.actors[who].id, q, p);

describe('custom reports: the spec is the only way in', () => {
  it('runs a grouped report and matches the plain data', async () => {
    const r = await run('own', { dataset: 'purchase_orders', group: ['vendor'], measures: [{ field: 'total', agg: 'sum' }, { field: '*', agg: 'count' }], filters: [], sort: { key: 'sum_total', dir: 'desc' } });
    const db = (await w.pool.query(`SELECT sum(total)::float8 s, count(*)::int n FROM purchase_order`)).rows[0];
    expect(r.rows.reduce((s, x) => s + Number(x.sum_total), 0)).toBeCloseTo(db.s, 1);
    expect(r.rows.reduce((s, x) => s + Number(x.count), 0)).toBe(db.n);
  });

  it('refuses unknown datasets, columns, calculations and anything shaped like SQL', async () => {
    await rejects(run('own', { dataset: 'app_user', group: ['username'], measures: [] }), 'BAD_REQUEST');
    await rejects(run('own', { dataset: 'purchase_orders', group: ['vendor; DROP TABLE app_user'], measures: [] }), 'BAD_REQUEST');
    await rejects(run('own', { dataset: 'purchase_orders', group: ['vendor'], measures: [{ field: 'total', agg: 'sum); --' }] }), 'BAD_REQUEST');
    await rejects(run('own', { dataset: 'purchase_orders', group: ['vendor'], measures: [], filters: [{ field: 'bank_account', op: 'eq', value: 'x' }] }), 'BAD_REQUEST');
    await rejects(run('own', { dataset: 'purchase_orders', group: ['vendor'], measures: [], sort: { key: 'pt.name; --', dir: 'asc' } }), 'BAD_REQUEST');
    await rejects(run('own', { dataset: 'purchase_orders', group: [], measures: [] }), 'BAD_REQUEST');
    await rejects(run('own', { dataset: 'purchase_orders', group: ['vendor'], measures: [], limit: 99999 }), 'BAD_REQUEST');
  });

  it('treats a hostile filter value as plain text', async () => {
    const r = await run('own', { dataset: 'purchase_orders', group: ['vendor'], measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'vendor', op: 'contains', value: "x'; DROP TABLE partner; --" }] });
    expect(r.rows.length).toBe(0);
    expect((await w.pool.query('SELECT count(*)::int n FROM partner')).rows[0].n).toBeGreaterThan(0);
  });

  it('checks the dataset permission, so pay data stays with payroll people', async () => {
    await rejects(run('buy', { dataset: 'payslips', group: ['employee'], measures: [{ field: 'net', agg: 'sum' }] }), 'FORBIDDEN');
    await rejects(run('buy', { dataset: 'employees', group: ['name'], measures: [] }), 'FORBIDDEN');
    const ok = await run('own', { dataset: 'payslips', group: ['month'], measures: [{ field: 'net', agg: 'sum' }] });
    expect(ok.sensitive).toBe(true);
    const mine = (await cr.availableDatasets(w.pool, w.actors.buy.id)).map((d) => d.key);
    expect(mine).toContain('purchase_orders');
    expect(mine).not.toContain('payslips');
  });

  it('adds the caller’s site scope to the query itself', () => {
    const { sql, params } = cr.compile(cr.validateSpec({ dataset: 'attendance', group: ['employee'], measures: [{ field: 'late_min', agg: 'sum' }], filters: [{ field: 'date', op: 'gte', value: '2026-01-01' }] }), ['00000000-0000-0000-0000-000000000001']);
    expect(sql).toContain('e.site_id = ANY($1::uuid[])');
    expect(params[0]).toEqual(['00000000-0000-0000-0000-000000000001']);
    expect(params).toContain('2026-01-01');
    expect(sql).not.toContain('2026-01-01');
  });

  it('audits every run with the whole spec and the original question', async () => {
    await cr.runCustom(w.pool, w.actors.own, { dataset: 'employees', group: ['department'], measures: [{ field: '*', agg: 'count' }] }, 'ai', 'staff by department');
    const a = (await w.pool.query(`SELECT after, reason FROM audit_log WHERE action='report.custom' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(a.after.spec.dataset).toBe('employees');
    expect(a.after.via).toBe('ai');
    expect(a.reason).toBe('staff by department');
  });
});

describe('the assistant', () => {
  it('reads common requests with the built-in reader', async () => {
    const a = await ask('own', 'total purchase value by vendor in the last 90 days');
    expect(a.spec.dataset).toBe('purchase_orders');
    expect(a.spec.group).toEqual(['vendor']);
    expect(a.spec.measures).toEqual([{ field: 'total', agg: 'sum' }]);
    expect(a.spec.filters[0]).toMatchObject({ field: 'date', op: 'gte' });
    expect(a.source).toBe('built-in');
    const b = await ask('hrm', 'how many employees by department');
    expect(b.spec).toMatchObject({ dataset: 'employees', group: ['department'], measures: [{ field: '*', agg: 'count' }] });
    const c = await ask('hrm', 'top 3 employees by late minutes this month attendance');
    expect(c.spec).toMatchObject({ dataset: 'attendance', group: ['employee'], limit: 3, sort: { key: 'sum_late_min', dir: 'desc' } });
    const d = await ask('own', 'net salary by department last month');
    expect(d.spec.dataset).toBe('payslips');
    await cr.runCustom(w.pool, w.actors.own, a.spec); await cr.runCustom(w.pool, w.actors.hrm, c.spec);
  });

  it('only offers a person the data they may use', async () => {
    await rejects(ask('buy', 'net salary by department'), 'BAD_REQUEST');      // payroll words, but the buyer has no payroll data
    await rejects(ask('buy', 'zzz qqq something unrelated'), 'BAD_REQUEST');
    await rejects(ask('own', 'hi'), 'BAD_REQUEST');
  });

  it('uses a language model when there is one, but still checks what it returns', async () => {
    const good: ai.Provider = async (sys) => { expect(sys).toContain('purchase_orders'); expect(sys).not.toContain('payslips'); return 'Sure! {"dataset":"purchase_orders","group":["status"],"measures":[{"field":"*","agg":"count"}],"filters":[],"title":"POs by status"}'; };
    const r = await ask('buy', 'orders by status', good);
    expect(r.source).toBe('ai');
    expect(r.spec.title).toBe('POs by status');
    const evil: ai.Provider = async () => '{"dataset":"payslips","group":["employee"],"measures":[{"field":"net","agg":"sum"}]}';
    await rejects(ask('buy', 'orders by status', evil), 'BAD_REQUEST');       // asked for data the buyer cannot see
    await rejects(run('buy', { dataset: 'payslips', group: ['employee'], measures: [{ field: 'net', agg: 'sum' }] }), 'FORBIDDEN');
    const sql: ai.Provider = async () => '{"dataset":"purchase_orders","group":["vendor"],"measures":[{"field":"total","agg":"sum"}],"filters":[{"field":"1=1; DROP TABLE site","op":"eq","value":"x"}]}';
    await rejects(ask('buy', 'orders by vendor', sql), 'BAD_REQUEST');
    const down: ai.Provider = async () => { throw new Error('offline'); };
    const f = await ask('buy', 'total purchase value by vendor', down);
    expect(f.source).toBe('built-in');
    expect(f.note).toContain('could not be reached');
  });
});

describe('saved custom reports', () => {
  it('saves, shares, hides from people who lack the data, and only the owner deletes', async () => {
    const spec = { dataset: 'payslips', group: ['month'], measures: [{ field: 'net', agg: 'sum' }] };
    await rejects(w.as('buy', (c) => cr.saveCustom(c, { name: 'Pay by month', spec })), 'FORBIDDEN');
    const s = await w.as('own', (c) => cr.saveCustom(c, { name: 'Pay by month', spec, shared: true, question: 'net pay by month' }));
    const mine = await w.as('own', (c) => cr.saveCustom(c, { name: 'Private POs', spec: { dataset: 'purchase_orders', group: ['status'], measures: [{ field: '*', agg: 'count' }] } }));
    expect((await cr.listSaved(w.pool, w.actors.hrm.id)).map((x) => x.name)).toContain('Pay by month');     // hr payroll can see the shared one
    expect((await cr.listSaved(w.pool, w.actors.buy.id)).map((x) => x.name)).toEqual([]);                  // no payroll right: hidden, and the private one is not shared
    await rejects(cr.runSaved(w.pool, w.actors.buy, s.id), 'NOT_FOUND');
    await rejects(cr.runSaved(w.pool, w.actors.com, mine.id), 'NOT_FOUND');
    expect((await cr.runSaved(w.pool, w.actors.own, mine.id)).title).toBe('Private POs');
    await rejects(w.as('hrm', (c) => cr.deleteSaved(c, { id: s.id })), 'FORBIDDEN');
    await w.as('own', (c) => cr.deleteSaved(c, { id: s.id }));
    expect((await cr.listSaved(w.pool, w.actors.own.id)).map((x) => x.name)).toEqual(['Private POs']);
  });
});

describe('the built-in reader is forgiving', () => {
  it('copes with typing slips, number words and years', async () => {
    const a = await ask('own', 'need all purchse value in last one yera by vender');
    expect(a.spec).toMatchObject({ dataset: 'purchase_orders', group: ['vendor'], measures: [{ field: 'total', agg: 'sum' }] });
    const days = (Date.now() - Date.parse(a.spec.filters[0].value)) / 86400000;
    expect(days).toBeGreaterThan(364); expect(days).toBeLessThan(367);
    const b = await ask('hrm', 'how many employes by departmnt');
    expect(b.spec).toMatchObject({ dataset: 'employees', group: ['department'] });
  });
  it('says plainly when the data is not in the system', async () => {
    const e = await ask('own', 'show me all invoices outstanding payments').catch((x) => x);
    expect(e.message).toContain('not in the system yet');
    expect(e.message).toContain('purchase orders');
    const f = await ask('buy', 'need all sale in last one year').catch((x) => x);       // a buyer has no sales rights
    expect(f.message).toContain('do not have a role');
    const g = await ask('slm', 'need all sale in last one yera');
    expect(g.spec.dataset).toBe('sales_orders');
    const run2 = await cr.runCustom(w.pool, w.actors.slm, g.spec);
    expect(run2.rows.length).toBeGreaterThanOrEqual(0);
  });
});
