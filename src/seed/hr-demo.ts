import type { World } from './demo.js';
import * as admin from '../domain/admin.js';
import * as hr from '../domain/hr.js';
import type { Actor } from '../core/command.js';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(+new Date(s + 'T00:00:00Z') + n * 86400000));
const isSun = (s: string) => new Date(s + 'T00:00:00Z').getUTCDay() === 0;
const nextWorkday = (s: string) => { let d = s; while (isSun(d)) d = addDays(d, 1); return d; };

export const STAFF: { user?: string; name: string; dept: string; desig: string; basic: number; hra: number; other: number; manager?: boolean }[] = [
  { user: 'hrm', name: 'Neha Kapoor', dept: 'ADM', desig: 'HRM', basic: 42000, hra: 16000, other: 8000 },
  { user: 'hre', name: 'Rohan Das', dept: 'ADM', desig: 'HRE', basic: 24000, hra: 9000, other: 4000 },
  { user: 'sup', name: 'Ganesh Patil', dept: 'SEW', desig: 'SUP', basic: 26000, hra: 10000, other: 4000, manager: true },
  { user: 'emp', name: 'Sunita Kamble', dept: 'SEW', desig: 'OPR', basic: 14000, hra: 3000, other: 1500 },
  { user: 'buy', name: 'Asha Rao', dept: 'PUR', desig: 'EXE', basic: 30000, hra: 12000, other: 5000 },
  { user: 'com', name: 'Vikram Shah', dept: 'PUR', desig: 'MGR', basic: 60000, hra: 24000, other: 10000 },
  { user: 'sto', name: 'Imran Qureshi', dept: 'STR', desig: 'EXE', basic: 22000, hra: 8000, other: 3000 },
  { user: 'inv', name: 'Lakshmi Iyer', dept: 'STR', desig: 'MGR', basic: 45000, hra: 18000, other: 7000 },
  { user: 'qci', name: 'Meera Nair', dept: 'QLT', desig: 'EXE', basic: 24000, hra: 9000, other: 3000 },
  { user: 'qcm', name: 'Dr. Suresh Pillai', dept: 'QLT', desig: 'MGR', basic: 55000, hra: 22000, other: 9000 },
  { user: 'md', name: 'Rahul Sharma', dept: 'ADM', desig: 'MGR', basic: 90000, hra: 36000, other: 14000 },
  { user: 'eng', name: 'Deepak Menon', dept: 'SEW', desig: 'MGR', basic: 52000, hra: 20000, other: 8000 },
  { user: 'fc', name: 'Anita Desai', dept: 'ADM', desig: 'MGR', basic: 70000, hra: 28000, other: 11000 },
  { user: 'aud', name: 'Karan Mehta', dept: 'ADM', desig: 'EXE', basic: 38000, hra: 15000, other: 6000 },
  ...['Mohan Lal', 'Kavita Joshi', 'Ramesh Naik', 'Pooja Shetty', 'Arjun Reddy', 'Farida Khan'].map((name) => (
    { name, dept: 'SEW', desig: 'OPR', basic: 14000, hra: 3000, other: 1500 })),
];

