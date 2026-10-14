import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan, assertIndependent, can, visibleSites } from '../core/permissions.js';
import { audit, emit } from '../core/audit.js';
import { nextNumber } from '../core/numbering.js';
import { badRequest, forbidden, invalidState, notFound, staleVersion } from '../core/errors.js';

// ───────────────────────── helpers ─────────────────────────
const DAY = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw badRequest(`Invalid date: ${s}`); const d = new Date(s + 'T00:00:00Z'); if (isNaN(+d)) throw badRequest(`Invalid date: ${s}`); return d; };
const eachDay = (from: string, to: string) => { const out: string[] = []; for (let t = +parse(from); t <= +parse(to); t += DAY) out.push(iso(new Date(t))); return out; };
const isSunday = (s: string) => parse(s).getUTCDay() === 0;
const today = () => iso(new Date());
const monthStart = (period: string) => { const m = /^(\d{4})-(\d{2})$/.exec(period); if (!m || +m[2] < 1 || +m[2] > 12) throw badRequest('Period must look like 2026-09'); return `${m[1]}-${m[2]}-01`; };
const monthEnd = (start: string) => { const d = parse(start); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))); };
const hhmm = (t: string) => { const m = /^(\d{2}):(\d{2})/.exec(t); if (!m || +m[1] > 23 || +m[2] > 59) throw badRequest(`Invalid time: ${t}`); return +m[1] * 60 + +m[2]; };

// Money in whole paise as bigint; no floating point near pay.
const toPaise = (v: string | number): bigint => { const s = typeof v === 'number' ? v.toFixed(2) : String(v).trim(); if (!/^-?\d+(\.\d{1,4})?$/.test(s)) throw badRequest(`Invalid amount: ${v}`); const [i, f = ''] = s.replace('-', '').split('.'); const n = BigInt(i) * 100n + BigInt((f + '00').slice(0, 2)); return s.startsWith('-') ? -n : n; };
const fromPaise = (n: bigint) => { const neg = n < 0n; const a = neg ? -n : n; return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`; };
const divRound = (num: bigint, den: bigint) => (num * 2n + den) / (den * 2n);          // half-up, non-negative
const divCeil = (num: bigint, den: bigint) => (num + den - 1n) / den;

/**
 * Statutory parameters. These are the commonly used Indian defaults and MUST be confirmed with your
 * accountant per state and financial year before the first real payroll run. TDS is not handled in this slice.
 */
export const PAYROLL_RULES = {
  pfRatePct: 12n, pfWageCap: toPaise('15000'),                // employee PF 12% of basic, wage capped
  esiGrossLimit: toPaise('21000'), esiEmployeeBp: 75n, esiEmployerBp: 325n,   // 0.75% / 3.25% of gross (basis points)
  ptThreshold: toPaise('25000'), ptAmount: toPaise('200'),     // professional tax (Karnataka style flat slab)
  otMultiplier: 2n, hoursPerDay: 8n,
};

async function loadEmployee(db: Db, id: string, lock = false) {
  const e = (await db.query(`SELECT * FROM employee WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!e) throw notFound('Employee');
  return e;
}
/** Own record is always readable by its owner; everything else needs the permission at the employee's site. */
async function canSeeEmployee(db: Db, userId: string, e: { site_id: string; user_id: string | null }, perm = 'hr.employee.view') {
  return e.user_id === userId || (await can(db, userId, perm, { siteId: e.site_id }));
}
async function myEmployee(db: Db, userId: string) { return (await db.query('SELECT * FROM employee WHERE user_id=$1', [userId])).rows[0] ?? null; }

