import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { audit } from '../core/audit.js';
import { can, visibleSites } from '../core/permissions.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import type { Column, ReportResult } from './reports.js';

/**
 * Custom reports. People (or the AI assistant) describe a report as a small structured SPEC: which dataset, which columns to group by,
 * which figures to total, which filters. The spec is never SQL. This file is the only place a spec becomes a query, and it can only use
 * the fields listed in DATASETS below, so an AI mistake (or a malicious spec) can never reach a table, column or person the caller may not see:
 * dataset permission is checked, row scope by site is added to every query, and every value is passed as a parameter.
 */
export type Agg = 'sum' | 'count' | 'avg' | 'min' | 'max';
export type Op = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';
export interface Spec {
  dataset: string;
  group: string[];
  measures: { field: string; agg: Agg }[];     // field '*' with agg 'count' = number of rows
  filters: { field: string; op: Op; value: string }[];
  sort?: { key: string; dir: 'asc' | 'desc' };
  limit?: number;
  title?: string;
}
type Kind = 'text' | 'date' | 'num' | 'money';
interface Field { key: string; label: string; kind: Kind; sql: string; words: string[]; measure?: boolean }
interface Dataset {
  key: string; label: string; permission: string; sensitive?: boolean; words: string[];
  from: string; siteCol?: string; where?: string; dateField: string; fields: Field[];
}

const T = (key: string, label: string, sql: string, words: string[] = [], kind: Kind = 'text'): Field => ({ key, label, sql, words: [label.toLowerCase(), ...words], kind });
const M = (key: string, label: string, sql: string, words: string[] = [], kind: Kind = 'num'): Field => ({ key, label, sql, words: [label.toLowerCase(), ...words], kind, measure: true });
const MONTH = (col: string) => `to_char(${col},'YYYY-MM')`;

