import { html, raw, qty, money, when, chip, type Raw } from './lib.js';
import { K, S, uid, read, val, act, head, denied, R, demoNow, hoursText, toast } from './ctx.js';
import * as owner from '../src/domain/owner.js';
import { can } from '../src/core/permissions.js';
import type { View } from './ctx.js';

const KIND: Record<string, string> = { purchase_order: 'Purchase order', stock_adjustment: 'Stock adjustment', leave_request: 'Leave', salary_structure: 'Salary change', payroll_run: 'Payroll' };
const KIND_VIEW: Record<string, View> = { purchase_order: 'po', stock_adjustment: 'stock', leave_request: 'leave', salary_structure: 'payroll', payroll_run: 'payroll' };
const LEVELS = [{ n: 1, name: 'The approver', hint: 'The people who can approve it are told at once' }, { n: 2, name: 'Senior management', hint: 'Managing director and finance controller' }, { n: 3, name: 'The owner', hint: 'Needs your decision' }];

type Dash = NonNullable<Awaited<ReturnType<typeof owner.ownerDashboard>>>;
type Esc = Awaited<ReturnType<typeof owner.listEscalations>>[number];
type Item = Dash['approvals'][number];

const num = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
const tone = (bad: boolean, warn: boolean) => (bad ? 'bad' : warn ? 'warn' : 'ok');
const ageTone = (i: Item) => (i.overdue ? 'bad' : i.age_hours > i.sla_hours / 2 ? 'warn' : 'ok');
const ladder = (n: number) => html`<span class="rung r${n}" title="${LEVELS[n - 1].name}"><i></i><i></i><i></i></span>`;
const countdown = (iso: string) => { const h = (new Date(iso).getTime() - demoNow().getTime()) / 3600000; return h <= 0 ? 'due to move up now' : `moves up in ${hoursText(h)}`; };

function node(view: View, title: string, big: string, sub: string, t: string, extra: Raw | string = '') {
  return html`<button class="node ${t}" data-view="${view}"><span class="nt">${title}</span><b>${big}</b><small>${sub}</small>${extra}</button>`;
}
const stack = (parts: { v: number; cls: string; label: string }[]) => {
  const total = parts.reduce((a, p) => a + p.v, 0) || 1;
  return raw(`<div class="bar" role="img" aria-label="${parts.map((p) => `${p.label} ${Math.round(p.v)}`).join(', ')}">${parts.filter((p) => p.v > 0).map((p) => `<i class="${p.cls}" style="width:${(p.v / total) * 100}%" title="${p.label}: ${Math.round(p.v)}"></i>`).join('')}</div>`);
};

