import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { audit, emit } from '../core/audit.js';
import { assertCan, can, visibleSites } from '../core/permissions.js';
import { badRequest, forbidden, invalidState, notFound } from '../core/errors.js';
import * as po from './po.js';
import * as inv from './inventory.js';
import * as hr from './hr.js';
import * as q from './queries.js';

/**
 * The escalation ladder and the owner's override.
 *
 *  Level 1  the people who can approve the item (told at once)
 *  Level 2  senior management (managing director, finance controller)
 *  Level 3  the owner
 *
 * An "urgent" request starts at level 1 and moves up by itself if nobody acts. A "critical" one goes straight to the owner.
 * Items that simply wait too long are raised automatically by the sweep. The owner can approve or reject any pending item
 * regardless of limits and separation of duties; every override needs a written reason, is logged for ever, and is shown on the owner desk.
 */
export const ESCALATION_RULES = {
  /** Hours a pending approval may wait before the sweep raises it on its own. */
  slaHours: { purchase_order: 24, stock_adjustment: 24, leave_request: 24, salary_structure: 72, payroll_run: 48 } as Record<string, number>,
  /** Hours an open escalation waits at level 1 and level 2 before it moves up. */
  stepHours: [4, 4],
  /** Longest simulated clock jump the demo allows. */
  maxSimulatedDays: 14,
};

export type ItemType = 'purchase_order' | 'stock_adjustment' | 'leave_request' | 'salary_structure' | 'payroll_run';
const ITEM_TYPES: ItemType[] = ['purchase_order', 'stock_adjustment', 'leave_request', 'salary_structure', 'payroll_run'];
const VIEW_PERM: Record<ItemType, string> = {
  purchase_order: 'po.view', stock_adjustment: 'inventory.view', leave_request: 'hr.leave.view', salary_structure: 'hr.salary.view', payroll_run: 'hr.payroll.view',
};
const LABEL: Record<ItemType, string> = {
  purchase_order: 'Purchase order', stock_adjustment: 'Stock adjustment', leave_request: 'Leave request', salary_structure: 'Salary change', payroll_run: 'Payroll run',
};

export interface PendingItem {
  type: ItemType; id: string; site_id: string; number: string; title: string; amount: string | null; created_at: string; created_by: string | null;
  age_hours: number; sla_hours: number; overdue: boolean; escalation: { id: string; number: string; level: number; urgency: string; next_step_at: string } | null;
}

const clock = (asOf?: string | Date) => (asOf ? new Date(asOf).toISOString() : new Date().toISOString());

/** Everything waiting for someone's approval, limited to what this person is allowed to see. */
export async function pendingItems(db: Db, userId: string | null, asOf?: string | Date): Promise<PendingItem[]> {
  const now = clock(asOf);
  const rows = (await db.query(
    `SELECT * FROM (
       SELECT 'purchase_order' AS type, p.id, p.site_id, p.number, 'PO ' || p.number || ' · ' || pt.name AS title, p.total AS amount, p.created_at, u.username AS created_by
         FROM purchase_order p JOIN partner pt ON pt.id = p.partner_id JOIN app_user u ON u.id = COALESCE(p.amended_by, p.created_by)
        WHERE p.status = 'approval_pending' OR p.pending_amendment IS NOT NULL
       UNION ALL
       SELECT 'stock_adjustment', a.id, a.site_id, a.number, 'Adjustment ' || a.number || ' · ' || l.label || ' · ' || a.qty_delta || ' m', NULL, a.created_at, u.username
         FROM stock_adjustment a JOIN lot l ON l.id = a.lot_id JOIN app_user u ON u.id = a.proposed_by WHERE a.status = 'proposed'
       UNION ALL
       SELECT 'leave_request', lr.id, e.site_id, lr.number, 'Leave ' || lr.number || ' · ' || e.name || ' · ' || lr.days || ' day(s)', NULL, lr.created_at, u.username
         FROM leave_request lr JOIN employee e ON e.id = lr.employee_id JOIN app_user u ON u.id = lr.applied_by WHERE lr.status = 'pending'
       UNION ALL
       SELECT 'salary_structure', s.id, e.site_id, 'SAL-' || e.code, 'Salary change · ' || e.name, NULL, s.created_at, u.username
         FROM salary_structure s JOIN employee e ON e.id = s.employee_id JOIN app_user u ON u.id = s.proposed_by WHERE s.status = 'proposed'
       UNION ALL
       SELECT 'payroll_run', r.id, r.site_id, r.number, 'Payroll ' || r.number || ' · ' || r.period, r.total_net, r.created_at, u.username
         FROM payroll_run r JOIN app_user u ON u.id = r.created_by WHERE r.status = 'draft'
     ) x ORDER BY created_at`)).rows as (Omit<PendingItem, 'age_hours' | 'sla_hours' | 'overdue' | 'escalation'> & { created_at: Date })[];
  const open = (await db.query(`SELECT id, number, entity_type, entity_id, level, urgency, next_step_at FROM escalation WHERE status='open'`)).rows;
  const sees: Partial<Record<ItemType, string[] | null>> = {};
  if (userId) for (const t of ITEM_TYPES) sees[t] = await visibleSites(db, userId, VIEW_PERM[t]);
  const out: PendingItem[] = [];
  for (const r of rows) {
    const allowed = sees[r.type];
    if (userId && allowed !== null && !(allowed ?? []).includes(r.site_id)) continue;
    const age = Math.max(0, (new Date(now).getTime() - new Date(r.created_at).getTime()) / 3600000);
    const sla = ESCALATION_RULES.slaHours[r.type];
    const e = open.find((x) => x.entity_type === r.type && x.entity_id === r.id);
    out.push({ ...r, created_at: new Date(r.created_at).toISOString(), age_hours: Math.round(age * 10) / 10, sla_hours: sla, overdue: age > sla,
      escalation: e ? { id: e.id, number: e.number, level: e.level, urgency: e.urgency, next_step_at: new Date(e.next_step_at).toISOString() } : null });
  }
  return out;
}