export const DATASETS: Dataset[] = [
  { key: 'purchase_orders', label: 'Purchase orders', permission: 'po.view', words: ['purchase order', 'purchase', 'orders', 'buying', 'po'],
    from: 'purchase_order po JOIN partner pt ON pt.id = po.partner_id JOIN site s ON s.id = po.site_id', siteCol: 'po.site_id', dateField: 'date',
    fields: [T('number', 'PO number', 'po.number'), T('vendor', 'Vendor', 'pt.name', ['supplier', 'party']), T('site', 'Site', 's.code', ['plant', 'unit']), T('status', 'Status', 'po.status'),
      T('date', 'Date', 'po.created_at::date', ['day'], 'date'), T('month', 'Month', MONTH('po.created_at')), M('total', 'Value', 'po.total', ['amount', 'spend', 'spending', 'purchase value', 'total value', 'cost'], 'money')] },
  { key: 'po_lines', label: 'Ordered items', permission: 'po.view', words: ['ordered item', 'order line', 'po line', 'items ordered', 'item wise', 'material ordered', 'fabric ordered'],
    from: 'po_line l JOIN purchase_order po ON po.id = l.po_id JOIN item i ON i.id = l.item_id JOIN partner pt ON pt.id = po.partner_id', siteCol: 'po.site_id', dateField: 'date',
    where: "po.status NOT IN ('draft','cancelled')",
    fields: [T('item', 'Item', "i.code || ' · ' || i.name", ['fabric', 'material', 'product']), T('vendor', 'Vendor', 'pt.name', ['supplier', 'party']), T('po', 'PO number', 'po.number'), T('status', 'PO status', 'po.status', ['status']),
      T('date', 'Date', 'po.created_at::date', ['day'], 'date'), T('month', 'Month', MONTH('po.created_at')),
      M('qty', 'Ordered qty', 'l.qty', ['ordered', 'quantity', 'metres', 'meters']), M('received', 'Received qty', 'l.received_qty', ['received', 'delivered']),
      M('accepted', 'Accepted qty', 'l.accepted_qty', ['accepted']), M('rejected', 'Rejected qty', 'l.rejected_qty', ['rejected', 'rejection']), M('amount', 'Line value', 'l.qty * l.rate', ['value', 'amount', 'spend'], 'money')] },
  { key: 'sales_orders', label: 'Sales orders', permission: 'so.view', words: ['sales order', 'sale order', 'sales', 'sale', 'sold', 'selling', 'revenue', 'customer', 'customers', 'booked'],
    from: 'sales_order o JOIN partner c ON c.id = o.customer_id JOIN site s ON s.id = o.site_id', siteCol: 'o.site_id', dateField: 'date',
    where: "o.status IN ('confirmed','part_dispatched','dispatched')",
    fields: [T('number', 'SO number', 'o.number'), T('customer', 'Customer', 'c.name', ['buyer', 'party', 'client']), T('site', 'Site', 's.code'), T('status', 'Status', 'o.status'),
      T('date', 'Date', 'o.created_at::date', ['day'], 'date'), T('month', 'Month', MONTH('o.created_at')), T('due', 'Due date', 'o.due_date', ['due', 'delivery'], 'date'), M('total', 'Sales value', 'o.total', ['value', 'amount', 'sales', 'sale', 'revenue', 'turnover', 'total'], 'money')] },
  { key: 'sales_lines', label: 'Items sold', permission: 'so.view', words: ['item sold', 'items sold', 'sold item', 'item wise sales', 'what we sold', 'sales by item', 'product sales', 'quantity sold'],
    from: 'so_line l JOIN sales_order o ON o.id = l.so_id JOIN partner c ON c.id = o.customer_id JOIN item i ON i.id = l.item_id', siteCol: 'o.site_id', dateField: 'date',
    where: "o.status IN ('confirmed','part_dispatched','dispatched')",
    fields: [T('item', 'Item', "i.code || ' · ' || i.name", ['fabric', 'product', 'material']), T('customer', 'Customer', 'c.name', ['buyer', 'party']), T('status', 'Order status', 'o.status', ['status']), T('date', 'Date', 'o.created_at::date', ['day'], 'date'), T('month', 'Month', MONTH('o.created_at')),
      M('qty', 'Ordered qty', 'l.qty', ['ordered', 'quantity', 'metres', 'sold']), M('dispatched', 'Dispatched qty', 'l.dispatched_qty', ['dispatched', 'shipped', 'sent']), M('to_send', 'Qty still to send', 'l.qty - l.dispatched_qty', ['pending', 'to send', 'undelivered']), M('amount', 'Value', 'l.amount', ['value', 'amount', 'revenue', 'sales'], 'money')] },
  { key: 'leads', label: 'CRM leads', permission: 'crm.view', words: ['lead', 'leads', 'crm', 'prospect', 'prospects', 'enquiry', 'enquiries', 'pipeline'],
    from: 'crm_lead l JOIN app_user u ON u.id = l.owner_id', dateField: 'date',
    fields: [T('name', 'Contact', 'l.name', ['person']), T('company', 'Company', "COALESCE(l.company,'(none)')", ['firm']), T('status', 'Stage', 'l.status', ['stage', 'status']), T('source', 'Source', "COALESCE(l.source,'(unknown)')", ['channel', 'origin']), T('owner', 'Owner', 'u.username', ['salesperson', 'executive']),
      T('date', 'Created', 'l.created_at::date', ['day'], 'date'), T('month', 'Month', MONTH('l.created_at')), M('est_value', 'Estimated value', 'l.est_value', ['value', 'worth', 'potential'], 'money')] },
  { key: 'stock_lots', label: 'Stock lots', permission: 'inventory.view', words: ['stock', 'inventory', 'lots', 'rolls', 'warehouse'],
    from: `lot l JOIN item i ON i.id = l.item_id JOIN site s ON s.id = l.site_id LEFT JOIN (SELECT lot_id, sum(qty) FILTER (WHERE status='HOLD') AS held, sum(qty) FILTER (WHERE status='ACCEPTED') AS accepted,
           sum(qty) FILTER (WHERE status='REJECTED') AS rejected FROM stock_ledger GROUP BY lot_id) b ON b.lot_id = l.id`, siteCol: 'l.site_id', dateField: 'date',
    fields: [T('lot', 'Lot', 'l.label'), T('item', 'Item', "i.code || ' · ' || i.name", ['fabric', 'material']), T('site', 'Site', 's.code', ['plant']), T('date', 'Received date', 'l.created_at::date', [], 'date'), T('month', 'Month', MONTH('l.created_at')),
      M('held', 'On QC hold', 'COALESCE(b.held,0)', ['hold', 'held', 'quarantine']), M('accepted', 'Accepted', 'COALESCE(b.accepted,0)', ['accepted', 'usable', 'good']), M('rejected', 'Rejected', 'COALESCE(b.rejected,0)', ['rejected'])] },
  { key: 'qc', label: 'Quality inspections', permission: 'qc.view', words: ['quality', 'inspection', 'qc', 'inspections'],
    from: 'qc_inspection qi JOIN lot l ON l.id = qi.lot_id JOIN item i ON i.id = l.item_id JOIN site s ON s.id = qi.site_id', siteCol: 'qi.site_id', dateField: 'date',
    fields: [T('status', 'Outcome', 'qi.status', ['result', 'status']), T('item', 'Item', "i.code || ' · ' || i.name", ['fabric', 'material']), T('site', 'Site', 's.code'), T('date', 'Date', 'qi.created_at::date', [], 'date'), T('month', 'Month', MONTH('qi.created_at')),
      M('sampled', 'Sampled qty', 'qi.inspected_qty', ['sampled', 'inspected']), M('accepted', 'Accepted qty', 'qi.accepted_qty', ['accepted']), M('rejected', 'Rejected qty', 'qi.rejected_qty', ['rejected', 'rejection'])] },
  { key: 'employees', label: 'Employees', permission: 'hr.employee.view', words: ['employee', 'employees', 'staff', 'headcount', 'workers', 'people', 'manpower'],
    from: 'employee e LEFT JOIN department d ON d.id = e.department_id LEFT JOIN designation dg ON dg.id = e.designation_id JOIN site s ON s.id = e.site_id', siteCol: 'e.site_id', dateField: 'joined',
    fields: [T('name', 'Name', 'e.name', ['employee']), T('code', 'Code', 'e.code'), T('department', 'Department', "COALESCE(d.name,'(none)')", ['dept']), T('designation', 'Designation', "COALESCE(dg.name,'(none)')", ['role', 'title']),
      T('type', 'Employment type', 'e.emp_type', ['type', 'permanent', 'contract']), T('status', 'Status', 'e.status', ['active', 'exited', 'left']), T('site', 'Site', 's.code'), T('joined', 'Join date', 'e.join_date', ['joined', 'joining'], 'date'), T('join_month', 'Join month', MONTH('e.join_date'))] },
  { key: 'attendance', label: 'Attendance', permission: 'hr.attendance.view', words: ['attendance', 'present', 'absent', 'late', 'overtime', 'punctuality'],
    from: 'attendance a JOIN employee e ON e.id = a.employee_id LEFT JOIN department d ON d.id = e.department_id JOIN site s ON s.id = e.site_id', siteCol: 'e.site_id', dateField: 'date',
    fields: [T('employee', 'Employee', 'e.name', ['name', 'person']), T('department', 'Department', "COALESCE(d.name,'(none)')", ['dept']), T('status', 'Mark', 'a.status', ['mark', 'status']), T('date', 'Date', 'a.work_date', ['day'], 'date'), T('month', 'Month', MONTH('a.work_date')), T('site', 'Site', 's.code'),
      M('worked_min', 'Worked minutes', 'a.worked_min', ['worked', 'hours worked']), M('late_min', 'Late minutes', 'a.late_min', ['late', 'lateness', 'delay']), M('ot_min', 'Overtime minutes', 'a.ot_min', ['overtime', 'ot'])] },
  { key: 'leave', label: 'Leave requests', permission: 'hr.leave.view', words: ['leave', 'leaves', 'holiday', 'time off'],
    from: 'leave_request lr JOIN employee e ON e.id = lr.employee_id LEFT JOIN department d ON d.id = e.department_id JOIN leave_type lt ON lt.code = lr.leave_type JOIN site s ON s.id = e.site_id', siteCol: 'e.site_id', dateField: 'date',
    fields: [T('employee', 'Employee', 'e.name', ['name', 'person']), T('department', 'Department', "COALESCE(d.name,'(none)')", ['dept']), T('type', 'Leave type', 'lt.name', ['type']), T('status', 'Status', 'lr.status'),
      T('date', 'From date', 'lr.from_date', ['day'], 'date'), T('month', 'Month', MONTH('lr.from_date')), T('site', 'Site', 's.code'), M('days', 'Days', 'lr.days', ['days'])] },
  { key: 'payslips', label: 'Payslips', permission: 'hr.payroll.view', sensitive: true, words: ['payslip', 'payroll', 'salary', 'salaries', 'wages', 'pay'],
    from: 'payslip ps JOIN payroll_run pr ON pr.id = ps.run_id JOIN employee e ON e.id = ps.employee_id LEFT JOIN department d ON d.id = e.department_id JOIN site s ON s.id = pr.site_id', siteCol: 'pr.site_id', dateField: 'period',
    where: "pr.status <> 'cancelled'",
    fields: [T('employee', 'Employee', 'e.name', ['name', 'person']), T('department', 'Department', "COALESCE(d.name,'(none)')", ['dept']), T('month', 'Month', MONTH('pr.period')), T('period', 'Period start', 'pr.period', [], 'date'), T('run_status', 'Run status', 'pr.status', ['status']), T('site', 'Site', 's.code'),
      M('gross', 'Gross pay', 'ps.gross', ['gross'], 'money'), M('net', 'Net pay', 'ps.net', ['net', 'take home', 'salary', 'paid'], 'money'), M('deductions', 'Deductions', 'ps.total_deductions', ['deduction'], 'money'),
      M('pf', 'PF (employee)', 'ps.pf_employee', ['pf', 'provident'], 'money'), M('esi', 'ESI (employee)', 'ps.esi_employee', ['esi'], 'money'), M('prof_tax', 'Professional tax', 'ps.prof_tax', ['tax'], 'money'), M('ot_hours', 'Overtime hours', 'ps.ot_hours', ['overtime', 'ot'])] },
];

