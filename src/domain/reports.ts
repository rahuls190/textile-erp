import type { Db } from '../db/pool.js';
import { can, visibleSites } from '../core/permissions.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import * as q from './queries.js';
import * as owner from './owner.js';

/**
 * Reports. A report is a read-only question with a fixed shape: it is shown only to people holding its permission,
 * every query is limited to the sites that person may see (scope is applied in SQL, not in the screen), and every run
 * is written to the audit log (who, which report, which filters, how many rows) so sensitive figures can be traced.
 */
export type ColKind = 'text' | 'num' | 'money' | 'date' | 'pct';
export interface Column { key: string; label: string; kind: ColKind }
export interface ParamDef { key: string; label: string; kind: 'date' | 'month' | 'year'; default?: 'ago90' | 'today' | 'this_month' | 'last_month' | 'this_year' }
export interface ReportResult {
  columns: Column[];
  rows: Record<string, string | number | null>[];
  summary: { label: string; value: string }[];
  chart?: { title: string; labelKey: string; valueKey: string; unit?: string };
  note?: string;
}
interface Def {
  key: string; title: string; group: 'Buying & stock' | 'People' | 'Control'; description: string; permission: string; sensitive?: boolean;
  /** true = reads one company-wide table, no site filter possible */
  companyWide?: boolean;
  params: ParamDef[];
  run: (db: Db, userId: string, sites: string[] | null, p: Record<string, string>) => Promise<ReportResult>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/, MONTH = /^\d{4}-(0[1-9]|1[0-2])$/, YEAR = /^\d{4}$/;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const r2 = (n: number) => Math.round(n * 100) / 100;
const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const pct = (a: number, b: number) => (b > 0 ? r2((a / b) * 100) : 0);

function cleanParams(def: Def, raw: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of def.params) {
    let v = raw[d.key];
    if (v === undefined || v === null || v === '') {
      const now = new Date();
      const y = now.getUTCFullYear(), m = String(now.getUTCMonth() + 1).padStart(2, '0');
      v = d.default === 'today' ? now.toISOString().slice(0, 10)
        : d.default === 'ago90' ? new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10)
        : d.default === 'this_month' ? `${y}-${m}`
        : d.default === 'last_month' ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
        : d.default === 'this_year' ? String(y) : '';
    }
    const s = String(v);
    const ok = d.kind === 'date' ? DATE.test(s) && !Number.isNaN(Date.parse(s)) : d.kind === 'month' ? MONTH.test(s) : YEAR.test(s);
    if (!ok) throw badRequest(`${d.label} is not valid (${d.kind === 'date' ? 'use YYYY-MM-DD' : d.kind === 'month' ? 'use YYYY-MM' : 'use a 4-digit year'})`);
    out[d.key] = s;
  }
  if (out.from && out.to && out.from > out.to) throw badRequest('"From" must not be after "To"');
  return out;
}

const dateRange: ParamDef[] = [
  { key: 'from', label: 'From', kind: 'date', default: 'ago90' },
  { key: 'to', label: 'To', kind: 'date', default: 'today' },
];