async function addEvent(ctx: Ctx, escalationId: string, action: string, level: number, note?: string | null) {
  await ctx.db.query('INSERT INTO escalation_event(escalation_id, actor_id, action, level, note) VALUES ($1,$2,$3,$4,$5)', [escalationId, ctx.actor.id, action, level, note ?? null]);
}
const stepAt = (level: number, from: string) => new Date(new Date(from).getTime() + (ESCALATION_RULES.stepHours[level - 1] ?? 0) * 3600000).toISOString();

export async function raiseEscalation(ctx: Ctx, i: { entityType: ItemType; entityId: string; urgency: 'urgent' | 'critical'; reason: string; asOf?: string }, auto = false) {
  await assertCan(ctx.db, ctx.actor.id, 'escalation.raise', { anySite: true });
  if (!ITEM_TYPES.includes(i.entityType)) throw badRequest('Unknown item type');
  if (!['urgent', 'critical'].includes(i.urgency)) throw badRequest('Urgency must be urgent or critical');
  if ((i.reason ?? '').trim().length < 8) throw badRequest('Say why it is urgent (at least 8 characters)');
  const item = (await pendingItems(ctx.db, auto ? null : ctx.actor.id, i.asOf)).find((x) => x.type === i.entityType && x.id === i.entityId);
  if (!item) throw notFound('A pending item you can see');
  if (item.escalation) throw invalidState(`Already escalated as ${item.escalation.number}`);
  const level = i.urgency === 'critical' ? 3 : 1;
  const now = clock(i.asOf);
  const e = (await ctx.db.query(
    `INSERT INTO escalation(entity_type, entity_id, site_id, title, amount, urgency, level, reason, auto, raised_by, raised_at, next_step_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, number, level`,
    [item.type, item.id, item.site_id, item.title, item.amount, i.urgency, level, i.reason.trim(), auto, ctx.actor.id, now, level >= 3 ? now : stepAt(level, now)])).rows[0];
  await addEvent(ctx, e.id, 'raised', level, i.reason.trim());
  await audit(ctx, { action: auto ? 'escalation.auto' : 'escalation.raise', entityType: item.type, entityId: item.id, after: { number: e.number, urgency: i.urgency, level }, reason: i.reason });
  await emit(ctx, { type: 'escalation.raised', entityType: item.type, entityId: item.id, siteId: item.site_id, payload: { number: e.number, urgency: i.urgency, level } });
  return { id: e.id, number: e.number, level };
}

/** A person pushes an escalation up one rung (the raiser, or anyone senior). */
export async function escalateUp(ctx: Ctx, i: { escalationId: string; note?: string }) {
  const e = (await ctx.db.query(`SELECT * FROM escalation WHERE id=$1 FOR UPDATE`, [i.escalationId])).rows[0];
  if (!e) throw notFound('Escalation');
  if (e.status !== 'open') throw invalidState(`This escalation is ${e.status}`);
  const senior = await can(ctx.db, ctx.actor.id, 'escalation.senior', { anySite: true });
  if (e.raised_by !== ctx.actor.id && !senior) throw forbidden('Only the person who raised it, or senior management, can move it up');
  if (e.level >= 3) throw invalidState('It is already with the owner');
  const level = e.level + 1, now = new Date().toISOString();
  await ctx.db.query(`UPDATE escalation SET level=$2, next_step_at=$3, version=version+1 WHERE id=$1`, [e.id, level, level >= 3 ? now : stepAt(level, now)]);
  await addEvent(ctx, e.id, 'moved_up', level, i.note ?? 'Moved up by hand');
  await audit(ctx, { action: 'escalation.move_up', entityType: e.entity_type, entityId: e.entity_id, after: { number: e.number, level }, reason: i.note });
  return { id: e.id, level };
}