const OPS: Op[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'];
const AGGS: Agg[] = ['sum', 'count', 'avg', 'min', 'max'];
const OPSQL: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
export const MAX_ROWS = 1000;

export const dataset = (key: string) => DATASETS.find((d) => d.key === key);

/** The datasets this person may build reports on. */
export async function availableDatasets(db: Db, userId: string) {
  const out = [];
  for (const d of DATASETS) if (await can(db, userId, d.permission, { anySite: true })) out.push(d);
  return out;
}

/** Plain-words description of the catalogue (used to brief the AI, and shown in the screen). */
export function catalogue(ds: Dataset[]) {
  return ds.map((d) => ({
    key: d.key, label: d.label, sensitive: !!d.sensitive, dateField: d.dateField,
    groupBy: d.fields.filter((f) => !f.measure).map((f) => ({ key: f.key, label: f.label, kind: f.kind })),
    measures: d.fields.filter((f) => f.measure).map((f) => ({ key: f.key, label: f.label, kind: f.kind })),
  }));
}

/** Check a spec against the catalogue and return a clean copy. Anything unknown is refused, never guessed. */
export function validateSpec(raw: unknown): Spec {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = dataset(String(r.dataset ?? ''));
  if (!d) throw badRequest('Unknown dataset');
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const dims = new Map(d.fields.filter((f) => !f.measure).map((f) => [f.key, f]));
  const meas = new Map(d.fields.filter((f) => f.measure).map((f) => [f.key, f]));
  const all = new Map(d.fields.map((f) => [f.key, f]));
  const group = arr(r.group).map(String);
  if (group.length > 3) throw badRequest('Group by at most 3 columns');
  for (const g of group) if (!dims.has(g)) throw badRequest(`"${g}" is not a column you can group ${d.label.toLowerCase()} by`);
  if (new Set(group).size !== group.length) throw badRequest('A column is grouped twice');
  const measures = arr(r.measures).map((m) => {
    const x = (m ?? {}) as Record<string, unknown>; const field = String(x.field ?? ''), agg = String(x.agg ?? '') as Agg;
    if (!AGGS.includes(agg)) throw badRequest(`"${agg}" is not a calculation (use sum, count, avg, min or max)`);
    if (field === '*') { if (agg !== 'count') throw badRequest('Only a count can be taken of whole rows'); return { field, agg }; }
    if (!meas.has(field)) throw badRequest(`"${field}" is not a figure in ${d.label.toLowerCase()}`);
    return { field, agg };
  });
  if (measures.length > 4) throw badRequest('At most 4 figures per report');
  if (new Set(measures.map((m) => m.field + m.agg)).size !== measures.length) throw badRequest('A figure is listed twice');
  const filters = arr(r.filters).map((f) => {
    const x = (f ?? {}) as Record<string, unknown>; const field = String(x.field ?? ''), op = String(x.op ?? '') as Op, value = String(x.value ?? '');
    const fd = all.get(field);
    if (!fd) throw badRequest(`"${field}" is not a column of ${d.label.toLowerCase()}`);
    if (!OPS.includes(op)) throw badRequest(`"${op}" is not a comparison`);
    if (value.length === 0 || value.length > 100) throw badRequest(`Filter on ${fd.label} needs a value (up to 100 characters)`);
    if (fd.kind === 'date' && !(/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)))) throw badRequest(`${fd.label} filter needs a date as YYYY-MM-DD`);
    if ((fd.kind === 'num' || fd.kind === 'money') && !Number.isFinite(Number(value))) throw badRequest(`${fd.label} filter needs a number`);
    if (op === 'contains' && fd.kind !== 'text') throw badRequest('"contains" works on text columns only');
    return { field, op, value };
  });
  if (filters.length > 8) throw badRequest('At most 8 filters');
  let sort: Spec['sort'];
  if (r.sort) {
    const s = r.sort as Record<string, unknown>; const key = String(s.key ?? ''), dir = s.dir === 'asc' ? 'asc' : 'desc';
    const valid = new Set([...group, ...measures.map((m) => outKey(m))]);
    if (!valid.has(key)) throw badRequest(`Cannot sort by "${key}": it is not in the report`);
    sort = { key, dir };
  }
  const limit = r.limit === undefined || r.limit === null ? undefined : Number(r.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS)) throw badRequest(`Limit must be a whole number from 1 to ${MAX_ROWS}`);
  if (!group.length && !measures.length) throw badRequest('Choose at least one column to group by or one figure to total');
  const title = r.title === undefined ? undefined : String(r.title).slice(0, 80);
  return { dataset: d.key, group, measures, filters, sort, limit, title };
}
const outKey = (m: { field: string; agg: string }) => (m.field === '*' ? 'count' : `${m.agg}_${m.field}`);

