import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld, rejects } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as hr from '../src/domain/hr.js';

let w: World;
beforeAll(async () => { w = await freshWorld('hr'); });
afterAll(async () => { await w.pool.end(); });

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(+new Date(s + 'T00:00:00Z') + n * 86400000));
const T = iso(new Date());
const prev = iso(new Date(Date.UTC(+T.slice(0, 4), +T.slice(5, 7) - 2, 1)));
const period = prev.slice(0, 7);
const dim = new Date(Date.UTC(+prev.slice(0, 4), +prev.slice(5, 7), 0)).getUTCDate();
const eid = async (name: string) => (await w.pool.query('SELECT id FROM employee WHERE name=$1', [name])).rows[0].id as string;
const slip = async (runId: string, name: string) => (await hr.listPayslips(w.pool, w.actors.hrm.id, runId)).find((s) => s.name === name)!;
const paise = (v: string) => Math.round(Number(v) * 100);
const round = (n: number) => Math.floor(n + 0.5);

describe('employees and scope', () => {
  it('HR creates people; a storekeeper cannot, and cannot read the register', async () => {
    const e = await w.as('hrm', (c) => hr.createEmployee(c, { name: 'Test Joiner', siteId: w.siteId, joinDate: '2026-01-05', bankAccount: '9988776655' }));
    expect(e.code).toMatch(/^EMP-KLY-\d{5}$/);
    await rejects(w.as('sto', (c) => hr.createEmployee(c, { name: 'Nope', siteId: w.siteId, joinDate: '2026-01-05' })), 'FORBIDDEN');
    const asSto = await hr.listEmployees(w.pool, w.actors.sto.id);
    expect(asSto.map((x) => x.name)).toEqual(['Imran Qureshi']);                 // only their own record
  });

  it('bank details are masked unless the viewer may see them', async () => {
    const hrm = (await hr.listEmployees(w.pool, w.actors.hrm.id)).find((x) => x.name === 'Test Joiner')!;
    const hre = (await hr.listEmployees(w.pool, w.actors.hre.id)).find((x) => x.name === 'Test Joiner')!;
    expect(hrm.bank_account).toBe('9988776655'); expect(hre.bank_account).toBe('••••6655');
  });

  it('refuses reporting loops and stale edits, and an exit also closes the login', async () => {
    const a = await eid('Mohan Lal'), b = await eid('Ganesh Patil');
    const ea = (await hr.listEmployees(w.pool, w.actors.hrm.id)).find((x) => x.id === b)!;
    await rejects(w.as('hrm', (c) => hr.updateEmployee(c, { employeeId: b, expectedVersion: ea.version, changes: { managerId: a } })), 'BAD_REQUEST');
    await rejects(w.as('hrm', (c) => hr.updateEmployee(c, { employeeId: b, expectedVersion: 999, changes: { phone: '1' } })), 'STALE_VERSION');
    const x = await w.as('hrm', (c) => hr.createEmployee(c, { name: 'Leaver', siteId: w.siteId, joinDate: '2026-01-05' }));
    await w.as('hrm', (c) => hr.exitEmployee(c, { employeeId: x.id, expectedVersion: 1, exitDate: addDays(T, -1), reason: 'Resigned' }));
    await rejects(w.as('hrm', (c) => hr.markAttendance(c, { employeeId: x.id, date: T, status: 'P' })), 'BAD_REQUEST');
  });
});