export async function cancelEscalation(ctx: Ctx, i: { escalationId: string; reason: string }) {
  if (!(i.reason ?? '').trim()) throw badRequest('A reason is required');
  const e = (await ctx.db.query(`SELECT * FROM escalation WHERE id=$1 FOR UPDATE`, [i.escalationId])).rows[0];
  if (!e) throw notFound('Escalation');
  if (e.status !== 'open') throw invalidState(`This escalation is ${e.status}`);
  if (e.raised_by !== ctx.actor.id && !(await can(ctx.db, ctx.actor.id, 'owner.view', { anySite: true }))) throw forbidden('Only the person who raised it, or the owner, can withdraw it');
  await ctx.db.query(`UPDATE escalation SET status='cancelled', resolved_at=now(), resolution=$2, version=version+1 WHERE id=$1`, [e.id, i.reason]);
  await addEvent(ctx, e.id, 'cancelled', e.level, i.reason);
  await audit(ctx, { action: 'escalation.cancel', entityType: e.entity_type, entityId: e.entity_id, reason: i.reason });
  return { id: e.id };
}

/**
 * The periodic check (run on a schedule in production): resolves escalations whose item has been decided, moves silent
 * ones up a rung, and raises items that have waited past their limit. `asOf` lets the demo fast-forward the clock.
 */
export async function sweepEscalations(ctx: Ctx, i: { asOf?: string } = {}) {
  if (!(await can(ctx.db, ctx.actor.id, 'owner.view', { anySite: true })) && !(await can(ctx.db, ctx.actor.id, 'escalation.senior', { anySite: true })))
    throw forbidden('Not permitted: only the owner or senior management run the escalation check');
  let asOf: string | undefined;
  if (i.asOf) {
    const t = new Date(i.asOf).getTime();
    if (Number.isNaN(t) || t > Date.now() + ESCALATION_RULES.maxSimulatedDays * 86400000) throw badRequest('That date is too far ahead');
    asOf = new Date(t).toISOString();
  }
  const now = clock(asOf);
  const pending = await pendingItems(ctx.db, null, now);   // the sweep looks at everything; it is restricted to the owner and senior management
  const out = { resolved: 0, movedUp: 0, raised: 0 };
  for (const e of (await ctx.db.query(`SELECT * FROM escalation WHERE status='open' FOR UPDATE`)).rows) {
    if (!pending.some((p) => p.type === e.entity_type && p.id === e.entity_id)) {
      await ctx.db.query(`UPDATE escalation SET status='resolved', resolved_at=$2, resolution='Decided', version=version+1 WHERE id=$1`, [e.id, now]);
      await addEvent(ctx, e.id, 'resolved', e.level, 'The item was decided');
      out.resolved++; continue;
    }
    if (e.level < 3 && new Date(e.next_step_at).getTime() <= new Date(now).getTime()) {
      const level = e.level + 1;
      await ctx.db.query(`UPDATE escalation SET level=$2, next_step_at=$3, version=version+1 WHERE id=$1`, [e.id, level, level >= 3 ? now : stepAt(level, now)]);
      await addEvent(ctx, e.id, 'moved_up', level, 'Nobody acted in time');
      out.movedUp++;
    }
  }
  for (const p of pending.filter((x) => x.overdue && !x.escalation)) {
    const hrs = Math.floor(p.age_hours);
    const r = await raiseEscalation(ctx, { entityType: p.type, entityId: p.id, urgency: 'urgent', reason: `Waiting ${hrs} hours for a decision (limit ${p.sla_hours})`, asOf }, true).catch(() => null);
    if (r) out.raised++;
  }
  if (out.resolved + out.movedUp + out.raised) await audit(ctx, { action: 'escalation.sweep', entityType: 'escalation', after: { ...out, asOf: asOf ?? null } });
  return out;
}