/** Turn a checked spec into one parameterised query limited to the caller's sites. */
export function compile(spec: Spec, sites: string[] | null) {
  const d = dataset(spec.dataset)!;
  const f = new Map(d.fields.map((x) => [x.key, x]));
  const params: unknown[] = [sites];
  const where = [d.siteCol ? `($1::uuid[] IS NULL OR ${d.siteCol} = ANY($1::uuid[]))` : '($1::uuid[] IS NULL OR true)'];       // company-level data (leads) has no site column
  if (d.where) where.push(d.where);
  for (const x of spec.filters) {
    const fd = f.get(x.field)!;
    if (x.op === 'contains') { params.push('%' + x.value.replace(/[\\%_]/g, '\\$&') + '%'); where.push(`(${fd.sql})::text ILIKE $${params.length}`); }
    else {
      params.push(x.value);
      const cast = fd.kind === 'date' ? '::date' : fd.kind === 'text' ? '::text' : '::numeric';
      where.push(`${fd.sql} ${OPSQL[x.op]} $${params.length}${cast}`);
    }
  }
  const dimSel = spec.group.map((g, i) => `${f.get(g)!.sql} AS d${i}`);
  const mSel = spec.measures.map((m, i) => (m.field === '*' ? `count(*)::float8 AS m${i}` : `${m.agg}(${f.get(m.field)!.sql})::float8 AS m${i}`));
  const agg = spec.measures.length > 0;
  const sel = agg ? [...dimSel, ...mSel] : dimSel;
  let order = '';
  if (spec.sort) {
    const gi = spec.group.indexOf(spec.sort.key);
    const mi = spec.measures.findIndex((m) => outKey(m) === spec.sort!.key);
    order = ` ORDER BY ${gi >= 0 ? `d${gi}` : `m${mi}`} ${spec.sort.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`;
  } else order = spec.group.length ? ` ORDER BY ${spec.group.map((_, i) => `d${i}`).join(', ')}` : '';
  const sql = `SELECT ${sel.join(', ')} FROM ${d.from} WHERE ${where.join(' AND ')}${agg && spec.group.length ? ` GROUP BY ${spec.group.map((_, i) => `d${i}`).join(', ')}` : ''}${order} LIMIT ${Math.min(spec.limit ?? 200, MAX_ROWS)}`;
  return { sql, params, agg };
}