const REPORTS: Def[] = [
  {
    key: 'purchase-register', title: 'Purchase register', group: 'Buying & stock', permission: 'po.view', params: dateRange,
    description: 'Every purchase order raised in the period with vendor, status and value.',
    async run(db, _u, sites, p) {
      const rows = (await db.query(
        `SELECT po.number, to_char(po.created_at,'YYYY-MM-DD') AS date, s.code AS site, pt.name AS vendor, po.status, po.total::float8 AS total
           FROM purchase_order po JOIN partner pt ON pt.id = po.partner_id JOIN site s ON s.id = po.site_id
          WHERE ($1::uuid[] IS NULL OR po.site_id = ANY($1::uuid[])) AND po.created_at::date BETWEEN $2::date AND $3::date
          ORDER BY po.created_at, po.number`, [sites, p.from, p.to])).rows;
      const active = rows.filter((x) => !['cancelled', 'draft'].includes(String(x.status)));
      const byVendor = new Map<string, number>();
      for (const x of active) byVendor.set(x.vendor, (byVendor.get(x.vendor) ?? 0) + num(x.total));
      const top = [...byVendor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([vendor, total]) => ({ vendor, total: r2(total) }));
      return {
        columns: [{ key: 'number', label: 'PO', kind: 'text' }, { key: 'date', label: 'Date', kind: 'date' }, { key: 'site', label: 'Site', kind: 'text' },
          { key: 'vendor', label: 'Vendor', kind: 'text' }, { key: 'status', label: 'Status', kind: 'text' }, { key: 'total', label: 'Value', kind: 'money' }],
        rows,
        summary: [{ label: 'Orders', value: String(rows.length) }, { label: 'Value (excl. draft & cancelled)', value: inr(active.reduce((s, x) => s + num(x.total), 0)) },
          { label: 'Still to approve', value: String(rows.filter((x) => x.status === 'approval_pending').length) }],
        chart: top.length ? { title: 'Value by vendor', labelKey: 'vendor', valueKey: 'total', unit: '₹' } : undefined,
        note: top.length ? undefined : 'No orders in this period.',
        ...(top.length ? { chartRows: top } : {}),
      } as ReportResult;
    },
  },
  {
    key: 'vendor-performance', title: 'Vendor performance', group: 'Buying & stock', permission: 'receipt.view', params: dateRange,
    description: 'Per vendor: ordered, received, accepted and rejected metres on orders raised in the period, with the rejection rate.',
    async run(db, _u, sites, p) {
      const raw = (await db.query(
        `SELECT pt.name AS vendor, count(DISTINCT po.id)::int AS orders, sum(l.qty)::float8 AS ordered, sum(l.received_qty)::float8 AS received,
                sum(l.accepted_qty)::float8 AS accepted, sum(l.rejected_qty)::float8 AS rejected
           FROM purchase_order po JOIN po_line l ON l.po_id = po.id JOIN partner pt ON pt.id = po.partner_id
          WHERE po.status NOT IN ('draft','cancelled') AND ($1::uuid[] IS NULL OR po.site_id = ANY($1::uuid[])) AND po.created_at::date BETWEEN $2::date AND $3::date
          GROUP BY pt.name ORDER BY pt.name`, [sites, p.from, p.to])).rows;
      const rows = raw.map((x) => ({ ...x, fill_pct: pct(num(x.received), num(x.ordered)), reject_pct: pct(num(x.rejected), num(x.received)) }));
      const rc = rows.reduce((s, x) => s + num(x.received), 0), rj = rows.reduce((s, x) => s + num(x.rejected), 0);
      return {
        columns: [{ key: 'vendor', label: 'Vendor', kind: 'text' }, { key: 'orders', label: 'Orders', kind: 'num' }, { key: 'ordered', label: 'Ordered', kind: 'num' },
          { key: 'received', label: 'Received', kind: 'num' }, { key: 'accepted', label: 'Accepted', kind: 'num' }, { key: 'rejected', label: 'Rejected', kind: 'num' },
          { key: 'fill_pct', label: 'Delivered', kind: 'pct' }, { key: 'reject_pct', label: 'Rejection', kind: 'pct' }],
        rows,
        summary: [{ label: 'Vendors', value: String(rows.length) }, { label: 'Received (m)', value: fmt(rc) }, { label: 'Overall rejection', value: pct(rj, rc) + '%' }],
        chart: rows.length ? { title: 'Rejection rate by vendor', labelKey: 'vendor', valueKey: 'reject_pct', unit: '%' } : undefined,
      };
    },
  },
  {
    key: 'stock-position', title: 'Stock position', group: 'Buying & stock', permission: 'inventory.view', params: [],
    description: 'Stock by item right now: on hold, rejected, accepted, reserved and available to use. Derived from the ledger.',
    async run(db, userId) {
      const lots = await q.stockSummary(db, userId);
      const by = new Map<string, Record<string, number | string>>();
      for (const l of lots) {
        const k = String(l.item_code);
        const r = by.get(k) ?? { item: `${l.item_code} · ${l.item_name}`, unit: l.unit, lots: 0, held: 0, rejected: 0, accepted: 0, reserved: 0, available: 0 };
        r.lots = num(r.lots) + 1;
        for (const f of ['held', 'rejected', 'accepted', 'reserved', 'available'] as const) r[f] = r2(num(r[f]) + num(l[f]));
        by.set(k, r);
      }
      const rows = [...by.values()];
      const sum = (f: string) => rows.reduce((s, x) => s + num(x[f]), 0);
      return {
        columns: [{ key: 'item', label: 'Item', kind: 'text' }, { key: 'unit', label: 'Unit', kind: 'text' }, { key: 'lots', label: 'Lots', kind: 'num' },
          { key: 'held', label: 'On QC hold', kind: 'num' }, { key: 'rejected', label: 'Rejected', kind: 'num' }, { key: 'accepted', label: 'Accepted', kind: 'num' },
          { key: 'reserved', label: 'Reserved', kind: 'num' }, { key: 'available', label: 'Available', kind: 'num' }],
        rows,
        summary: [{ label: 'Accepted', value: fmt(sum('accepted')) }, { label: 'Available', value: fmt(sum('available')) }, { label: 'On hold', value: fmt(sum('held')) }, { label: 'Rejected', value: fmt(sum('rejected')) }],
        chart: rows.length ? { title: 'Available by item', labelKey: 'item', valueKey: 'available' } : undefined,
        note: 'Lists the 500 most recent lots.',
      };
    },
  },
  {
    key: 'quality-summary', title: 'Quality summary', group: 'Buying & stock', permission: 'qc.view', params: dateRange,
    description: 'Inspections raised in the period by outcome, with accepted and rejected quantity.',
    async run(db, _u, sites, p) {
      const rows = (await db.query(
        `SELECT status, count(*)::int AS inspections, COALESCE(sum(inspected_qty),0)::float8 AS sampled, COALESCE(sum(accepted_qty),0)::float8 AS accepted, COALESCE(sum(rejected_qty),0)::float8 AS rejected
           FROM qc_inspection WHERE ($1::uuid[] IS NULL OR site_id = ANY($1::uuid[])) AND created_at::date BETWEEN $2::date AND $3::date
          GROUP BY status ORDER BY status`, [sites, p.from, p.to])).rows;
      const a = rows.reduce((s, x) => s + num(x.accepted), 0), r = rows.reduce((s, x) => s + num(x.rejected), 0);
      return {
        columns: [{ key: 'status', label: 'Outcome', kind: 'text' }, { key: 'inspections', label: 'Inspections', kind: 'num' }, { key: 'sampled', label: 'Sampled (m)', kind: 'num' },
          { key: 'accepted', label: 'Accepted (m)', kind: 'num' }, { key: 'rejected', label: 'Rejected (m)', kind: 'num' }],
        rows,
        summary: [{ label: 'Inspections', value: String(rows.reduce((s, x) => s + num(x.inspections), 0)) }, { label: 'Accepted (m)', value: fmt(a) }, { label: 'Rejected (m)', value: fmt(r) }, { label: 'Rejection', value: pct(r, a + r) + '%' }],
        chart: rows.length ? { title: 'Inspections by outcome', labelKey: 'status', valueKey: 'inspections' } : undefined,
      };
    },
  },
  {
    key: 'approvals-aging', title: 'Approvals waiting', group: 'Control', permission: 'escalation.view', params: [],
    description: 'Everything awaiting an approval that you are allowed to see, oldest first, with how far past its limit it is.',
    async run(db, userId) {
      const items = await owner.pendingItems(db, userId);
      const rows = items.sort((a, b) => b.age_hours - a.age_hours).map((i) => ({
        type: i.type.replace('_', ' '), number: i.number, title: i.title, age_hours: Math.round(i.age_hours), limit_hours: i.sla_hours, overdue: i.overdue ? 'Yes' : 'No',
        escalation: i.escalation ? `L${i.escalation.level} ${i.escalation.urgency}` : '',
      }));
      return {
        columns: [{ key: 'type', label: 'Type', kind: 'text' }, { key: 'number', label: 'Number', kind: 'text' }, { key: 'title', label: 'Item', kind: 'text' },
          { key: 'age_hours', label: 'Waiting (h)', kind: 'num' }, { key: 'limit_hours', label: 'Limit (h)', kind: 'num' }, { key: 'overdue', label: 'Past limit', kind: 'text' }, { key: 'escalation', label: 'Escalation', kind: 'text' }],
        rows,
        summary: [{ label: 'Waiting', value: String(rows.length) }, { label: 'Past limit', value: String(rows.filter((x) => x.overdue === 'Yes').length) }, { label: 'Escalated', value: String(rows.filter((x) => x.escalation).length) }],
        chart: rows.length ? { title: 'Hours waiting', labelKey: 'number', valueKey: 'age_hours', unit: 'h' } : undefined,
      };
    },
  },
  {
    key: 'headcount', title: 'Headcount', group: 'People', permission: 'hr.employee.view', params: [],
    description: 'Active employees by department and employment type, plus those who left.',
    async run(db, _u, sites) {
      const rows = (await db.query(
        `SELECT COALESCE(d.name,'(none)') AS department,
                count(*) FILTER (WHERE e.status='active' AND e.emp_type='permanent')::int AS permanent,
                count(*) FILTER (WHERE e.status='active' AND e.emp_type='contract')::int AS contract,
                count(*) FILTER (WHERE e.status='active' AND e.emp_type='daily')::int AS daily,
                count(*) FILTER (WHERE e.status='active')::int AS active,
                count(*) FILTER (WHERE e.status='exited')::int AS exited
           FROM employee e LEFT JOIN department d ON d.id = e.department_id WHERE ($1::uuid[] IS NULL OR e.site_id = ANY($1::uuid[]))
          GROUP BY d.name ORDER BY d.name`, [sites])).rows;
      return {
        columns: [{ key: 'department', label: 'Department', kind: 'text' }, { key: 'permanent', label: 'Permanent', kind: 'num' }, { key: 'contract', label: 'Contract', kind: 'num' },
          { key: 'daily', label: 'Daily wage', kind: 'num' }, { key: 'active', label: 'Active', kind: 'num' }, { key: 'exited', label: 'Left', kind: 'num' }],
        rows,
        summary: [{ label: 'Active', value: String(rows.reduce((s, x) => s + num(x.active), 0)) }, { label: 'Left', value: String(rows.reduce((s, x) => s + num(x.exited), 0)) }],
        chart: rows.length ? { title: 'Active staff by department', labelKey: 'department', valueKey: 'active' } : undefined,
      };
    },
  },
  {
    key: 'attendance-month', title: 'Attendance by month', group: 'People', permission: 'hr.attendance.view', params: [{ key: 'month', label: 'Month', kind: 'month', default: 'this_month' }],
    description: 'Days present, absent, on leave, late minutes and overtime hours for each employee in the month.',
    async run(db, _u, sites, p) {
      const rows = (await db.query(
        `SELECT e.code, e.name, count(*) FILTER (WHERE a.status IN ('P','H'))::float8 AS present, count(*) FILTER (WHERE a.status='A')::int AS absent,
                count(*) FILTER (WHERE a.status IN ('L','LWP'))::int AS leave, COALESCE(sum(a.late_min),0)::int AS late_min, round(COALESCE(sum(a.ot_min),0)/60.0,1)::float8 AS ot_hours
           FROM employee e LEFT JOIN attendance a ON a.employee_id = e.id AND to_char(a.work_date,'YYYY-MM') = $2
          WHERE e.status='active' AND ($1::uuid[] IS NULL OR e.site_id = ANY($1::uuid[]))
          GROUP BY e.id ORDER BY e.code`, [sites, p.month])).rows;
      const sum = (f: string) => rows.reduce((s, x) => s + num(x[f]), 0);
      return {
        columns: [{ key: 'code', label: 'Code', kind: 'text' }, { key: 'name', label: 'Name', kind: 'text' }, { key: 'present', label: 'Present', kind: 'num' }, { key: 'absent', label: 'Absent', kind: 'num' },
          { key: 'leave', label: 'Leave', kind: 'num' }, { key: 'late_min', label: 'Late (min)', kind: 'num' }, { key: 'ot_hours', label: 'Overtime (h)', kind: 'num' }],
        rows,
        summary: [{ label: 'Present days', value: fmt(sum('present')) }, { label: 'Absent days', value: fmt(sum('absent')) }, { label: 'Late minutes', value: fmt(sum('late_min')) }, { label: 'Overtime hours', value: fmt(sum('ot_hours')) }],
        chart: rows.length ? { title: 'Absent days', labelKey: 'name', valueKey: 'absent', unit: 'd' } : undefined,
      };
    },
  },
  {
    key: 'leave-balance', title: 'Leave balances', group: 'People', permission: 'hr.leave.view', params: [{ key: 'year', label: 'Year', kind: 'year', default: 'this_year' }],
    description: 'Each employee’s leave balance by type for the year, from the leave ledger.',
    async run(db, _u, sites, p) {
      const types = (await db.query('SELECT code, name FROM leave_type ORDER BY code')).rows as { code: string; name: string }[];
      const led = (await db.query(
        `SELECT e.id, e.code, e.name, ll.leave_type, sum(ll.delta)::float8 AS bal
           FROM employee e JOIN leave_ledger ll ON ll.employee_id = e.id AND ll.year = $2::int
          WHERE e.status='active' AND ($1::uuid[] IS NULL OR e.site_id = ANY($1::uuid[])) GROUP BY e.id, ll.leave_type ORDER BY e.code`, [sites, p.year])).rows;
      const emps = new Map<string, Record<string, string | number | null>>();
      for (const l of led) {
        const r: Record<string, string | number | null> = emps.get(l.id) ?? { code: l.code, name: l.name };
        r[l.leave_type] = r2(num(l.bal));
        emps.set(l.id, r);
      }
      const rows = [...emps.values()];
      return {
        columns: [{ key: 'code', label: 'Code', kind: 'text' }, { key: 'name', label: 'Name', kind: 'text' }, ...types.map((t) => ({ key: t.code, label: t.name, kind: 'num' as const }))],
        rows,
        summary: [{ label: 'Employees', value: String(rows.length) }, ...types.map((t) => ({ label: t.name + ' (days left)', value: fmt(rows.reduce((s, x) => s + num(x[t.code]), 0)) }))],
        note: rows.length ? undefined : 'No leave has been granted for this year yet.',
      };
    },
  },
  {
    key: 'payroll-register', title: 'Payroll register', group: 'People', permission: 'hr.payroll.view', sensitive: true, params: [{ key: 'month', label: 'Month', kind: 'month', default: 'last_month' }],
    description: 'Payslip lines for the month’s payroll runs: days paid, gross, deductions and net. Sensitive.',
    async run(db, _u, sites, p) {
      const rows = (await db.query(
        `SELECT pr.number AS run, pr.status, e.code, e.name, ps.paid_days::float8 AS paid_days, ps.lop_days::float8 AS lop_days, ps.gross::float8 AS gross,
                ps.total_deductions::float8 AS deductions, ps.net::float8 AS net
           FROM payroll_run pr JOIN payslip ps ON ps.run_id = pr.id JOIN employee e ON e.id = ps.employee_id
          WHERE pr.status <> 'cancelled' AND ($1::uuid[] IS NULL OR pr.site_id = ANY($1::uuid[])) AND to_char(pr.period,'YYYY-MM') = $2
          ORDER BY pr.number, e.code`, [sites, p.month])).rows;
      const sum = (f: string) => rows.reduce((s, x) => s + num(x[f]), 0);
      return {
        columns: [{ key: 'run', label: 'Run', kind: 'text' }, { key: 'status', label: 'Status', kind: 'text' }, { key: 'code', label: 'Code', kind: 'text' }, { key: 'name', label: 'Name', kind: 'text' },
          { key: 'paid_days', label: 'Paid days', kind: 'num' }, { key: 'lop_days', label: 'LOP days', kind: 'num' }, { key: 'gross', label: 'Gross', kind: 'money' },
          { key: 'deductions', label: 'Deductions', kind: 'money' }, { key: 'net', label: 'Net pay', kind: 'money' }],
        rows,
        summary: [{ label: 'Payslips', value: String(rows.length) }, { label: 'Gross', value: inr(sum('gross')) }, { label: 'Deductions', value: inr(sum('deductions')) }, { label: 'Net pay', value: inr(sum('net')) }],
        chart: rows.length ? { title: 'Net pay', labelKey: 'name', valueKey: 'net', unit: '₹' } : undefined,
        note: rows.length ? 'Draft runs are included until approved.' : 'No payroll run exists for this month.',
      };
    },
  },
  {
    key: 'payroll-statutory', title: 'PF / ESI / tax summary', group: 'People', permission: 'hr.payroll.view', sensitive: true,
    params: [{ key: 'from', label: 'From month', kind: 'month', default: 'last_month' }, { key: 'to', label: 'To month', kind: 'month', default: 'this_month' }],
    description: 'Employee and employer PF and ESI and professional tax totals, by month, for approved payroll runs only.',
    async run(db, _u, sites, p) {
      const rows = (await db.query(
        `SELECT to_char(pr.period,'YYYY-MM') AS month, count(DISTINCT pr.id)::int AS runs, sum(ps.pf_employee)::float8 AS pf_employee, sum(ps.pf_employer)::float8 AS pf_employer,
                sum(ps.esi_employee)::float8 AS esi_employee, sum(ps.esi_employer)::float8 AS esi_employer, sum(ps.prof_tax)::float8 AS prof_tax
           FROM payroll_run pr JOIN payslip ps ON ps.run_id = pr.id
          WHERE pr.status = 'approved' AND ($1::uuid[] IS NULL OR pr.site_id = ANY($1::uuid[])) AND to_char(pr.period,'YYYY-MM') BETWEEN $2 AND $3
          GROUP BY 1 ORDER BY 1`, [sites, p.from, p.to])).rows;
      const sum = (f: string) => rows.reduce((s, x) => s + num(x[f]), 0);
      return {
        columns: [{ key: 'month', label: 'Month', kind: 'text' }, { key: 'runs', label: 'Runs', kind: 'num' }, { key: 'pf_employee', label: 'PF (employee)', kind: 'money' }, { key: 'pf_employer', label: 'PF (employer)', kind: 'money' },
          { key: 'esi_employee', label: 'ESI (employee)', kind: 'money' }, { key: 'esi_employer', label: 'ESI (employer)', kind: 'money' }, { key: 'prof_tax', label: 'Professional tax', kind: 'money' }],
        rows,
        summary: [{ label: 'PF total', value: inr(sum('pf_employee') + sum('pf_employer')) }, { label: 'ESI total', value: inr(sum('esi_employee') + sum('esi_employer')) }, { label: 'Professional tax', value: inr(sum('prof_tax')) }],
        note: 'Uses the default statutory rates in the system. Have your accountant confirm them before filing. Income tax (TDS) is not included.',
      };
    },
  },
  {
    key: 'override-log', title: 'Overrides & escalations', group: 'Control', permission: 'owner.view', companyWide: true, params: dateRange,
    description: 'Every owner override with its written reason, and every escalation raised in the period.',
    async run(db, _u, _s, p) {
      const ov = (await db.query(
        `SELECT 'Override' AS kind, to_char(o.at,'YYYY-MM-DD HH24:MI') AS at, o.title AS item, o.decision AS detail, o.reason, u.username AS by
           FROM override_log o JOIN app_user u ON u.id = o.actor_id WHERE o.at::date BETWEEN $1::date AND $2::date`, [p.from, p.to])).rows;
      const es = (await db.query(
        `SELECT 'Escalation' AS kind, to_char(e.raised_at,'YYYY-MM-DD HH24:MI') AS at, e.number || ' · ' || e.entity_type AS item, e.urgency || ' · level ' || e.level || ' · ' || e.status AS detail,
                e.reason, u.username AS by
           FROM escalation e JOIN app_user u ON u.id = e.raised_by WHERE e.raised_at::date BETWEEN $1::date AND $2::date`, [p.from, p.to])).rows;
      const rows = [...ov, ...es].sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return {
        columns: [{ key: 'kind', label: 'Kind', kind: 'text' }, { key: 'at', label: 'When', kind: 'text' }, { key: 'item', label: 'Item', kind: 'text' }, { key: 'detail', label: 'Detail', kind: 'text' },
          { key: 'reason', label: 'Reason', kind: 'text' }, { key: 'by', label: 'By', kind: 'text' }],
        rows,
        summary: [{ label: 'Overrides', value: String(ov.length) }, { label: 'Escalations', value: String(es.length) }],
      };
    },
  },
  {
    key: 'access-review', title: 'Access review', group: 'Control', permission: 'user.view', companyWide: true, params: [],
    description: 'Who can sign in, what roles they hold and where, lock state, and when they last signed in. For periodic access reviews.',
    async run(db) {
      const users = (await db.query(
        `SELECT u.username, u.display_name AS name, CASE WHEN u.active THEN 'Active' ELSE 'Suspended' END AS state, CASE WHEN u.locked_until > now() THEN 'Locked' ELSE '' END AS locked,
                COALESCE(to_char(u.last_login_at,'YYYY-MM-DD HH24:MI'),'never') AS last_login,
                COALESCE((SELECT string_agg(ur.role_key || '@' || COALESCE(s.code,'all sites'), ', ' ORDER BY ur.role_key)
                            FROM user_role ur LEFT JOIN site s ON s.id = ur.site_id
                           WHERE ur.user_id = u.id AND ur.revoked_at IS NULL AND (ur.valid_until IS NULL OR ur.valid_until > now())),'(no roles)') AS roles
           FROM app_user u ORDER BY u.username`)).rows;
      return {
        columns: [{ key: 'username', label: 'User', kind: 'text' }, { key: 'name', label: 'Name', kind: 'text' }, { key: 'state', label: 'State', kind: 'text' }, { key: 'locked', label: 'Lock', kind: 'text' },
          { key: 'last_login', label: 'Last sign-in', kind: 'text' }, { key: 'roles', label: 'Roles', kind: 'text' }],
        rows: users,
        summary: [{ label: 'Users', value: String(users.length) }, { label: 'Active', value: String(users.filter((x) => x.state === 'Active').length) }, { label: 'No roles', value: String(users.filter((x) => x.roles === '(no roles)').length) }],
      };
    },
  },
  {
    key: 'audit-by-actor', title: 'Audit activity', group: 'Control', permission: 'audit.view', companyWide: true, params: dateRange,
    description: 'How many recorded actions each person performed in the period, and what kinds.',
    async run(db, _u, _s, p) {
      const rows = (await db.query(
        `SELECT COALESCE(u.username,'(system)') AS actor, count(*)::int AS actions, count(DISTINCT a.action)::int AS kinds,
                to_char(max(a.at),'YYYY-MM-DD HH24:MI') AS last_action
           FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_id WHERE a.at::date BETWEEN $1::date AND $2::date AND a.action <> 'report.run'
          GROUP BY u.username ORDER BY actions DESC`, [p.from, p.to])).rows;
      return {
        columns: [{ key: 'actor', label: 'Person', kind: 'text' }, { key: 'actions', label: 'Actions', kind: 'num' }, { key: 'kinds', label: 'Kinds of action', kind: 'num' }, { key: 'last_action', label: 'Last action', kind: 'text' }],
        rows,
        summary: [{ label: 'People', value: String(rows.length) }, { label: 'Actions', value: String(rows.reduce((s, x) => s + num(x.actions), 0)) }],
        chart: rows.length ? { title: 'Actions by person', labelKey: 'actor', valueKey: 'actions' } : undefined,
      };
    },
  },
];