/** Escalations this person may see: the owner sees all; senior sees level 2+; others their own and the ones waiting on them. */
export async function listEscalations(db: Db, userId: string, f: { status?: 'open' | 'all' } = {}) {
  if (!(await can(db, userId, 'escalation.view', { anySite: true })) && !(await can(db, userId, 'owner.view', { anySite: true }))) return [];
  const rows = (await db.query(
    `SELECT e.id, e.number, e.entity_type, e.entity_id, e.site_id, e.title, e.amount, e.urgency, e.level, e.reason, e.auto, e.raised_at, e.next_step_at, e.status, e.resolution,
            u.username AS raised_by, e.raised_by AS raised_by_id,
            (SELECT json_agg(json_build_object('at', v.at, 'action', v.action, 'level', v.level, 'note', v.note, 'actor', au.username) ORDER BY v.id)
               FROM escalation_event v LEFT JOIN app_user au ON au.id = v.actor_id WHERE v.escalation_id = e.id) AS history
       FROM escalation e JOIN app_user u ON u.id = e.raised_by
      WHERE ($1 = 'all' OR e.status = 'open') ORDER BY e.status, e.level DESC, e.raised_at DESC LIMIT 200`, [f.status ?? 'open'])).rows;
  const owner = await can(db, userId, 'owner.view', { anySite: true }), senior = await can(db, userId, 'escalation.senior', { anySite: true });
  const out = [];
  for (const r of rows) {
    const viewable = owner || r.raised_by_id === userId || (senior && r.level >= 2)
      || (r.level === 1 && (await can(db, userId, VIEW_PERM[r.entity_type as ItemType], { siteId: r.site_id })));
    if (viewable) out.push({ ...r, kind: LABEL[r.entity_type as ItemType] });
  }
  return out;
}

/**
 * Owner override: approve or reject any pending item, ignoring the approver's limit and separation of duties.
 * Needs a written reason; the item records who actually decided; the override is appended to a log nobody can edit.
 */
export async function ownerOverride(ctx: Ctx, i: { entityType: ItemType; entityId: string; decision: 'approve' | 'reject'; reason: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'owner.override');
  if (!['approve', 'reject'].includes(i.decision)) throw badRequest('Decision must be approve or reject');
  if ((i.reason ?? '').trim().length < 10) throw badRequest('An override needs a written reason (at least 10 characters)');
  const item = (await pendingItems(ctx.db, ctx.actor.id)).find((x) => x.type === i.entityType && x.id === i.entityId);
  if (!item) throw notFound('A pending item');
  const reason = i.reason.trim(), approve = i.decision === 'approve';
  const c2: Ctx = { ...ctx, override: true };
  const ver = async (table: string) => (await ctx.db.query(`SELECT version FROM ${table} WHERE id=$1`, [item.id])).rows[0]?.version as number;
  switch (item.type) {
    case 'purchase_order': {
      const v = await ver('purchase_order');
      if (approve) await po.approvePO(c2, { poId: item.id, expectedVersion: v }); else await po.returnPO(c2, { poId: item.id, expectedVersion: v, reason: `Owner override: ${reason}` });
      break;
    }
    case 'stock_adjustment': await inv.approveAdjustment(c2, { adjustmentId: item.id, expectedVersion: await ver('stock_adjustment'), approve }); break;
    case 'leave_request': await hr.decideLeave(c2, { leaveId: item.id, expectedVersion: await ver('leave_request'), approve, note: `Owner override: ${reason}` }); break;
    case 'salary_structure': await hr.decideSalary(c2, { salaryId: item.id, approve }); break;
    case 'payroll_run': {
      const v = await ver('payroll_run');
      if (approve) await hr.approvePayrollRun(c2, { runId: item.id, expectedVersion: v }); else await hr.cancelPayrollRun(c2, { runId: item.id, expectedVersion: v, reason: `Owner override: ${reason}` });
      break;
    }
  }
  const esc = (await ctx.db.query(`SELECT id, level FROM escalation WHERE entity_type=$1 AND entity_id=$2 AND status='open' FOR UPDATE`, [item.type, item.id])).rows[0];
  await ctx.db.query(
    `INSERT INTO override_log(actor_id, entity_type, entity_id, title, decision, reason, status_before, created_by, escalation_id) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)`,
    [ctx.actor.id, item.type, item.id, item.title, i.decision, reason, item.created_by, esc?.id ?? null]);
  if (esc) {
    await ctx.db.query(`UPDATE escalation SET status='resolved', resolved_at=now(), resolution=$2, version=version+1 WHERE id=$1`, [esc.id, `Owner override: ${i.decision}`]);
    await addEvent(ctx, esc.id, 'overridden', esc.level, `${i.decision}: ${reason}`);
  }
  await audit(ctx, { action: 'owner.override', entityType: item.type, entityId: item.id, before: { status: 'pending', preparedBy: item.created_by }, after: { decision: i.decision }, reason });
  await emit(ctx, { type: 'owner.override', entityType: item.type, entityId: item.id, siteId: item.site_id, payload: { title: item.title, decision: i.decision } });
  return { type: item.type, id: item.id, decision: i.decision };
}