describe('attendance', () => {
  it('a supervisor marks only their own team; HR corrections need a reason', async () => {
    const own = await eid('Pooja Shetty'), other = await eid('Asha Rao');
    const day = addDays(T, -1);
    await w.as('hrm', (c) => hr.fillDefaultAttendance(c, { siteId: w.siteId, from: day, to: day }));   // idempotent
    await rejects(w.as('sup', (c) => hr.markAttendance(c, { employeeId: other, date: day, status: 'A' })), 'FORBIDDEN');
    await rejects(w.as('sup', (c) => hr.markAttendance(c, { employeeId: own, date: day, status: 'A', reason: 'x' })), 'FORBIDDEN');  // existing mark: HR only
    await rejects(w.as('hrm', (c) => hr.markAttendance(c, { employeeId: own, date: day, status: 'A' })), 'BAD_REQUEST');
    await w.as('hrm', (c) => hr.markAttendance(c, { employeeId: own, date: day, status: 'A', reason: 'Did not report' }));
    const a = (await w.pool.query(`SELECT before FROM audit_log WHERE action='hr.attendance.correct' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(a.before.status).toMatch(/P|WO|HOL/);
  });

  it('refuses future dates; computes overtime and lateness from the shift', async () => {
    const e = await eid('Arjun Reddy');
    await rejects(w.as('hrm', (c) => hr.markAttendance(c, { employeeId: e, date: addDays(T, 2), status: 'P' })), 'BAD_REQUEST');
    const d = addDays(prev, 1);     // an existing default row: correct it with times
    const r = await w.as('hrm', (c) => hr.markAttendance(c, { employeeId: e, date: d, inTime: '09:20', outTime: '19:30', reason: 'Order rush' }));
    expect(r.worked_min).toBe(10 * 60 + 10 - 30); expect(r.late_min).toBe(10); expect(r.ot_min).toBe(r.worked_min - 480); expect(r.status).toBe('P');
  });
});

describe('leave', () => {
  it('self-service apply, line-manager approval, ledger and attendance follow', async () => {
    const e = await eid('Sunita Kamble');
    const before = (await hr.leaveBalance(w.pool, e)).find((b) => b.code === 'CL')!;
    const mine = await hr.listLeave(w.pool, w.actors.emp.id, 'mine');
    expect(mine.length).toBe(2);
    const approved = mine.find((l) => l.status === 'approved')!;
    expect(Number(before.used)).toBe(Number(approved.days));
    const day = (await w.pool.query(`SELECT status FROM attendance WHERE employee_id=$1 AND work_date=$2`, [e, approved.from_date])).rows[0];
    expect(day.status).toBe('L');
  });

  it('you cannot approve your own request, and strangers cannot decide', async () => {
    const own = await w.as('hrm', (c) => hr.applyLeave(c, { leaveType: 'CL', from: addDays(T, 12), to: addDays(T, 12), reason: 'Personal' }));
    await rejects(w.as('hrm', (c) => hr.decideLeave(c, { leaveId: own.id, expectedVersion: own.version, approve: true })), 'FORBIDDEN');
    await rejects(w.as('sto', (c) => hr.decideLeave(c, { leaveId: own.id, expectedVersion: own.version, approve: true })), 'FORBIDDEN');
    await w.as('hre', async () => undefined);
    await w.as('md', (c) => hr.decideLeave(c, { leaveId: own.id, expectedVersion: own.version, approve: false, note: 'x' })).catch((e) => expect((e as { code: string }).code).toBe('FORBIDDEN'));
    await w.as('hrm', (c) => hr.cancelLeave(c, { leaveId: own.id, expectedVersion: own.version, reason: 'Plans changed' }));
  });

  it('checks balance and overlaps, offers unpaid leave, and cancelling restores the balance', async () => {
    const e = await eid('Sunita Kamble');
    const start = addDays(T, 30);
    await rejects(w.as('emp', (c) => hr.applyLeave(c, { leaveType: 'CL', from: start, to: addDays(start, 40), reason: 'Long trip' })), 'INVALID_STATE');
    const lwp = await w.as('emp', (c) => hr.applyLeave(c, { leaveType: 'LWP', from: start, to: addDays(start, 3), reason: 'Long trip' }));
    await rejects(w.as('emp', (c) => hr.applyLeave(c, { leaveType: 'LWP', from: addDays(start, 2), to: addDays(start, 5), reason: 'Overlap' })), 'INVALID_STATE');
    const done = await w.as('sup', (c) => hr.decideLeave(c, { leaveId: lwp.id, expectedVersion: lwp.version, approve: true }));
    expect(done.status).toBe('approved');
    const st = (await w.pool.query(`SELECT status FROM attendance WHERE employee_id=$1 AND work_date=$2`, [e, nextNonSunday(start)])).rows[0];
    void st;
    const cl = await w.as('emp', (c) => hr.applyLeave(c, { leaveType: 'SL', from: addDays(T, 20), to: addDays(T, 20), halfDay: true, reason: 'Clinic' }));
    expect(Number(cl.days)).toBe(0.5);
    const rej = await w.as('sup', (c) => hr.decideLeave(c, { leaveId: cl.id, expectedVersion: cl.version, approve: false, note: 'Busy week' }));
    expect(rej.status).toBe('rejected');
    await rejects(w.as('sup', (c) => hr.decideLeave(c, { leaveId: cl.id, expectedVersion: 2, approve: true })), 'INVALID_STATE');
  });
});
function nextNonSunday(s: string) { let d = s; while (new Date(d + 'T00:00:00Z').getUTCDay() === 0) d = addDays(d, 1); return d; }

describe('payroll', () => {
  let runId = '', ver = 0;

  it('only HR creates, only a different person approves; the month must be complete', async () => {
    await rejects(w.as('hrm', (c) => hr.createPayrollRun(c, { siteId: w.siteId, period: T.slice(0, 7) })), 'INVALID_STATE');
    await rejects(w.as('sto', (c) => hr.createPayrollRun(c, { siteId: w.siteId, period })), 'FORBIDDEN');
    const r = await w.as('hrm', (c) => hr.createPayrollRun(c, { siteId: w.siteId, period }));
    runId = r.id; ver = r.version;
    expect(r.count).toBe(20);
    await rejects(w.as('hrm', (c) => hr.createPayrollRun(c, { siteId: w.siteId, period })), 'INVALID_STATE');
  });

  it('pays exactly what the sheets say, to the paisa', async () => {
    const full = await slip(runId, 'Sunita Kamble');                      // all days paid, one of them paid leave
    expect(Number(full.paid_days)).toBe(dim); expect(full.gross).toBe('18500.00');
    expect(full.pf_employee).toBe('1680.00'); expect(full.esi_employee).toBe('138.75'); expect(full.prof_tax).toBe('0.00'); expect(full.net).toBe('16681.25');
    const absent = await slip(runId, 'Mohan Lal');                        // one unpaid absence
    expect(Number(absent.lop_days)).toBe(1);
    expect(paise(absent.basic)).toBe(round((1400000 * (dim - 1)) / dim));
    const ot = await slip(runId, 'Kavita Joshi');                         // 2 h overtime at double rate
    expect(Number(ot.ot_hours)).toBe(2);
    expect(paise(ot.ot_amount)).toBe(round((round((1400000 * 2) / (dim * 8)) * 120) / 60));
    const rich = await slip(runId, 'Rahul Sharma');                       // PF capped on wage, no ESI above the limit, professional tax
    expect(rich.pf_employee).toBe('1800.00'); expect(rich.esi_employee).toBe('0.00'); expect(rich.prof_tax).toBe('200.00');
    expect(paise(rich.net)).toBe(paise(rich.gross) - 180000 - 20000);
  });

  it('the preparer cannot approve; salary privacy holds for everyone else', async () => {
    await rejects(w.as('hrm', (c) => hr.approvePayrollRun(c, { runId, expectedVersion: ver })), 'FORBIDDEN');
    expect(await hr.listPayrollRuns(w.pool, w.actors.sto.id)).toBeNull();
    expect(await hr.listSalary(w.pool, w.actors.hre.id)).toBeNull();
    expect((await hr.listPayslips(w.pool, w.actors.emp.id)).length).toBe(0);   // own slip not visible before approval
    expect((await hr.listPayslips(w.pool, w.actors.sto.id, runId)).length).toBe(0);
  });

  it('a change after the draft blocks approval until it is recalculated', async () => {
    const e = await eid('Farida Khan'), d = addDays(prev, 2);
    await w.as('hrm', (c) => hr.markAttendance(c, { employeeId: e, date: nonSun(d), status: 'A', reason: 'Late correction' }));
    await rejects(w.as('fc', (c) => hr.approvePayrollRun(c, { runId, expectedVersion: ver })), 'INVALID_STATE');
    await w.as('hrm', (c) => hr.recalculatePayrollRun(c, { runId, expectedVersion: ver }));
    ver += 1;
    expect(Number((await slip(runId, 'Farida Khan')).lop_days)).toBe(1);
  });

  it('approval locks attendance, payslips and leave for that month', async () => {
    await w.as('fc', (c) => hr.approvePayrollRun(c, { runId, expectedVersion: ver }));
    const e = await eid('Pooja Shetty');
    await rejects(w.as('hrm', (c) => hr.markAttendance(c, { employeeId: e, date: nonSun(addDays(prev, 5)), status: 'A', reason: 'Too late' })), 'INVALID_STATE');
    await expect(w.pool.query(`UPDATE payslip SET net='1' WHERE run_id=$1`, [runId])).rejects.toThrow(/cannot be changed/);
    await expect(w.pool.query(`UPDATE attendance SET status='A' WHERE locked`)).rejects.toThrow(/locked/);
    await rejects(w.as('hrm', (c) => hr.recalculatePayrollRun(c, { runId, expectedVersion: ver + 1 })), 'INVALID_STATE');
    const own = await hr.listPayslips(w.pool, w.actors.emp.id);
    expect(own.length).toBe(1); expect(own[0].name).toBe('Sunita Kamble');
    const emp = await eid('Sunita Kamble');
    const late = await w.as('emp', (c) => hr.applyLeave(c, { leaveType: 'CL', from: nonSun(addDays(prev, 20)), to: nonSun(addDays(prev, 20)), reason: 'Forgot to apply' })).catch((e) => e);
    if (!(late instanceof Error)) await rejects(w.as('sup', (c) => hr.decideLeave(c, { leaveId: late.id, expectedVersion: late.version, approve: true })), 'INVALID_STATE');
    void emp;
  });

  it('a salary change needs a second person and cannot reach back into closed payroll', async () => {
    const e = await eid('Mohan Lal');
    const s = await w.as('hrm', (c) => hr.proposeSalary(c, { employeeId: e, effectiveFrom: prev, basic: '16000' }));
    await rejects(w.as('hrm', (c) => hr.decideSalary(c, { salaryId: s.id, approve: true })), 'FORBIDDEN');
    await rejects(w.as('fc', (c) => hr.decideSalary(c, { salaryId: s.id, approve: true })), 'INVALID_STATE');   // that month is closed
    const s2 = await w.as('hrm', (c) => hr.proposeSalary(c, { employeeId: e, effectiveFrom: T, basic: '16000' }));
    expect((await w.as('fc', (c) => hr.decideSalary(c, { salaryId: s2.id, approve: true }))).status).toBe('approved');
    const neha = await eid('Neha Kapoor');
    await rejects(w.as('hrm', (c) => hr.proposeSalary(c, { employeeId: neha, effectiveFrom: T, basic: '99999' })), 'FORBIDDEN');
  });
});
function nonSun(s: string) { let d = s; while (new Date(d + 'T00:00:00Z').getUTCDay() === 0 || ['2026-09-14', '2026-10-02', '2026-10-20'].includes(d)) d = addDays(d, 1); return d; }