/** Reports this person may run. Only what they hold the permission for is listed. */
export async function listReports(db: Db, userId: string) {
  const out = [];
  for (const d of REPORTS) {
    if (await can(db, userId, d.permission, { anySite: true }))
      out.push({ key: d.key, title: d.title, group: d.group, description: d.description, sensitive: !!d.sensitive, params: d.params });
  }
  return out;
}

/** Run one report. Read-only, scoped to the caller's sites, and audited. */
export async function runReport(db: Db, actor: { id: string; username: string }, key: string, raw: Record<string, unknown> = {}) {
  const def = REPORTS.find((r) => r.key === key);
  if (!def) throw notFound('Report');
  if (!(await can(db, actor.id, def.permission, { anySite: true }))) throw forbidden(`Not permitted: ${def.permission}`);
  const params = cleanParams(def, raw);
  const sites = await visibleSites(db, actor.id, def.permission);
  if (def.companyWide && sites !== null) throw forbidden(`This report needs ${def.permission} for the whole company`);
  if (sites && !sites.length) throw forbidden(`Not permitted: ${def.permission}`);
  const res = await def.run(db, actor.id, sites, params);
  // charts: some reports aggregate for the chart separately
  const chartRows = (res as unknown as { chartRows?: Record<string, string | number | null>[] }).chartRows;
  delete (res as unknown as { chartRows?: unknown }).chartRows;
  await db.query(
    `INSERT INTO audit_log(actor_id, action, entity_type, entity_id, after, reason) VALUES ($1,'report.run','report',NULL,$2,NULL)`,
    [actor.id, JSON.stringify({ report: def.key, params, rows: res.rows.length, scope: sites === null ? 'all sites' : `${sites.length} site(s)`, sensitive: !!def.sensitive })]);
  return { key: def.key, title: def.title, sensitive: !!def.sensitive, params, ranAt: new Date().toISOString(), ...res, chartRows: chartRows ?? res.rows };
}

/** Recent report runs, for the audit trail shown to people who may see the audit log. */
export async function recentRuns(db: Db, userId: string, limit = 30) {
  if (!(await can(db, userId, 'audit.view', { anySite: true }))) return null;
  return (await db.query(
    `SELECT to_char(a.at,'YYYY-MM-DD HH24:MI') AS at, u.username AS actor, a.after->>'report' AS report, a.after->'params' AS params, (a.after->>'rows')::int AS rows
       FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_id WHERE a.action = 'report.run' ORDER BY a.id DESC LIMIT $1`, [limit])).rows;
}