export async function listOverrides(db: Db, userId: string, limit = 20) {
  if (!(await can(db, userId, 'owner.view', { anySite: true })) && !(await can(db, userId, 'audit.view', { anySite: true }))) return null;
  return (await db.query(
    `SELECT o.id, o.at, o.entity_type, o.title, o.decision, o.reason, o.created_by, u.username AS decided_by
       FROM override_log o JOIN app_user u ON u.id = o.actor_id ORDER BY o.id DESC LIMIT $1`, [limit])).rows;
}

const n = (v: unknown) => Number(v ?? 0);

/** One page that shows the whole business: every process, what is stuck, what needs the owner. */
export async function ownerDashboard(db: Db, userId: string, asOf?: string) {
  if (!(await can(db, userId, 'owner.view', { anySite: true }))) return null;
  const poRows = (await db.query(`SELECT status, count(*)::int AS n, COALESCE(sum(total),0) AS value FROM purchase_order GROUP BY status`)).rows;
  const po = (s: string[]) => poRows.filter((r) => s.includes(r.status));
  const qcRows = (await db.query(`SELECT status, count(*)::int AS n FROM qc_inspection GROUP BY status`)).rows;
  const rec = (await db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE received_at > now() - interval '7 days')::int AS week FROM receipt WHERE status='posted'`)).rows[0];
  const stock = await q.stockSummary(db, userId);
  const sum = (k: 'accepted' | 'held' | 'rejected' | 'reserved' | 'available') => stock.reduce((a, r) => a + n(r[k]), 0);
  const emp = (await db.query(`SELECT count(*)::int AS n FROM employee WHERE status='active'`)).rows[0].n as number;
  const day = (await db.query(`SELECT max(work_date)::text AS d FROM attendance WHERE work_date <= current_date`)).rows[0].d as string | null;
  const att = day ? (await db.query(`SELECT status, count(*)::int AS n FROM attendance WHERE work_date=$1 GROUP BY status`, [day])).rows : [];
  const leaveP = (await db.query(`SELECT count(*)::int AS n FROM leave_request WHERE status='pending'`)).rows[0].n as number;
  const runs = (await db.query(`SELECT number, period, status, total_net, total_gross, (SELECT count(*)::int FROM payslip p WHERE p.run_id = r.id) AS people FROM payroll_run r WHERE status <> 'cancelled' ORDER BY period DESC LIMIT 1`)).rows[0] ?? null;
  const approvals = await pendingItems(db, userId, asOf);
  const escalations = await listEscalations(db, userId, { status: 'open' });
  const activity = (await db.query(
    `SELECT a.at, a.action, a.entity_type, u.username AS actor, a.reason FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_id
      WHERE a.action NOT LIKE 'login%' ORDER BY a.id DESC LIMIT 14`)).rows;
  const sumPo = (s: string[]) => po(s).reduce((a, r) => a + n(r.n), 0);
  return {
    generatedAt: clock(asOf),
    purchasing: { draft: sumPo(['draft']), awaiting: sumPo(['approval_pending']), approved: sumPo(['approved']), open: sumPo(['released', 'acknowledged', 'partial_receipt']),
      completed: sumPo(['completed', 'closed']), openValue: po(['approved', 'released', 'acknowledged', 'partial_receipt']).reduce((a, r) => a + n(r.value), 0) },
    receiving: { total: rec.total, week: rec.week },
    quality: { waiting: qcRows.filter((r) => ['pending', 'inspecting', 'submitted'].includes(r.status)).reduce((a, r) => a + n(r.n), 0), held: qcRows.filter((r) => r.status === 'held').reduce((a, r) => a + n(r.n), 0),
      done: qcRows.filter((r) => ['accepted', 'rejected', 'partial'].includes(r.status)).reduce((a, r) => a + n(r.n), 0) },
    stock: { lots: stock.length, accepted: sum('accepted'), held: sum('held'), rejected: sum('rejected'), reserved: sum('reserved'), available: sum('available') },
    people: { employees: emp, day, attendance: Object.fromEntries(att.map((r) => [r.status, r.n])), leavePending: leaveP },
    payroll: runs,
    approvals, escalations, activity,
    overrides: await listOverrides(db, userId, 6),
  };
}