export async function ownerView(): Promise<Raw> {
  const asOf = S.skewHours ? demoNow().toISOString() : undefined;
  const d = await read((db) => owner.ownerDashboard(db, uid(), asOf));
  if (!d) return denied('Owner desk', 'The whole business on one page.', 'This page is for the owner. Switch to “Business owner” to see it.');
  const att = d.people.attendance as Record<string, number>;
  const present = (att.P ?? 0) + (att.H ?? 0), absent = (att.A ?? 0) + (att.LWP ?? 0), onLeave = att.L ?? 0, off = (att.WO ?? 0) + (att.HOL ?? 0);
  const urgent = d.escalations.filter((e) => e.level === 3).length, overdue = d.approvals.filter((a) => a.overdue).length;
  const lvl = [1, 2, 3].map((n) => d.escalations.filter((e) => e.level === n));
  const pay = d.payroll;

  const flow = html`
    <div class="flow" aria-label="Purchasing to stock">
      ${node('po', 'Buying', num(d.purchasing.open), 'orders open with vendors', tone(d.purchasing.awaiting > 0 && d.approvals.some((a) => a.type === 'purchase_order' && a.overdue), d.purchasing.awaiting > 0),
        html`<em>${d.purchasing.awaiting} waiting approval · ${d.purchasing.draft} draft</em><em>Open value ${money(String(d.purchasing.openValue))}</em>`)}
      <span class="arrow" aria-hidden="true"></span>
      ${node('receiving', 'Receiving', num(d.receiving.week), 'deliveries in the last 7 days', 'ok', html`<em>${d.receiving.total} received in all</em>`)}
      <span class="arrow" aria-hidden="true"></span>
      ${node('quality', 'Quality', num(d.quality.waiting), 'rolls waiting for inspection', tone(d.quality.waiting > 3, d.quality.waiting > 0), html`<em>${d.quality.held} on hold · ${d.quality.done} released</em>`)}
      <span class="arrow" aria-hidden="true"></span>
      ${node('stock', 'Stock', qty(String(Math.round(d.stock.available))) + ' m', 'free to use', tone(false, d.stock.held > 0),
        html`${stack([{ v: d.stock.available, cls: 'av', label: 'Free' }, { v: d.stock.reserved, cls: 'rs', label: 'Reserved' }, { v: d.stock.held, cls: 'hd', label: 'On QC hold' }, { v: d.stock.rejected, cls: 'rj', label: 'Rejected' }])}
          <em>${qty(String(Math.round(d.stock.reserved)))} reserved · ${qty(String(Math.round(d.stock.held)))} on hold · ${qty(String(Math.round(d.stock.rejected)))} rejected</em>`)}
    </div>
    <div class="flow people" aria-label="People and pay">
      ${node('employees', 'People', num(d.people.employees), 'on the payroll', 'ok', html`<em>${d.people.day ? `Latest sheet: ${new Date(d.people.day + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}` : 'No attendance yet'}</em>`)}
      <span class="arrow" aria-hidden="true"></span>
      ${node('attendance', 'Attendance', `${num(present)} in`, `${absent} absent · ${onLeave} on leave · ${off} off`, tone(absent > 2, absent > 0), stack([{ v: present, cls: 'av', label: 'Present' }, { v: onLeave, cls: 'rs', label: 'On leave' }, { v: absent, cls: 'rj', label: 'Absent' }, { v: off, cls: 'off', label: 'Off' }]))}
      <span class="arrow" aria-hidden="true"></span>
      ${node('leave', 'Leave', num(d.people.leavePending), 'requests waiting', tone(false, d.people.leavePending > 0))}
      <span class="arrow" aria-hidden="true"></span>
      ${node('payroll', 'Payroll', pay ? money(pay.total_net) : 'None yet', pay ? `${pay.period} · ${pay.status} · ${pay.people} people` : 'no run calculated', pay ? (pay.status === 'approved' ? 'ok' : 'warn') : 'warn')}
    </div>`;

  const rows = d.approvals.map((a) => {
    const key = `${a.type}:${a.id}`, open = S.ovr.startsWith(key + ':');
    const pct = Math.min(100, Math.round((a.age_hours / a.sla_hours) * 100));
    return html`<li class="appr ${ageTone(a)}">
      <div class="ap-main">
        <span class="chip neutral">${KIND[a.type]}</span>
        <button class="link" data-view="${KIND_VIEW[a.type]}"><b>${a.title}</b></button>
        <small>prepared by ${a.created_by} ${a.amount ? '· ' + money(a.amount) : ''}</small>
        <div class="age" title="Waiting ${hoursText(a.age_hours)} of ${a.sla_hours} h allowed"><i class="${ageTone(a)}" style="width:${pct}%"></i></div>
        <small>${a.overdue ? html`<b class="neg">Waiting ${hoursText(a.age_hours)}</b> (limit ${a.sla_hours} h)` : `Waiting ${hoursText(a.age_hours)} of ${a.sla_hours} h allowed`}${a.escalation ? html` · <b>${a.escalation.number}</b> ${ladder(a.escalation.level)} ${LEVELS[a.escalation.level - 1].name}` : ''}</small>
      </div>
      <div class="ap-act">
        <button class="primary" data-act="ov-open" data-id="${key}:approve">Approve</button>
        <button data-act="ov-open" data-id="${key}:reject">Reject</button>
      </div>
      ${open ? html`<form class="ovform" data-form="override"><b>${S.ovr.endsWith(':approve') ? 'Approve' : 'Reject'} as owner override</b>
        <p class="note">This skips the approver’s limit and the “someone else must approve” rule. It is recorded with your name and reason, and cannot be removed.</p>
        <input id="ov-reason" placeholder="Why are you overriding? (required, at least 10 characters)" autocomplete="off" />
        <div class="row"><button class="primary" type="submit">Confirm ${S.ovr.endsWith(':approve') ? 'approval' : 'rejection'}</button><button type="button" data-act="ov-cancel">Cancel</button></div></form>` : ''}
    </li>`;
  });

  const ladderCard = html`<div class="card"><h2>Escalation ladder</h2>
      <p class="sub">Urgent requests start with the approver and climb by themselves if nobody acts. Critical ones come straight to you.</p>
      <ol class="ladder">${LEVELS.map((l) => html`<li class="step s${l.n} ${lvl[l.n - 1].length ? 'has' : ''}"><div class="sh">${ladder(l.n)}<b>${l.name}</b><span class="count">${lvl[l.n - 1].length}</span></div><small>${l.hint}</small>
        ${lvl[l.n - 1].map((e) => html`<div class="esc"><b>${e.number}</b> ${e.title}<small>${e.urgency}${e.auto ? ' · raised automatically' : ''} · “${e.reason}” · ${e.level < 3 ? countdown(e.next_step_at) : 'with you now'}</small></div>`)}</li>`)}</ol>
      <div class="row clock"><button data-act="sweep">Run the escalation check</button><button data-act="skew">Move the clock +8 h</button>${S.skewHours ? html`<button class="ghost" data-act="skew-reset">Reset clock</button><span class="chip warn">Demo clock +${S.skewHours} h</span>` : ''}</div>
      <p class="note">In real use the check runs by itself every few minutes. The clock buttons let you watch a request climb the ladder in the demo.</p></div>`;

  return html`
  ${head('Owner desk', 'Every process on one page. What is moving, what is stuck, and what needs you.', html`<div class="row"><button data-act="refresh">Refresh</button></div>`)}
  <section class="needs ${urgent || overdue ? 'hot' : ''}" aria-label="Needs you">
    <div><b>${d.approvals.length}</b><span>waiting for approval</span></div>
    <div class="${overdue ? 'bad' : ''}"><b>${overdue}</b><span>past their time limit</span></div>
    <div class="${urgent ? 'bad' : ''}"><b>${urgent}</b><span>escalated to you</span></div>
    <div><b>${d.overrides?.length ?? 0}</b><span>of your overrides logged</span></div>
  </section>
  <h3 class="sec">The business, end to end</h3>
  ${flow}
  <section class="split owner2">
    <div class="card"><h2>Waiting for a decision</h2><p class="sub">Approve or reject any of them yourself. The bar shows how much of the allowed waiting time has gone.</p>
      ${rows.length ? html`<ul class="apprs">${rows}</ul>` : html`<p class="empty">Nothing is waiting. Every approval has been decided.</p>`}</div>
    ${ladderCard}
  </section>
  <section class="split owner2">
    <div class="card"><h2>Your overrides</h2><p class="sub">Every time you stepped in. Permanent and visible to the auditor.</p>
      ${d.overrides?.length ? html`<div class="tablewrap"><table class="mini"><thead><tr><th>When</th><th>What</th><th>Decision</th><th>Why</th></tr></thead><tbody>${d.overrides.map((o) => html`<tr><td>${when(o.at)}</td><td>${o.title}<br><small>prepared by ${o.created_by}</small></td><td>${chip(o.decision === 'approve' ? 'accepted' : 'rejected', o.decision === 'approve' ? 'approved' : 'rejected')}</td><td>${o.reason}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">You have not overridden anything yet.</p>`}</div>
    <div class="card"><h2>What just happened</h2><p class="sub">The latest actions across the business.</p>
      <ul class="timeline">${d.activity.map((a) => html`<li><b>${a.actor ?? 'system'}</b> ${String(a.action).replace(/[._]/g, ' ')} <small>${a.entity_type?.replace(/_/g, ' ') ?? ''} · ${when(a.at)}</small>${a.reason ? html`<small>“${a.reason}”</small>` : ''}</li>`)}</ul></div>
  </section>`;
}

/** For everyone else: raise something urgent, follow it, push it up. */
export async function escalationsView(): Promise<Raw> {
  const asOf = S.skewHours ? demoNow().toISOString() : undefined;
  const d = await read(async (db) => ({
    items: await owner.pendingItems(db, uid(), asOf), list: await owner.listEscalations(db, uid(), { status: 'all' }),
    raise: await can(db, uid(), 'escalation.raise', { anySite: true }), senior: await can(db, uid(), 'escalation.senior', { anySite: true }),
  }));
  if (!d.raise && !d.list.length) return denied('Urgent approvals', 'Raise something that cannot wait.', 'Your role cannot raise or follow escalations.');
  const open = d.list.filter((e: Esc) => e.status === 'open'), closed = d.list.filter((e: Esc) => e.status !== 'open');
  const items = d.items.map((a: Item) => html`<li class="appr ${ageTone(a)}"><div class="ap-main"><span class="chip neutral">${KIND[a.type]}</span> <b>${a.title}</b><small>prepared by ${a.created_by}${a.amount ? ' · ' + money(a.amount) : ''} · waiting ${hoursText(a.age_hours)}</small>
      ${a.escalation ? html`<small><b>${a.escalation.number}</b> ${ladder(a.escalation.level)} ${LEVELS[a.escalation.level - 1].name}</small>` : ''}</div>
      <div class="ap-act">${a.escalation || !d.raise ? '' : html`<button data-act="esc-open" data-id="${a.type}:${a.id}">Escalate</button>`}</div>
      ${S.escFor === `${a.type}:${a.id}` ? html`<form class="ovform" data-form="raise"><b>Escalate this</b>
        <label>How urgent?<select id="esc-urg"><option value="urgent">Urgent: ask the approver, then climb if nobody acts</option><option value="critical">Critical: straight to the owner</option></select></label>
        <input id="esc-reason" placeholder="Why can't it wait? (at least 8 characters)" autocomplete="off" />
        <div class="row"><button class="primary" type="submit">Raise it</button><button type="button" data-act="esc-cancel">Cancel</button></div></form>` : ''}</li>`);
  const escRow = (e: Esc) => html`<li class="esc2 ${e.status}"><div><span class="chip ${e.status === 'open' ? (e.level === 3 ? 'bad' : 'warn') : 'neutral'}">${e.number}</span> ${e.status === 'open' ? ladder(e.level) : ''} <b>${e.title}</b>
      <small>${e.urgency} · raised by ${e.raised_by}${e.auto ? ' (automatic)' : ''} · “${e.reason}”</small>
      <small>${e.status === 'open' ? `${LEVELS[e.level - 1].name}${e.level < 3 ? ' · ' + countdown(e.next_step_at) : ''}` : `${e.status}${e.resolution ? ' · ' + e.resolution : ''}`}</small>
      <details><summary>History</summary><ul class="plain">${(e.history ?? []).map((h: { at: string; action: string; level: number; note: string | null; actor: string | null }) => html`<li>${when(h.at)} · ${h.action.replace('_', ' ')} · level ${h.level}${h.actor ? ' · ' + h.actor : ''}${h.note ? html` · <i>${h.note}</i>` : ''}</li>`)}</ul></details></div>
      ${e.status === 'open' ? html`<div class="ap-act">${e.level < 3 && (e.raised_by === S.user || d.senior) ? html`<button data-act="esc-up" data-id="${e.id}">Move up</button>` : ''}${e.raised_by === S.user ? html`<button data-act="esc-withdraw" data-id="${e.id}">Withdraw</button>` : ''}</div>` : ''}</li>`;
  return html`
  ${head('Urgent approvals', 'Something cannot wait for its normal approver? Raise it here. It climbs from the approver, to senior management, to the owner.')}
  <section class="split owner2">
    <div class="card"><h2>Waiting for approval</h2><p class="sub">Only what you are allowed to see.</p>${items.length ? html`<ul class="apprs">${items}</ul>` : html`<p class="empty">Nothing you can see is waiting.</p>`}</div>
    <div class="card"><h2>Escalations</h2>${open.length ? html`<ul class="esclist">${open.map(escRow)}</ul>` : html`<p class="empty">No open escalations.</p>`}
      ${closed.length ? html`<h3>Closed</h3><ul class="esclist">${closed.slice(0, 8).map(escRow)}</ul>` : ''}</div>
  </section>`;
}

export async function onClick(t: HTMLElement): Promise<boolean> {
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b) return false;
  const a = b.dataset.act!, id = b.dataset.id ?? '';
  switch (a) {
    case 'refresh': await R.render(); return true;
    case 'ov-open': S.ovr = id; await R.render(); return true;
    case 'ov-cancel': S.ovr = ''; await R.render(); return true;
    case 'skew': S.skewHours += 8; await act('Clock moved forward 8 hours', (c) => owner.sweepEscalations(c, { asOf: demoNow().toISOString() })); return true;
    case 'skew-reset': S.skewHours = 0; await R.render(); return true;
    case 'sweep': {
      const r = await act('Escalation check done', (c) => owner.sweepEscalations(c, S.skewHours ? { asOf: demoNow().toISOString() } : {}));
      if (r) toast(`${r.raised} raised · ${r.movedUp} moved up · ${r.resolved} closed`);
      return true;
    }
    case 'esc-open': S.escFor = id; await R.render(); return true;
    case 'esc-cancel': S.escFor = ''; await R.render(); return true;
    case 'esc-up': await act('Moved up one level', (c) => owner.escalateUp(c, { escalationId: id })); return true;
    case 'esc-withdraw': await act('Withdrawn', (c) => owner.cancelEscalation(c, { escalationId: id, reason: 'Withdrawn by the person who raised it' })); return true;
  }
  return false;
}

export async function onSubmit(form: string): Promise<boolean> {
  if (form === 'override') {
    const [type, id, decision] = S.ovr.split(':');
    const r = await act(decision === 'approve' ? 'Approved by owner override' : 'Rejected by owner override', (c) => owner.ownerOverride(c, { entityType: type as never, entityId: id, decision: decision as 'approve' | 'reject', reason: val('ov-reason') }));
    if (r) { S.ovr = ''; await R.render(); }
    return true;
  }
  if (form === 'raise') {
    const [type, id] = S.escFor.split(':');
    const r = await act('Escalated', (c) => owner.raiseEscalation(c, { entityType: type as never, entityId: id, urgency: (document.getElementById('esc-urg') as HTMLSelectElement).value as 'urgent' | 'critical', reason: val('esc-reason') }));
    if (r) { S.escFor = ''; await R.render(); }
    return true;
  }
  return false;
}
void K;