export function describe(spec: Spec): string[] {
  const d = dataset(spec.dataset)!; const f = new Map(d.fields.map((x) => [x.key, x]));
  const lines = [`From: ${d.label}`];
  if (spec.group.length) lines.push('Grouped by: ' + spec.group.map((g) => f.get(g)!.label).join(', '));
  if (spec.measures.length) lines.push('Figures: ' + spec.measures.map((m) => (m.field === '*' ? 'number of rows' : `${m.agg} of ${f.get(m.field)!.label}`)).join(', '));
  for (const x of spec.filters) lines.push(`Only where ${f.get(x.field)!.label} ${({ eq: 'is', neq: 'is not', gt: 'is after/above', gte: 'is on/above', lt: 'is before/below', lte: 'is on/below', contains: 'contains' } as Record<string, string>)[x.op]} ${x.value}`);
  if (spec.sort) lines.push(`Sorted by ${spec.sort.key.replace(/_/g, ' ')} ${spec.sort.dir === 'desc' ? 'high to low' : 'low to high'}`);
  if (spec.limit) lines.push(`First ${spec.limit} rows`);
  return lines;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const fmt = (n: number, kind: Kind) => (kind === 'money' ? '₹' : '') + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** Run a spec as this person. Audited with the whole spec. */
export async function runCustom(db: Db, actor: { id: string; username: string }, rawSpec: unknown, via: 'manual' | 'ai' | 'saved' = 'manual', question?: string) {
  const spec = validateSpec(rawSpec);
  const d = dataset(spec.dataset)!;
  if (!(await can(db, actor.id, d.permission, { anySite: true }))) throw forbidden(`Not permitted: ${d.permission}`);
  const sites = await visibleSites(db, actor.id, d.permission);
  if (sites && !sites.length) throw forbidden(`Not permitted: ${d.permission}`);
  const { sql, params, agg } = compile(spec, sites);
  const raw = (await db.query(sql, params)).rows;
  const f = new Map(d.fields.map((x) => [x.key, x]));
  const columns: Column[] = [
    ...spec.group.map((g) => ({ key: g, label: f.get(g)!.label, kind: (f.get(g)!.kind === 'date' ? 'date' : 'text') as Column['kind'] })),
    ...(agg ? spec.measures.map((m) => {
      const fd = m.field === '*' ? null : f.get(m.field)!;
      return { key: outKey(m), label: m.field === '*' ? 'Rows' : `${fd!.label} (${m.agg})`, kind: (m.agg === 'count' ? 'num' : fd!.kind === 'money' ? 'money' : 'num') as Column['kind'] };
    }) : []),
  ];
  const rows = raw.map((r) => {
    const o: Record<string, string | number | null> = {};
    spec.group.forEach((g, i) => { const v = r['d' + i]; o[g] = v instanceof Date ? v.toISOString().slice(0, 10) : v === null ? '' : String(v); });
    if (agg) spec.measures.forEach((m, i) => { o[outKey(m)] = Math.round(num(r['m' + i]) * 100) / 100; });
    return o;
  });
  const summary: ReportResult['summary'] = [{ label: 'Rows', value: String(rows.length) }];
  if (agg) for (const m of spec.measures.slice(0, 3)) {
    if (m.agg !== 'sum' && m.agg !== 'count') continue;
    const k = outKey(m), fd = m.field === '*' ? null : f.get(m.field)!;
    summary.push({ label: m.field === '*' ? 'Total rows counted' : `Total ${fd!.label}`, value: fmt(rows.reduce((s, r) => s + num(r[k]), 0), m.agg === 'count' ? 'num' : fd!.kind) });
  }
  const m0 = agg ? outKey(spec.measures[0]) : null;
  const chart = m0 && spec.group.length && rows.length > 1 && rows.length <= 40 ? { title: columns.find((c) => c.key === m0)!.label + ' by ' + columns[0].label.toLowerCase(), labelKey: spec.group[0], valueKey: m0, unit: columns.find((c) => c.key === m0)!.kind === 'money' ? '₹' : undefined } : undefined;
  await db.query(`INSERT INTO audit_log(actor_id, action, entity_type, after, reason) VALUES ($1,'report.custom','report',$2,$3)`,
    [actor.id, JSON.stringify({ spec, rows: rows.length, via, sensitive: !!d.sensitive, scope: sites === null ? 'all sites' : `${sites.length} site(s)` }), question ? question.slice(0, 300) : null]);
  const limited = rows.length >= Math.min(spec.limit ?? 200, MAX_ROWS);
  return {
    key: 'custom', title: spec.title ?? d.label, sensitive: !!d.sensitive, params: {}, ranAt: new Date().toISOString(), columns, rows, summary, chart, chartRows: rows, spec, explain: describe(spec),
    note: limited ? `Showing the first ${rows.length} rows. Add a filter or a limit to narrow it.` : undefined,
  };
}

// ── saved reports ──
export async function listSaved(db: Db, userId: string) {
  const rows = (await db.query(
    `SELECT sr.id, sr.name, sr.question, sr.spec, sr.shared, sr.created_at, u.username AS owner, (sr.owner_id = $1) AS mine
       FROM saved_report sr JOIN app_user u ON u.id = sr.owner_id WHERE sr.owner_id = $1 OR sr.shared ORDER BY sr.created_at DESC`, [userId])).rows;
  const ok = new Set((await availableDatasets(db, userId)).map((d) => d.key));
  return rows.filter((r) => ok.has((r.spec as Spec).dataset));      // a shared report is hidden from people who could not run it
}

export async function saveCustom(ctx: Ctx, a: { name: string; spec: unknown; shared?: boolean; question?: string }) {
  const spec = validateSpec(a.spec);
  const d = dataset(spec.dataset)!;
  if (!(await can(ctx.db, ctx.actor.id, d.permission, { anySite: true }))) throw forbidden(`Not permitted: ${d.permission}`);
  const name = a.name.trim();
  if (name.length < 2 || name.length > 60) throw badRequest('Give the report a name of 2 to 60 characters');
  if (((await ctx.db.query('SELECT count(*)::int n FROM saved_report WHERE owner_id=$1', [ctx.actor.id])).rows[0].n) >= 50) throw badRequest('You can keep up to 50 saved reports');
  const r = (await ctx.db.query(`INSERT INTO saved_report(owner_id, name, question, spec, shared) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.actor.id, name, a.question?.slice(0, 300) ?? null, JSON.stringify(spec), !!a.shared])).rows[0];
  await audit(ctx, { action: 'report.save', entityType: 'saved_report', entityId: r.id, after: { name, dataset: spec.dataset, shared: !!a.shared } });
  return { id: r.id as string };
}

export async function deleteSaved(ctx: Ctx, a: { id: string }) {
  const r = (await ctx.db.query('SELECT id, owner_id, name FROM saved_report WHERE id=$1', [a.id])).rows[0];
  if (!r) throw notFound('Saved report');
  if (r.owner_id !== ctx.actor.id) throw forbidden('Only the person who saved a report can delete it');
  await ctx.db.query('DELETE FROM saved_report WHERE id=$1', [a.id]);
  await audit(ctx, { action: 'report.delete', entityType: 'saved_report', entityId: a.id, before: { name: r.name } });
  return { ok: true };
}

export async function runSaved(db: Db, actor: { id: string; username: string }, id: string) {
  const r = (await db.query('SELECT owner_id, shared, spec, name FROM saved_report WHERE id=$1', [id])).rows[0];
  if (!r || (r.owner_id !== actor.id && !r.shared)) throw notFound('Saved report');
  if (!(await availableDatasets(db, actor.id)).some((d) => d.key === (r.spec as Spec).dataset)) throw notFound('Saved report');
  const out = await runCustom(db, actor, { ...(r.spec as object), title: r.name }, 'saved');
  return out;
}