// ───────────────────────── organisation ─────────────────────────
export async function createDepartment(ctx: Ctx, i: { code: string; name: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'hr.org.manage', { anySite: true });
  const r = await ctx.db.query('INSERT INTO department(code, name) VALUES ($1,$2) RETURNING *', [i.code.toUpperCase(), i.name]);
  await audit(ctx, { action: 'hr.department.create', entityType: 'department', entityId: r.rows[0].id, after: r.rows[0] });
  return r.rows[0];
}
export async function createDesignation(ctx: Ctx, i: { code: string; name: string; grade?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'hr.org.manage', { anySite: true });
  const r = await ctx.db.query('INSERT INTO designation(code, name, grade) VALUES ($1,$2,$3) RETURNING *', [i.code.toUpperCase(), i.name, i.grade ?? null]);
  await audit(ctx, { action: 'hr.designation.create', entityType: 'designation', entityId: r.rows[0].id, after: r.rows[0] });
  return r.rows[0];
}
export async function createShift(ctx: Ctx, i: { code: string; name: string; start: string; end: string; breakMin?: number; graceMin?: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'hr.shift.manage', { anySite: true });
  hhmm(i.start); hhmm(i.end);
  const r = await ctx.db.query('INSERT INTO shift(code, name, start_time, end_time, break_min, grace_min) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [i.code.toUpperCase(), i.name, i.start, i.end, i.breakMin ?? 30, i.graceMin ?? 10]);
  await audit(ctx, { action: 'hr.shift.create', entityType: 'shift', entityId: r.rows[0].id, after: r.rows[0] });
  return r.rows[0];
}
export async function addHoliday(ctx: Ctx, i: { date: string; name: string; siteId?: string | null }) {
  await assertCan(ctx.db, ctx.actor.id, 'hr.shift.manage', { anySite: true });
  parse(i.date);
  const r = await ctx.db.query('INSERT INTO holiday(on_date, name, site_id) VALUES ($1,$2,$3) RETURNING *', [i.date, i.name, i.siteId ?? null]);
  await audit(ctx, { action: 'hr.holiday.add', entityType: 'holiday', entityId: r.rows[0].id, after: r.rows[0] });
  return r.rows[0];
}
export async function createLeaveType(ctx: Ctx, i: { code: string; name: string; paid: boolean; annualQuota: string; allowNegative?: boolean }) {
  await assertCan(ctx.db, ctx.actor.id, 'hr.org.manage', { anySite: true });
  const r = await ctx.db.query('INSERT INTO leave_type(code, name, paid, annual_quota, allow_negative) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [i.code.toUpperCase(), i.name, i.paid, i.annualQuota, !!i.allowNegative]);
  await audit(ctx, { action: 'hr.leave_type.create', entityType: 'leave_type', after: r.rows[0] });
  return r.rows[0];
}

// ───────────────────────── employees ─────────────────────────
export interface NewEmployee {
  name: string; siteId: string; joinDate: string; departmentId?: string | null; designationId?: string | null; managerId?: string | null;
  shiftId?: string | null; empType?: string; phone?: string | null; bankAccount?: string | null; pfApplicable?: boolean; esiApplicable?: boolean; userId?: string | null;
}
export async function createEmployee(ctx: Ctx, i: NewEmployee) {
  await assertCan(ctx.db, ctx.actor.id, 'hr.employee.create', { siteId: i.siteId });
  if (!i.name.trim()) throw badRequest('Name is required');
  parse(i.joinDate);
  if (i.managerId) { const m = await loadEmployee(ctx.db, i.managerId); if (m.site_id !== i.siteId) throw badRequest('The manager works at a different site'); }
  if (i.userId && !(await ctx.db.query('SELECT 1 FROM app_user WHERE id=$1', [i.userId])).rowCount) throw notFound('User');
  const code = await nextNumber(ctx, i.siteId, 'EMP');
  const r = await ctx.db.query(
    `INSERT INTO employee(code, name, site_id, department_id, designation_id, manager_id, shift_id, user_id, emp_type, join_date, phone, bank_account, pf_applicable, esi_applicable, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [code, i.name.trim(), i.siteId, i.departmentId ?? null, i.designationId ?? null, i.managerId ?? null, i.shiftId ?? null, i.userId ?? null,
     i.empType ?? 'permanent', i.joinDate, i.phone ?? null, i.bankAccount ?? null, i.pfApplicable ?? true, i.esiApplicable ?? true, ctx.actor.id]);
  const { bank_account, ...safe } = r.rows[0];
  await audit(ctx, { action: 'hr.employee.create', entityType: 'employee', entityId: r.rows[0].id, after: { ...safe, bank_account: bank_account ? 'provided' : null } });
  await emit(ctx, { type: 'employee.joined', entityType: 'employee', entityId: r.rows[0].id, siteId: i.siteId, payload: { code } });
  return r.rows[0];
}

export async function updateEmployee(ctx: Ctx, i: { employeeId: string; expectedVersion: number; changes: Partial<Pick<NewEmployee, 'name' | 'departmentId' | 'designationId' | 'managerId' | 'shiftId' | 'phone' | 'bankAccount' | 'pfApplicable' | 'esiApplicable' | 'empType' | 'userId'>> }) {
  const e = await loadEmployee(ctx.db, i.employeeId, true);
  await assertCan(ctx.db, ctx.actor.id, 'hr.employee.edit', { siteId: e.site_id });
  if (e.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, e.version);
  if (e.status === 'exited') throw invalidState('This person has left. Their record is read-only');
  const c = i.changes;
  if (c.managerId) {
    if (c.managerId === e.id) throw badRequest('Nobody can report to themselves');
    // refuse reporting loops
    let cur: string | null = c.managerId;
    for (let n = 0; cur && n < 50; n++) { if (cur === e.id) throw badRequest('That would create a reporting loop'); cur = (await ctx.db.query('SELECT manager_id FROM employee WHERE id=$1', [cur])).rows[0]?.manager_id ?? null; }
  }
  const map: Record<string, string> = { name: 'name', departmentId: 'department_id', designationId: 'designation_id', managerId: 'manager_id', shiftId: 'shift_id', phone: 'phone', bankAccount: 'bank_account', pfApplicable: 'pf_applicable', esiApplicable: 'esi_applicable', empType: 'emp_type', userId: 'user_id' };
  const sets: string[] = []; const vals: unknown[] = [e.id]; const before: Record<string, unknown> = {}; const after: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(map)) {
    if (!(k in c)) continue;
    vals.push((c as Record<string, unknown>)[k] ?? null); sets.push(`${col}=$${vals.length}`);
    const secret = col === 'bank_account';
    before[col] = secret ? '••••' : e[col]; after[col] = secret ? '••••' : (c as Record<string, unknown>)[k] ?? null;
  }
  if (!sets.length) throw badRequest('Nothing to change');
  const r = await ctx.db.query(`UPDATE employee SET ${sets.join(', ')}, version=version+1 WHERE id=$1 RETURNING *`, vals);
  await audit(ctx, { action: 'hr.employee.update', entityType: 'employee', entityId: e.id, before, after });
  return r.rows[0];
}

export async function exitEmployee(ctx: Ctx, i: { employeeId: string; expectedVersion: number; exitDate: string; reason: string }) {
  const e = await loadEmployee(ctx.db, i.employeeId, true);
  await assertCan(ctx.db, ctx.actor.id, 'hr.employee.exit', { siteId: e.site_id });
  if (e.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, e.version);
  if (e.status === 'exited') throw invalidState('Already exited');
  if (!i.reason) throw badRequest('A reason is required');
  parse(i.exitDate);
  if (i.exitDate < e.join_date) throw badRequest('The last working day cannot be before the joining date');
  const locked = await ctx.db.query(`SELECT 1 FROM attendance WHERE employee_id=$1 AND locked AND work_date > $2 LIMIT 1`, [e.id, i.exitDate]);
  if (locked.rowCount) throw invalidState('Payroll after that date is already final, so the exit date cannot be earlier');
  await ctx.db.query(`UPDATE employee SET status='exited', exit_date=$2, exit_reason=$3, version=version+1 WHERE id=$1`, [e.id, i.exitDate, i.reason]);
  await ctx.db.query(`UPDATE leave_request SET status='cancelled', version=version+1, decision_note='Employee exited' WHERE employee_id=$1 AND status='pending'`, [e.id]);
  if (e.user_id) { await ctx.db.query('UPDATE app_user SET active=false WHERE id=$1', [e.user_id]); await ctx.db.query('DELETE FROM session WHERE user_id=$1', [e.user_id]); }
  await audit(ctx, { action: 'hr.employee.exit', entityType: 'employee', entityId: e.id, before: { status: 'active' }, after: { status: 'exited', exit_date: i.exitDate }, reason: i.reason });
  await emit(ctx, { type: 'employee.exited', entityType: 'employee', entityId: e.id, siteId: e.site_id, payload: { code: e.code, exitDate: i.exitDate } });
  return { employeeId: e.id, exitDate: i.exitDate };
}

export async function listEmployees(db: Db, userId: string, opts: { includeExited?: boolean } = {}) {
  const sites = await visibleSites(db, userId, 'hr.employee.view');
  const bank = await can(db, userId, 'hr.bank.view', { anySite: true });
  const rows = (await db.query(
    `SELECT e.id, e.code, e.name, e.status, e.emp_type, e.join_date, e.exit_date, e.phone, e.version, e.manager_id, e.user_id, e.site_id, e.shift_id,
            e.pf_applicable, e.esi_applicable, s.code AS site, d.name AS department, g.name AS designation, m.name AS manager, sh.code AS shift,
            CASE WHEN $3 THEN e.bank_account WHEN e.bank_account IS NULL THEN NULL ELSE '••••' || right(e.bank_account, 4) END AS bank_account
       FROM employee e JOIN site s ON s.id = e.site_id LEFT JOIN department d ON d.id = e.department_id
       LEFT JOIN designation g ON g.id = e.designation_id LEFT JOIN employee m ON m.id = e.manager_id LEFT JOIN shift sh ON sh.id = e.shift_id
      WHERE (e.user_id = $1 OR ($2::uuid[] IS NULL OR e.site_id = ANY($2::uuid[]))) AND ($4 OR e.status = 'active')
      ORDER BY e.code`, [userId, sites, bank, !!opts.includeExited])).rows;
  // a user with no HR view right still sees their own record only
  const canAll = sites === null || sites.length > 0;
  return canAll ? rows : rows.filter((r) => r.user_id === userId);
}

export async function hrReference(db: Db) {
  return {
    departments: (await db.query('SELECT id, code, name FROM department ORDER BY code')).rows,
    designations: (await db.query('SELECT id, code, name, grade FROM designation ORDER BY code')).rows,
    shifts: (await db.query('SELECT id, code, name, start_time, end_time, break_min, grace_min FROM shift ORDER BY code')).rows,
    leaveTypes: (await db.query('SELECT code, name, paid, annual_quota, allow_negative FROM leave_type ORDER BY code')).rows,
    holidays: (await db.query('SELECT id, on_date, name, site_id FROM holiday ORDER BY on_date')).rows,
  };
}

// ───────────────────────── attendance ─────────────────────────
async function holidaySet(db: Db, siteId: string, from: string, to: string) {
  const rows = (await db.query('SELECT on_date FROM holiday WHERE on_date BETWEEN $1 AND $2 AND (site_id IS NULL OR site_id=$3)', [from, to, siteId])).rows;
  return new Set(rows.map((r) => r.on_date as string));
}

async function assertMarkable(db: Db, e: { id: string; join_date: string; exit_date: string | null; status: string }, date: string) {
  parse(date);
  if (date > today()) throw badRequest('Attendance cannot be marked for a future date');
  if (date < e.join_date) throw badRequest(`${date} is before the joining date`);
  if (e.exit_date && date > e.exit_date) throw badRequest(`${date} is after the last working day`);
}

/** Who may mark: HR at the site, or a line manager for their own team. */
async function assertCanMark(db: Db, actorId: string, e: { site_id: string; manager_id: string | null }, correcting: boolean) {
  const mine = await myEmployee(db, actorId);
  const isManager = !!mine && e.manager_id === mine.id;
  if (correcting) {
    if (!(await can(db, actorId, 'hr.attendance.correct', { siteId: e.site_id }))) throw forbidden('Not permitted: hr.attendance.correct at this site. Changing an existing mark needs HR');
    return;
  }
  if (await can(db, actorId, 'hr.attendance.mark', { siteId: e.site_id })) {
    // a supervisor holds the right only for their own team
    const hrWide = await can(db, actorId, 'hr.employee.create', { siteId: e.site_id });
    if (hrWide || isManager) return;
    throw forbidden('Not permitted: you can mark attendance only for people who report to you');
  }
  throw forbidden('Not permitted: hr.attendance.mark at this site');
}

export async function markAttendance(ctx: Ctx, i: { employeeId: string; date: string; status?: 'P' | 'A' | 'H' | 'WO' | 'HOL'; inTime?: string | null; outTime?: string | null; note?: string; reason?: string }) {
  const e = await loadEmployee(ctx.db, i.employeeId, true);
  await assertMarkable(ctx.db, e, i.date);
  const existing = (await ctx.db.query('SELECT * FROM attendance WHERE employee_id=$1 AND work_date=$2 FOR UPDATE', [e.id, i.date])).rows[0];
  await assertCanMark(ctx.db, ctx.actor.id, e, !!existing);
  if (existing) {
    if (existing.locked) throw invalidState(`Attendance for ${i.date} is locked by approved payroll`);
    if (['L', 'LWP'].includes(existing.status)) throw invalidState('That day is covered by approved leave. Cancel the leave instead');
    if (!i.reason) throw badRequest('A reason is required to change an existing mark');
  }
  const shift = e.shift_id ? (await ctx.db.query('SELECT * FROM shift WHERE id=$1', [e.shift_id])).rows[0] : null;
  let worked = 0, late = 0, ot = 0, status = i.status;
  if (i.inTime || i.outTime) {
    if (!i.inTime || !i.outTime) throw badRequest('Give both in and out times, or neither');
    const a = hhmm(i.inTime), b = hhmm(i.outTime);
    if (b <= a) throw badRequest('Out time must be after in time');
    worked = b - a - (shift ? Math.min(shift.break_min, Math.max(0, b - a - 60)) : 0);
    if (shift) {
      const sStart = hhmm(shift.start_time), sLen = hhmm(shift.end_time) - sStart - shift.break_min;
      late = Math.max(0, a - sStart - shift.grace_min);
      ot = worked - sLen >= 30 ? worked - sLen : 0;
      if (!status) status = worked >= sLen * 0.75 ? 'P' : worked >= sLen * 0.4 ? 'H' : 'A';
    } else if (!status) status = worked >= 360 ? 'P' : worked >= 200 ? 'H' : 'A';
  }
  if (!status) throw badRequest('Give a status, or in and out times');
  const r = await ctx.db.query(
    `INSERT INTO attendance(employee_id, work_date, status, in_time, out_time, worked_min, late_min, ot_min, source, note, marked_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9,$10)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET status=EXCLUDED.status, in_time=EXCLUDED.in_time, out_time=EXCLUDED.out_time, worked_min=EXCLUDED.worked_min,
       late_min=EXCLUDED.late_min, ot_min=EXCLUDED.ot_min, note=EXCLUDED.note, marked_by=EXCLUDED.marked_by, version=attendance.version+1 RETURNING *`,
    [e.id, i.date, status, i.inTime ?? null, i.outTime ?? null, worked, late, ot, i.note ?? null, ctx.actor.id]);
  await audit(ctx, { action: existing ? 'hr.attendance.correct' : 'hr.attendance.mark', entityType: 'attendance', entityId: r.rows[0].id,
    before: existing ? { status: existing.status, in: existing.in_time, out: existing.out_time } : undefined, after: { employee: e.code, date: i.date, status }, reason: i.reason ?? null });
  return r.rows[0];
}

/** Fill the gaps for a date range: Sundays and holidays are offs, everyone else present. Existing marks are never touched. */
export async function fillDefaultAttendance(ctx: Ctx, i: { siteId: string; from: string; to: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'hr.attendance.mark', { siteId: i.siteId });
  if (!(await can(ctx.db, ctx.actor.id, 'hr.employee.create', { siteId: i.siteId }))) throw forbidden('Not permitted: filling a whole site needs HR');
  parse(i.from); parse(i.to);
  if (i.to < i.from) throw badRequest('The end date is before the start date');
  if (i.to > today()) throw badRequest('Attendance cannot be filled for future dates');
  if (+parse(i.to) - +parse(i.from) > 62 * DAY) throw badRequest('Fill at most two months at a time');
  const r = await ctx.db.query(
    `INSERT INTO attendance(employee_id, work_date, status, source, marked_by)
     SELECT DISTINCT e.id, d::date,
            CASE WHEN h.id IS NOT NULL THEN 'HOL' WHEN extract(dow FROM d) = 0 THEN 'WO' ELSE 'P' END, 'default', $4::uuid
       FROM employee e CROSS JOIN generate_series($2::date, $3::date, interval '1 day') d
       LEFT JOIN holiday h ON h.on_date = d::date AND (h.site_id IS NULL OR h.site_id = e.site_id)
      WHERE e.site_id = $1 AND d::date >= e.join_date AND (e.exit_date IS NULL OR d::date <= e.exit_date)
     ON CONFLICT DO NOTHING`, [i.siteId, i.from, i.to, ctx.actor.id]);
  const created = r.rowCount ?? 0;
  await audit(ctx, { action: 'hr.attendance.fill', entityType: 'attendance', after: { siteId: i.siteId, from: i.from, to: i.to, created } });
  return { created };
}

export async function dailyAttendance(db: Db, userId: string, siteId: string, date: string) {
  if (!(await can(db, userId, 'hr.attendance.view', { siteId }))) return null;
  const mine = await myEmployee(db, userId);
  const hrWide = await can(db, userId, 'hr.employee.create', { siteId });
  return (await db.query(
    `SELECT e.id AS employee_id, e.code, e.name, e.manager_id, a.id, a.status, a.in_time, a.out_time, a.worked_min, a.late_min, a.ot_min, a.locked, a.note, sh.code AS shift
       FROM employee e LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = $2 LEFT JOIN shift sh ON sh.id = e.shift_id
      WHERE e.site_id = $1 AND e.status = 'active' AND e.join_date <= $2 AND ($3 OR e.manager_id = $4 OR e.user_id = $5) ORDER BY e.code`,
    [siteId, date, hrWide, mine?.id ?? null, userId])).rows;
}

export async function monthlyAttendance(db: Db, userId: string, employeeId: string, period: string) {
  const e = await loadEmployee(db, employeeId);
  if (!(await canSeeEmployee(db, userId, e, 'hr.attendance.view'))) throw notFound('Employee');
  const from = monthStart(period), to = monthEnd(from);
  const rows = (await db.query('SELECT work_date, status, in_time, out_time, worked_min, late_min, ot_min, locked FROM attendance WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3 ORDER BY work_date', [employeeId, from, to])).rows;
  const n = (s: string) => rows.filter((r) => r.status === s).length;
  return { rows, summary: { present: n('P'), half: n('H'), absent: n('A'), leave: n('L'), unpaidLeave: n('LWP'), weeklyOff: n('WO'), holiday: n('HOL'), otHours: rows.reduce((a, r) => a + r.ot_min, 0) / 60 } };
}

// ───────────────────────── leave ─────────────────────────
export async function leaveBalance(db: Db, employeeId: string, year = new Date().getUTCFullYear()) {
  return (await db.query(
    `SELECT t.code, t.name, t.paid, t.annual_quota, COALESCE(SUM(l.delta) FILTER (WHERE l.year = $2), 0)::numeric(6,1) AS balance,
            COALESCE(-SUM(l.delta) FILTER (WHERE l.year = $2 AND l.kind IN ('used','reversal')), 0)::numeric(6,1) AS used
       FROM leave_type t LEFT JOIN leave_ledger l ON l.leave_type = t.code AND l.employee_id = $1 GROUP BY t.code ORDER BY t.code`, [employeeId, year])).rows;
}

export async function allocateAnnualLeave(ctx: Ctx, i: { siteId: string; year: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'hr.leave.grant', { siteId: i.siteId });
  const emps = (await ctx.db.query(`SELECT id FROM employee WHERE site_id=$1 AND status='active'`, [i.siteId])).rows;
  const types = (await ctx.db.query('SELECT code, annual_quota FROM leave_type WHERE annual_quota > 0')).rows;
  let granted = 0;
  for (const e of emps) for (const t of types) {
    const r = await ctx.db.query(
      `INSERT INTO leave_ledger(employee_id, leave_type, delta, kind, year, reason, actor_id) VALUES ($1,$2,$3,'annual',$4,$5,$6) ON CONFLICT DO NOTHING`,
      [e.id, t.code, t.annual_quota, i.year, `Annual quota ${i.year}`, ctx.actor.id]);
    granted += r.rowCount ?? 0;
  }
  await audit(ctx, { action: 'hr.leave.allocate', entityType: 'leave_ledger', after: { ...i, granted } });
  return { granted };
}

export async function adjustLeave(ctx: Ctx, i: { employeeId: string; leaveType: string; days: string; reason: string; year?: number }) {
  const e = await loadEmployee(ctx.db, i.employeeId);
  await assertCan(ctx.db, ctx.actor.id, 'hr.leave.grant', { siteId: e.site_id });
  if (!i.reason) throw badRequest('A reason is required');
  if (!Number(i.days)) throw badRequest('Days must be a non-zero number');
  if (!(await ctx.db.query('SELECT 1 FROM leave_type WHERE code=$1', [i.leaveType])).rowCount) throw notFound(`Leave type ${i.leaveType}`);
  await ctx.db.query(`INSERT INTO leave_ledger(employee_id, leave_type, delta, kind, year, reason, actor_id) VALUES ($1,$2,$3,'adjust',$4,$5,$6)`,
    [e.id, i.leaveType, i.days, i.year ?? new Date().getUTCFullYear(), i.reason, ctx.actor.id]);
  await audit(ctx, { action: 'hr.leave.adjust', entityType: 'employee', entityId: e.id, after: i, reason: i.reason });
  return { employeeId: e.id };
}

async function countLeaveDays(db: Db, siteId: string, from: string, to: string, half: boolean) {
  const hol = await holidaySet(db, siteId, from, to);
  const days = eachDay(from, to).filter((d) => !isSunday(d) && !hol.has(d));
  if (half) { if (from !== to) throw badRequest('A half day must be a single date'); if (!days.length) throw badRequest('That date is a day off already'); return 0.5; }
  if (!days.length) throw badRequest('Those dates are all days off already (Sundays or holidays)');
  return days.length;
}

export async function applyLeave(ctx: Ctx, i: { employeeId?: string; leaveType: string; from: string; to: string; halfDay?: boolean; reason: string }) {
  const mine = await myEmployee(ctx.db, ctx.actor.id);
  const e = i.employeeId ? await loadEmployee(ctx.db, i.employeeId, true) : mine;
  if (!e) throw badRequest('Your account is not linked to an employee record');
  const own = e.user_id === ctx.actor.id;
  if (!own) await assertCan(ctx.db, ctx.actor.id, 'hr.leave.approve.any', { siteId: e.site_id });   // HR may apply on someone's behalf
  if (e.status !== 'active') throw invalidState('This person has left');
  if (!i.reason.trim()) throw badRequest('A reason is required');
  parse(i.from); parse(i.to);
  if (i.to < i.from) throw badRequest('The end date is before the start date');
  if (i.from < e.join_date) throw badRequest('Leave cannot start before the joining date');
  const lt = (await ctx.db.query('SELECT * FROM leave_type WHERE code=$1', [i.leaveType])).rows[0];
  if (!lt) throw notFound(`Leave type ${i.leaveType}`);
  const days = await countLeaveDays(ctx.db, e.site_id, i.from, i.to, !!i.halfDay);
  const clash = await ctx.db.query(`SELECT number FROM leave_request WHERE employee_id=$1 AND status IN ('pending','approved') AND from_date <= $3 AND to_date >= $2 LIMIT 1`, [e.id, i.from, i.to]);
  if (clash.rowCount) throw invalidState(`These dates overlap ${clash.rows[0].number}`);
  if (lt.paid && !lt.allow_negative) {
    const bal = Number((await leaveBalance(ctx.db, e.id, parse(i.from).getUTCFullYear())).find((b) => b.code === lt.code)?.balance ?? 0);
    const pending = Number((await ctx.db.query(`SELECT COALESCE(SUM(days),0) AS d FROM leave_request WHERE employee_id=$1 AND leave_type=$2 AND status='pending'`, [e.id, lt.code])).rows[0].d);
    if (days > bal - pending) throw invalidState(`Only ${bal - pending} day(s) of ${lt.name} available (${pending} already waiting for approval). Apply for unpaid leave instead`);
  }
  const number = await nextNumber(ctx, e.site_id, 'LV');
  const r = await ctx.db.query(
    `INSERT INTO leave_request(number, employee_id, leave_type, from_date, to_date, half_day, days, reason, applied_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [number, e.id, lt.code, i.from, i.to, !!i.halfDay, days, i.reason.trim(), ctx.actor.id]);
  await audit(ctx, { action: 'hr.leave.apply', entityType: 'leave_request', entityId: r.rows[0].id, after: { number, employee: e.code, type: lt.code, from: i.from, to: i.to, days } });
  return r.rows[0];
}

async function loadLeave(db: Db, id: string, expectedVersion: number) {
  const l = (await db.query('SELECT * FROM leave_request WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!l) throw notFound('Leave request');
  if (l.version !== expectedVersion) throw staleVersion(expectedVersion, l.version);
  return l;
}

async function assertCanDecideLeave(db: Db, actorId: string, e: { site_id: string; manager_id: string | null }, l: { applied_by: string }) {
  assertIndependent(actorId, l.applied_by, 'leave request');
  if (await can(db, actorId, 'hr.leave.approve.any', { siteId: e.site_id })) return;
  const mine = await myEmployee(db, actorId);
  if (mine && e.manager_id === mine.id && (await can(db, actorId, 'hr.leave.approve', { siteId: e.site_id }))) return;
  throw forbidden('Not permitted: leave is decided by the line manager or HR');
}

export async function decideLeave(ctx: Ctx, i: { leaveId: string; expectedVersion: number; approve: boolean; note?: string }) {
  const l = await loadLeave(ctx.db, i.leaveId, i.expectedVersion);
  const e = await loadEmployee(ctx.db, l.employee_id, true);
  if (!ctx.override) await assertCanDecideLeave(ctx.db, ctx.actor.id, e, l);
  if (l.status !== 'pending') throw invalidState(`This request is already ${l.status}`);
  if (!i.approve) {
    if (!i.note) throw badRequest('Say why it is being rejected');
    await ctx.db.query(`UPDATE leave_request SET status='rejected', decided_by=$2, decision_note=$3, version=version+1 WHERE id=$1`, [l.id, ctx.actor.id, i.note]);
    await audit(ctx, { action: 'hr.leave.reject', entityType: 'leave_request', entityId: l.id, reason: i.note });
    return { id: l.id, status: 'rejected' };
  }
  const lt = (await ctx.db.query('SELECT * FROM leave_type WHERE code=$1', [l.leave_type])).rows[0];
  const year = parse(l.from_date).getUTCFullYear();
  if (lt.paid && !lt.allow_negative) {
    const bal = Number((await leaveBalance(ctx.db, e.id, year)).find((b) => b.code === lt.code)?.balance ?? 0);
    if (Number(l.days) > bal) throw invalidState(`Balance is now ${bal} day(s); the request needs ${l.days}`);
  }
  // Payroll that is already final cannot be disturbed
  const locked = await ctx.db.query('SELECT 1 FROM attendance WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3 AND locked LIMIT 1', [e.id, l.from_date, l.to_date]);
  if (locked.rowCount) throw invalidState('Payroll for part of this period is already approved. HR must handle it as an adjustment');
  await ctx.db.query(`UPDATE leave_request SET status='approved', decided_by=$2, decision_note=$3, version=version+1 WHERE id=$1`, [l.id, ctx.actor.id, i.note ?? null]);
  await ctx.db.query(`INSERT INTO leave_ledger(employee_id, leave_type, delta, kind, year, request_id, reason, actor_id) VALUES ($1,$2,$3,'used',$4,$5,$6,$7)`,
    [e.id, lt.code, `-${l.days}`, year, l.id, l.number, ctx.actor.id]);
  // Mark the days on the attendance sheet. A half day keeps the other half as it was.
  const hol = await holidaySet(ctx.db, e.site_id, l.from_date, l.to_date);
  for (const d of eachDay(l.from_date, l.to_date)) {
    if (isSunday(d) || hol.has(d)) continue;
    if (l.half_day) {
      await ctx.db.query(`INSERT INTO attendance(employee_id, work_date, status, source, note, marked_by) VALUES ($1,$2,'H','leave',$3,$4)
        ON CONFLICT (employee_id, work_date) DO UPDATE SET status='H', note=EXCLUDED.note, version=attendance.version+1`, [e.id, d, `Half-day ${lt.code} ${l.number}`, ctx.actor.id]);
    } else {
      await ctx.db.query(`INSERT INTO attendance(employee_id, work_date, status, source, note, marked_by) VALUES ($1,$2,$3,'leave',$4,$5)
        ON CONFLICT (employee_id, work_date) DO UPDATE SET status=EXCLUDED.status, in_time=NULL, out_time=NULL, worked_min=0, late_min=0, ot_min=0, note=EXCLUDED.note, version=attendance.version+1`,
        [e.id, d, lt.paid ? 'L' : 'LWP', `${lt.code} ${l.number}`, ctx.actor.id]);
    }
  }
  await audit(ctx, { action: 'hr.leave.approve', entityType: 'leave_request', entityId: l.id, after: { number: l.number, days: l.days } });
  await emit(ctx, { type: 'leave.approved', entityType: 'leave_request', entityId: l.id, siteId: e.site_id, payload: { number: l.number, employee: e.code } });
  return { id: l.id, status: 'approved' };
}

export async function cancelLeave(ctx: Ctx, i: { leaveId: string; expectedVersion: number; reason: string }) {
  const l = await loadLeave(ctx.db, i.leaveId, i.expectedVersion);
  const e = await loadEmployee(ctx.db, l.employee_id, true);
  const own = e.user_id === ctx.actor.id || l.applied_by === ctx.actor.id;
  if (!own && !(await can(ctx.db, ctx.actor.id, 'hr.leave.approve.any', { siteId: e.site_id }))) throw forbidden('Only the applicant or HR can cancel a leave request');
  if (!i.reason) throw badRequest('A reason is required');
  if (!['pending', 'approved'].includes(l.status)) throw invalidState(`This request is already ${l.status}`);
  if (l.status === 'approved') {
    if (l.from_date <= today() && !(await can(ctx.db, ctx.actor.id, 'hr.leave.approve.any', { siteId: e.site_id }))) throw invalidState('Leave that has started can only be cancelled by HR');
    const locked = await ctx.db.query('SELECT 1 FROM attendance WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3 AND locked LIMIT 1', [e.id, l.from_date, l.to_date]);
    if (locked.rowCount) throw invalidState('Payroll for part of this period is already approved');
    await ctx.db.query(`INSERT INTO leave_ledger(employee_id, leave_type, delta, kind, year, request_id, reason, actor_id) VALUES ($1,$2,$3,'reversal',$4,$5,$6,$7)`,
      [e.id, l.leave_type, l.days, parse(l.from_date).getUTCFullYear(), l.id, `Cancelled ${l.number}`, ctx.actor.id]);
    await ctx.db.query(`DELETE FROM attendance WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3 AND source='leave'`, [e.id, l.from_date, l.to_date]);
    await ctx.db.query(`UPDATE attendance SET status='P', note=NULL WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3 AND status='H' AND note LIKE $4`, [e.id, l.from_date, l.to_date, `%${l.number}`]);
  }
  await ctx.db.query(`UPDATE leave_request SET status='cancelled', decision_note=$2, version=version+1 WHERE id=$1`, [l.id, i.reason]);
  await audit(ctx, { action: 'hr.leave.cancel', entityType: 'leave_request', entityId: l.id, before: { status: l.status }, reason: i.reason });
  return { id: l.id, status: 'cancelled' };
}

export async function listLeave(db: Db, userId: string, scope: 'mine' | 'team' | 'all' = 'mine') {
  const mine = await myEmployee(db, userId);
  const sites = await visibleSites(db, userId, 'hr.leave.view');
  const wide = scope === 'all' && (sites === null || sites.length > 0);
  const team = scope === 'team';
  return (await db.query(
    `SELECT l.id, l.number, l.status, l.version, l.leave_type, l.from_date, l.to_date, l.days, l.half_day, l.reason, l.decision_note, l.created_at, l.applied_by,
            e.code AS employee_code, e.name AS employee, e.id AS employee_id, du.username AS decided_by
       FROM leave_request l JOIN employee e ON e.id = l.employee_id LEFT JOIN app_user du ON du.id = l.decided_by
      WHERE ($4 AND ($2::uuid[] IS NULL OR e.site_id = ANY($2::uuid[]))) OR ($5 AND e.manager_id = $3) OR e.user_id = $1
      ORDER BY (l.status = 'pending') DESC, l.from_date DESC LIMIT 200`, [userId, sites, mine?.id ?? null, wide, team])).rows;
}

// ───────────────────────── salary & payroll ─────────────────────────
export async function proposeSalary(ctx: Ctx, i: { employeeId: string; effectiveFrom: string; basic: string; hra?: string; otherAllowance?: string }) {
  const e = await loadEmployee(ctx.db, i.employeeId);
  await assertCan(ctx.db, ctx.actor.id, 'hr.salary.propose', { siteId: e.site_id });
  parse(i.effectiveFrom);
  if (e.user_id === ctx.actor.id) throw forbidden('Separation of duties: you cannot propose your own salary');
  if (toPaise(i.basic) <= 0n) throw badRequest('Basic pay must be above zero');
  const r = await ctx.db.query(`INSERT INTO salary_structure(employee_id, effective_from, basic, hra, other_allowance, proposed_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [e.id, i.effectiveFrom, i.basic, i.hra ?? '0', i.otherAllowance ?? '0', ctx.actor.id]);
  await audit(ctx, { action: 'hr.salary.propose', entityType: 'salary_structure', entityId: r.rows[0].id, after: { employee: e.code, ...i } });
  return r.rows[0];
}

export async function decideSalary(ctx: Ctx, i: { salaryId: string; approve: boolean }) {
  const s = (await ctx.db.query('SELECT * FROM salary_structure WHERE id=$1 FOR UPDATE', [i.salaryId])).rows[0];
  if (!s) throw notFound('Salary structure');
  const e = await loadEmployee(ctx.db, s.employee_id);
  if (!ctx.override) await assertCan(ctx.db, ctx.actor.id, 'hr.salary.approve', { siteId: e.site_id });
  if (!ctx.override) assertIndependent(ctx.actor.id, s.proposed_by, 'salary change');
  if (e.user_id === ctx.actor.id) throw forbidden('Separation of duties: you cannot approve your own salary');
  if (s.status !== 'proposed') throw invalidState(`Already ${s.status}`);
  if (i.approve) {
    // pay already finalised for a period cannot be re-priced retroactively
    const final = await ctx.db.query(`SELECT 1 FROM attendance WHERE employee_id=$1 AND locked AND work_date >= $2 LIMIT 1`, [e.id, s.effective_from]);
    if (final.rowCount) throw invalidState('Payroll from that date is already approved. Use a later effective date');
    await ctx.db.query(`UPDATE salary_structure SET status='superseded' WHERE employee_id=$1 AND status='approved' AND effective_from <= $2`, [e.id, s.effective_from]);
  }
  await ctx.db.query('UPDATE salary_structure SET status=$2, approved_by=$3 WHERE id=$1', [s.id, i.approve ? 'approved' : 'rejected', ctx.actor.id]);
  await audit(ctx, { action: i.approve ? 'hr.salary.approve' : 'hr.salary.reject', entityType: 'salary_structure', entityId: s.id });
  return { id: s.id, status: i.approve ? 'approved' : 'rejected' };
}

export async function listSalary(db: Db, userId: string) {
  const sites = await visibleSites(db, userId, 'hr.salary.view');
  if (sites && !sites.length) return null;
  return (await db.query(
    `SELECT s.id, s.status, s.effective_from, s.basic, s.hra, s.other_allowance, e.code, e.name, pu.username AS proposed_by, au.username AS approved_by
       FROM salary_structure s JOIN employee e ON e.id = s.employee_id JOIN app_user pu ON pu.id = s.proposed_by LEFT JOIN app_user au ON au.id = s.approved_by
      WHERE ($1::uuid[] IS NULL OR e.site_id = ANY($1::uuid[])) ORDER BY e.code, s.effective_from DESC`, [sites])).rows;
}

function computeSlip(emp: { pf_applicable: boolean; esi_applicable: boolean }, sal: { basic: string; hra: string; other_allowance: string }, dim: number, paidHalves: number, otMin: number) {
  const D2 = BigInt(dim * 2), P = BigInt(paidHalves);
  const part = (v: string) => divRound(toPaise(v) * P, D2);
  const basic = part(sal.basic), hra = part(sal.hra), other = part(sal.other_allowance);
  const R = PAYROLL_RULES;
  const hourly = divRound(toPaise(sal.basic) * R.otMultiplier, BigInt(dim) * R.hoursPerDay);       // double rate on basic
  const ot = divRound(hourly * BigInt(otMin), 60n);
  const gross = basic + hra + other + ot;
  const pfWage = basic < R.pfWageCap ? basic : R.pfWageCap;
  const pf = emp.pf_applicable ? divRound(pfWage * R.pfRatePct, 100n) : 0n;
  const esiOn = emp.esi_applicable && gross > 0n && gross <= R.esiGrossLimit;
  const esi = esiOn ? divCeil(gross * R.esiEmployeeBp, 10000n) : 0n;
  const esiEr = esiOn ? divCeil(gross * R.esiEmployerBp, 10000n) : 0n;
  const pt = gross >= R.ptThreshold ? R.ptAmount : 0n;
  const ded = pf + esi + pt;
  return { basic, hra, other, ot, gross, pf, esi, esiEr, pfEr: pf, pt, ded, net: gross - ded };
}

async function buildPayslips(db: Db, run: { id: string; site_id: string; period: string }) {
  const from = run.period, to = monthEnd(from), dim = +to.slice(8);
  const emps = (await db.query(
    `SELECT * FROM employee WHERE site_id=$1 AND join_date <= $3 AND (exit_date IS NULL OR exit_date >= $2) ORDER BY code`, [run.site_id, from, to])).rows;
  const warnings: string[] = [];
  const slips: { employee_id: string; s: ReturnType<typeof computeSlip>; paid: number; lop: number; otMin: number }[] = [];
  for (const e of emps) {
    const sal = (await db.query(`SELECT * FROM salary_structure WHERE employee_id=$1 AND status='approved' AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1`, [e.id, to])).rows[0];
    if (!sal) { warnings.push(`${e.code} ${e.name}: no approved salary structure, left out of this run`); continue; }
    const start = e.join_date > from ? e.join_date : from, end = e.exit_date && e.exit_date < to ? e.exit_date : to;
    const rows = new Map((await db.query('SELECT work_date, status, ot_min FROM attendance WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3', [e.id, start, end])).rows.map((r) => [r.work_date as string, r]));
    let halves = 0, otMin = 0, unmarked = 0;
    for (const d of eachDay(start, end)) {
      const r = rows.get(d);
      if (!r) { unmarked++; continue; }
      halves += { P: 2, H: 1, L: 2, WO: 2, HOL: 2, A: 0, LWP: 0 }[r.status as 'P'] ?? 0;
      otMin += r.ot_min;
    }
    if (unmarked) throw invalidState(`${e.code} ${e.name} has ${unmarked} day(s) without attendance. Mark or fill them first`);
    const s = computeSlip(e, sal, dim, halves, otMin);
    slips.push({ employee_id: e.id, s, paid: halves / 2, lop: dim - halves / 2, otMin });
  }
  return { slips, warnings, dim };
}

async function writeSlips(db: Db, run: { id: string; site_id: string; period: string }) {
  const { slips, warnings, dim } = await buildPayslips(db, run);
  await db.query('DELETE FROM payslip WHERE run_id=$1', [run.id]);
  let gross = 0n, net = 0n;
  for (const { employee_id, s, paid, lop, otMin } of slips) {
    await db.query(
      `INSERT INTO payslip(run_id, employee_id, days_in_month, paid_days, lop_days, ot_hours, basic, hra, other_allowance, ot_amount, gross, pf_employee, esi_employee, prof_tax, total_deductions, net, pf_employer, esi_employer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [run.id, employee_id, dim, paid, lop, (otMin / 60).toFixed(2), fromPaise(s.basic), fromPaise(s.hra), fromPaise(s.other), fromPaise(s.ot), fromPaise(s.gross),
       fromPaise(s.pf), fromPaise(s.esi), fromPaise(s.pt), fromPaise(s.ded), fromPaise(s.net), fromPaise(s.pfEr), fromPaise(s.esiEr)]);
    gross += s.gross; net += s.net;
  }
  if (!slips.length) throw invalidState('No employee has an approved salary structure for this month');
  await db.query('UPDATE payroll_run SET total_gross=$2, total_net=$3, warnings=$4 WHERE id=$1', [run.id, fromPaise(gross), fromPaise(net), JSON.stringify(warnings)]);
  return { count: slips.length, gross: fromPaise(gross), net: fromPaise(net), warnings };
}

export async function createPayrollRun(ctx: Ctx, i: { siteId: string; period: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'hr.payroll.create', { siteId: i.siteId });
  const period = monthStart(i.period);
  if (monthEnd(period) >= today()) throw invalidState('That month has not ended yet. Payroll runs on a completed month');
  const dup = await ctx.db.query(`SELECT number FROM payroll_run WHERE site_id=$1 AND period=$2 AND status <> 'cancelled'`, [i.siteId, period]);
  if (dup.rowCount) throw invalidState(`${dup.rows[0].number} already exists for this month`);
  const number = await nextNumber(ctx, i.siteId, 'PR');
  const run = (await ctx.db.query(`INSERT INTO payroll_run(number, site_id, period, created_by) VALUES ($1,$2,$3,$4) RETURNING *`, [number, i.siteId, period, ctx.actor.id])).rows[0];
  const t = await writeSlips(ctx.db, run);
  await audit(ctx, { action: 'hr.payroll.create', entityType: 'payroll_run', entityId: run.id, after: { number, period, ...t } });
  return { ...run, ...t };
}

export async function recalculatePayrollRun(ctx: Ctx, i: { runId: string; expectedVersion: number }) {
  const run = (await ctx.db.query('SELECT * FROM payroll_run WHERE id=$1 FOR UPDATE', [i.runId])).rows[0];
  if (!run) throw notFound('Payroll run');
  await assertCan(ctx.db, ctx.actor.id, 'hr.payroll.create', { siteId: run.site_id });
  if (run.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, run.version);
  if (run.status !== 'draft') throw invalidState('Only a draft run can be recalculated');
  const t = await writeSlips(ctx.db, run);
  await ctx.db.query('UPDATE payroll_run SET version=version+1 WHERE id=$1', [run.id]);
  await audit(ctx, { action: 'hr.payroll.recalculate', entityType: 'payroll_run', entityId: run.id, after: t });
  return t;
}

export async function approvePayrollRun(ctx: Ctx, i: { runId: string; expectedVersion: number }) {
  const run = (await ctx.db.query('SELECT * FROM payroll_run WHERE id=$1 FOR UPDATE', [i.runId])).rows[0];
  if (!run) throw notFound('Payroll run');
  if (!ctx.override) { await assertCan(ctx.db, ctx.actor.id, 'hr.payroll.approve', { siteId: run.site_id });
  assertIndependent(ctx.actor.id, run.created_by, 'payroll run'); }
  if (run.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, run.version);
  if (run.status !== 'draft') throw invalidState(`This run is ${run.status}`);
  // Re-price from live data so approval is of what the sheets say today, not of a stale draft
  const fresh = await buildPayslips(ctx.db, run);
  const stored = (await ctx.db.query('SELECT employee_id, net FROM payslip WHERE run_id=$1', [run.id])).rows;
  const drift = fresh.slips.length !== stored.length || fresh.slips.some((x) => { const s = stored.find((r) => r.employee_id === x.employee_id); return !s || toPaise(s.net) !== x.s.net; });
  if (drift) throw invalidState('Attendance, leave or salary changed after this draft was calculated. Recalculate and review it again');
  const end = monthEnd(run.period);
  await ctx.db.query(`UPDATE attendance SET locked=true WHERE work_date BETWEEN $2 AND $3 AND employee_id IN (SELECT employee_id FROM payslip WHERE run_id=$1)`, [run.id, run.period, end]);
  await ctx.db.query(`UPDATE payroll_run SET status='approved', approved_by=$2, version=version+1 WHERE id=$1`, [run.id, ctx.actor.id]);
  await audit(ctx, { action: 'hr.payroll.approve', entityType: 'payroll_run', entityId: run.id, after: { number: run.number, gross: run.total_gross, net: run.total_net } });
  await emit(ctx, { type: 'payroll.approved', entityType: 'payroll_run', entityId: run.id, siteId: run.site_id, payload: { number: run.number, period: run.period, net: run.total_net } });
  return { id: run.id, status: 'approved' };
}

export async function cancelPayrollRun(ctx: Ctx, i: { runId: string; expectedVersion: number; reason: string }) {
  const run = (await ctx.db.query('SELECT * FROM payroll_run WHERE id=$1 FOR UPDATE', [i.runId])).rows[0];
  if (!run) throw notFound('Payroll run');
  if (!ctx.override) await assertCan(ctx.db, ctx.actor.id, 'hr.payroll.create', { siteId: run.site_id });
  if (run.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, run.version);
  if (run.status !== 'draft') throw invalidState('An approved run is final');
  if (!i.reason) throw badRequest('A reason is required');
  await ctx.db.query('DELETE FROM payslip WHERE run_id=$1', [run.id]);
  await ctx.db.query(`UPDATE payroll_run SET status='cancelled', version=version+1 WHERE id=$1`, [run.id]);
  await audit(ctx, { action: 'hr.payroll.cancel', entityType: 'payroll_run', entityId: run.id, reason: i.reason });
  return { id: run.id };
}

export async function listPayrollRuns(db: Db, userId: string) {
  const sites = await visibleSites(db, userId, 'hr.payroll.view');
  if (sites && !sites.length) return null;
  return (await db.query(
    `SELECT r.id, r.number, r.period, r.status, r.total_gross, r.total_net, r.warnings, r.version, s.code AS site, cu.username AS created_by, au.username AS approved_by,
            (SELECT count(*)::int FROM payslip p WHERE p.run_id = r.id) AS slips
       FROM payroll_run r JOIN site s ON s.id = r.site_id JOIN app_user cu ON cu.id = r.created_by LEFT JOIN app_user au ON au.id = r.approved_by
      WHERE r.status <> 'cancelled' AND ($1::uuid[] IS NULL OR r.site_id = ANY($1::uuid[])) ORDER BY r.period DESC`, [sites])).rows;
}

/** HR/finance see a whole run; everyone else sees only their own slips from approved runs. */
export async function listPayslips(db: Db, userId: string, runId?: string) {
  const sites = await visibleSites(db, userId, 'hr.payroll.view');
  const mine = await myEmployee(db, userId);
  return (await db.query(
    `SELECT p.*, e.code, e.name, r.number AS run_number, r.period, r.status AS run_status
       FROM payslip p JOIN employee e ON e.id = p.employee_id JOIN payroll_run r ON r.id = p.run_id
      WHERE ($3::uuid IS NULL OR p.run_id = $3)
        AND ((($1::uuid[] IS NULL OR e.site_id = ANY($1::uuid[])) AND ($1::uuid[] IS NULL OR cardinality($1::uuid[]) > 0))
             OR (e.id = $2 AND r.status = 'approved'))
      ORDER BY r.period DESC, e.code`, [sites, mine?.id ?? null, runId ?? null])).rows;
}

export async function myEmployeeRecord(db: Db, userId: string) { return myEmployee(db, userId); }