/** Departments, shifts, leave types, people, a month and a half of attendance, salaries and some leave. */
export async function seedHrBase(w: World, password: string) {
  // HR staff logins (company staff already have theirs)
  const hrm = await w.addUser('hrm', 'HRM', { displayName: 'Neha Kapoor' });
  await w.addUser('hre', 'HRE', { displayName: 'Rohan Das' });
  await w.addUser('sup', 'SUP', { displayName: 'Ganesh Patil' });
  const emp = await w.as('admin', (c) => admin.createUser(c, { username: 'emp', displayName: 'Sunita Kamble', password }));
  w.actors.emp = { id: emp.id, username: 'emp' } as Actor;

  const D: Record<string, string> = {}, G: Record<string, string> = {};
  for (const [code, name] of [['ADM', 'Admin & HR'], ['SEW', 'Cutting & sewing'], ['PUR', 'Purchase'], ['STR', 'Stores'], ['QLT', 'Quality']])
    D[code] = (await w.as('hrm', (c) => hr.createDepartment(c, { code, name }))).id;
  for (const [code, name, grade] of [['MGR', 'Manager', 'M1'], ['SUP', 'Supervisor', 'S1'], ['EXE', 'Executive', 'E1'], ['HRM', 'HR manager', 'M1'], ['HRE', 'HR executive', 'E1'], ['OPR', 'Machine operator', 'W1']])
    G[code] = (await w.as('hrm', (c) => hr.createDesignation(c, { code, name, grade }))).id;
  const shift = await w.as('hrm', (c) => hr.createShift(c, { code: 'GEN', name: 'General shift', start: '09:00', end: '17:30', breakMin: 30, graceMin: 10 }));
  for (const [date, name] of [['2026-09-14', 'Ganesh Chaturthi'], ['2026-10-02', 'Gandhi Jayanti'], ['2026-10-20', 'Dussehra']])
    await w.as('hrm', (c) => hr.addHoliday(c, { date, name }));
  for (const [code, name, paid, quota] of [['CL', 'Casual leave', true, '12'], ['SL', 'Sick leave', true, '12'], ['EL', 'Earned leave', true, '15'], ['LWP', 'Leave without pay', false, '0']] as const)
    await w.as('hrm', (c) => hr.createLeaveType(c, { code, name, paid, annualQuota: quota }));

  // People. Supervisor first so the operators can report to him.
  const ids: Record<string, string> = {};
  let supId = '';
  for (const p of STAFF) {
    const e = await w.as('hrm', (c) => hr.createEmployee(c, {
      name: p.name, siteId: w.siteId, joinDate: '2025-04-01', departmentId: D[p.dept], designationId: G[p.desig], shiftId: shift.id,
      userId: p.user ? w.actors[p.user].id : null, managerId: p.dept === 'SEW' && !p.manager && p.desig === 'OPR' ? supId || null : null,
      phone: '98450' + String(10000 + Object.keys(ids).length * 137).slice(0, 5), bankAccount: '5010' + String(Math.abs(p.name.length * 9301234567)).slice(0, 8),
      pfApplicable: true, esiApplicable: true }));
    ids[p.user ?? p.name] = e.id;
    if (p.manager) supId = e.id;
  }

  // Salaries: proposed by HR, approved by finance
  for (const p of STAFF) {
    const s = await w.as(p.user === 'hrm' ? 'md' : 'hrm', (c) => hr.proposeSalary(c, { employeeId: ids[p.user ?? p.name], effectiveFrom: '2025-04-01', basic: String(p.basic), hra: String(p.hra), otherAllowance: String(p.other) }));
    await w.as(p.user === 'fc' ? 'md' : 'fc', (c) => hr.decideSalary(c, { salaryId: s.id, approve: true }));
  }

  return { employees: ids };
}

/**
 * Everything that is relative to "today": leave quotas for this year, six weeks of attendance, one absence, one
 * overtime day, a late arrival and two leave requests. Run when the demo is first opened, so it is never stale.
 */
export async function seedHrRecent(w: World) {
  const T = iso(new Date());
  const prevStart = iso(new Date(Date.UTC(+T.slice(0, 4), +T.slice(5, 7) - 2, 1)));
  const yesterday = addDays(T, -1);
  const eid = async (name: string) => (await w.pool.query('SELECT id FROM employee WHERE name=$1', [name])).rows[0].id as string;
  for (const y of new Set([+prevStart.slice(0, 4), +T.slice(0, 4)])) await w.as('hrm', (c) => hr.allocateAnnualLeave(c, { siteId: w.siteId, year: y }));
  await w.as('hrm', (c) => hr.fillDefaultAttendance(c, { siteId: w.siteId, from: prevStart, to: yesterday }));

  // A realistic month: one absence, one night of overtime, a late arrival, then a leave the line manager approves
  const day = (n: number) => nextWorkday(addDays(prevStart, n));
  const ops = ['Mohan Lal', 'Kavita Joshi', 'Ramesh Naik'];
  const isHol = (d: string) => ['2026-09-14', '2026-10-02', '2026-10-20'].includes(d);
  const [o0, o1, o2] = [await eid(ops[0]), await eid(ops[1]), await eid(ops[2])];
  const pick = (n: number) => { let d = day(n); while (isHol(d)) d = nextWorkday(addDays(d, 1)); return d; };
  await w.as('hrm', (c) => hr.markAttendance(c, { employeeId: o0, date: pick(4), status: 'A', reason: 'Absent without information' }));
  await w.as('hrm', (c) => hr.markAttendance(c, { employeeId: o1, date: pick(8), inTime: '09:00', outTime: '19:30', reason: 'Overtime on the Sunday export order' }));
  await w.as('hrm', (c) => hr.markAttendance(c, { employeeId: o2, date: pick(11), inTime: '09:45', outTime: '17:30', reason: 'Late bus' }));
  const l1 = await w.as('emp', (c) => hr.applyLeave(c, { leaveType: 'CL', from: pick(14), to: pick(14), reason: 'Family function' }));
  await w.as('sup', (c) => hr.decideLeave(c, { leaveId: l1.id, expectedVersion: l1.version, approve: true, note: 'Approved' }));
  const next = nextWorkday(addDays(T, 9));
  await w.as('emp', (c) => hr.applyLeave(c, { leaveType: 'EL', from: next, to: nextWorkday(addDays(next, 1)), reason: 'Visiting family after the festival' }));
  return { lastMonth: prevStart.slice(0, 7) };
}
