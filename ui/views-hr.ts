import { html, raw, when, chip, money, dateOnly, type Raw } from './lib.js';
import { PEOPLE, K, S, uid, read, val, checked, act, head, kv, denied, toast, R, opts, todayIso, addDays, prevMonth, monthLabel } from './ctx.js';
import * as hr from '../src/domain/hr.js';
import { can } from '../src/core/permissions.js';

const site = () => K.world.siteId;
const idLabel = (rows: { id: string; code?: string; name: string }[]) => rows.map((r) => ({ id: r.id, label: r.code ? `${r.code} · ${r.name}` : r.name }));
const hours = (min: number) => (min ? (min / 60).toFixed(1).replace(/\.0$/, '') + ' h' : '');

// ───────────── Employees ─────────────
export async function employeesView(): Promise<Raw> {
  const d = await read(async (db) => {
    const list = await hr.listEmployees(db, uid(), { includeExited: S.empAll });
    const ref = await hr.hrReference(db);
    const my = await hr.myEmployeeRecord(db, uid());
    const sel = list.find((e) => e.id === S.empId) ?? list.find((e) => e.id === my?.id) ?? null;
    const caps = { create: await can(db, uid(), 'hr.employee.create', { siteId: site() }), edit: await can(db, uid(), 'hr.employee.edit', { siteId: site() }), exit: await can(db, uid(), 'hr.employee.exit', { siteId: site() }), salary: await can(db, uid(), 'hr.salary.view', { siteId: site() }) };
    const salary = sel && caps.salary ? ((await hr.listSalary(db, uid())) ?? []).filter((s) => s.code === sel.code) : [];
    const bal = sel && (sel.user_id === uid() || (await can(db, uid(), 'hr.leave.view', { siteId: site() }))) ? await hr.leaveBalance(db, sel.id) : [];
    return { list, ref, caps, sel, salary, bal };
  });
  const { ref, caps, sel } = d;
  const emps = idLabel(d.list.map((e) => ({ id: e.id, code: e.code, name: e.name })));
  const form = S.open.has('newemp') ? html`
    <form class="card form" data-form="newemp"><h2>New employee</h2>
      <div class="grid2"><label>Full name<input id="ne-name" /></label><label>Joining date<input id="ne-join" type="date" value="${todayIso()}" /></label>
      <label>Department<select id="ne-dept">${opts(idLabel(ref.departments), '', 'None')}</select></label>
      <label>Designation<select id="ne-desig">${opts(idLabel(ref.designations), '', 'None')}</select></label>
      <label>Reports to<select id="ne-mgr">${opts(emps, '', 'Nobody')}</select></label>
      <label>Shift<select id="ne-shift">${opts(idLabel(ref.shifts), ref.shifts[0]?.id ?? '')}</select></label>
      <label>Type<select id="ne-type"><option value="permanent">Permanent</option><option value="contract">Contract</option><option value="daily">Daily wage</option></select></label>
      <label>Phone<input id="ne-phone" inputmode="tel" /></label>
      <label>Bank account<input id="ne-bank" inputmode="numeric" autocomplete="off" /></label></div>
      <p class="note">The employee code is numbered automatically per site. Salary is proposed separately and approved by Finance.</p>
      <div class="row"><button class="primary" type="submit">Create employee</button><button type="button" data-act="toggle-newemp">Close</button></div></form>` : html``;
  const detail = !sel ? html`<p class="empty">Select a person.</p>` : html`
    <div class="dh"><h2>${sel.name}</h2>${chip(sel.status)}</div>
    ${kv('Code', raw(`<span class="mono">${sel.code}</span>`))}${kv('Department', sel.department ?? '–')}${kv('Designation', sel.designation ?? '–')}${kv('Reports to', sel.manager ?? '–')}${kv('Shift', sel.shift ?? '–')}
    ${kv('Type', sel.emp_type)}${kv('Joined', dateOnly(sel.join_date))}${sel.exit_date ? kv('Left', dateOnly(sel.exit_date)) : ''}${kv('Phone', sel.phone ?? '–')}${kv('Bank account', sel.bank_account ?? '–')}${kv('PF / ESI', `${sel.pf_applicable ? 'PF' : 'no PF'} · ${sel.esi_applicable ? 'ESI' : 'no ESI'}`)}
    ${d.salary.length ? html`<h3>Salary</h3>${(() => { const cur = d.salary.find((s) => s.status === 'approved'); return cur ? html`${kv('Basic', money(cur.basic))}${kv('HRA', money(cur.hra))}${kv('Other allowance', money(cur.other_allowance))}${kv('Effective from', dateOnly(cur.effective_from))}` : html`<p class="empty">No approved salary yet.</p>`; })()}` : ''}
    ${d.bal.length ? html`<h3>Leave balance ${new Date().getFullYear()}</h3><div class="bal">${d.bal.filter((b) => Number(b.annual_quota) > 0 || Number(b.used) > 0).map((b) => html`<div><b>${Number(b.balance)}</b><span>${b.code}</span><small>${Number(b.used)} used</small></div>`)}</div>` : ''}
    ${caps.edit && sel.status === 'active' ? html`<form class="form" data-form="editemp"><h3>Edit</h3>
      <label>Phone<input id="ee-phone" value="${sel.phone ?? ''}" /></label>
      <label>Department<select id="ee-dept">${opts(idLabel(ref.departments), ref.departments.find((x) => x.name === sel.department)?.id ?? '', 'None')}</select></label>
      <label>Designation<select id="ee-desig">${opts(idLabel(ref.designations), ref.designations.find((x) => x.name === sel.designation)?.id ?? '', 'None')}</select></label>
      <label>Reports to<select id="ee-mgr">${opts(emps.filter((e) => e.id !== sel.id), sel.manager_id ?? '', 'Nobody')}</select></label>
      <button type="submit">Save changes</button></form>` : ''}
    ${caps.exit && sel.status === 'active' ? (S.open.has('exit') ? html`<form class="form" data-form="exitemp"><h3>Record exit</h3>
      <label>Last working day<input id="ex-date" type="date" value="${todayIso()}" /></label><label>Reason<input id="ex-reason" placeholder="e.g. resigned" /></label>
      <p class="note">This closes their sign-in at once, cancels pending leave and keeps the record. It cannot be undone from here.</p>
      <div class="row"><button class="primary" type="submit">Confirm exit</button><button type="button" data-act="toggle-exit">Cancel</button></div></form>` : html`<div class="row"><button data-act="toggle-exit">Record exit…</button></div>`) : ''}`;
  return html`
  ${head('Employees', caps.create || caps.edit ? 'The people register. Salary and bank details are visible only to roles that need them.' : 'You can see your own record. HR sees everyone at the site.', caps.create ? html`<button class="primary" data-act="toggle-newemp">New employee</button>` : undefined)}
  ${form}
  <section class="split">
    <div class="card flush"><div class="bar2"><span>${d.list.length} ${S.empAll ? 'people' : 'active'}</span>${caps.create ? html`<button class="link" data-act="toggle-empall">${S.empAll ? 'hide exited' : 'show exited'}</button>` : ''}</div>
    <div class="tablewrap"><table><thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Reports to</th><th>Status</th></tr></thead>
      <tbody>${d.list.map((e) => html`<tr class="pick ${e.id === sel?.id ? 'on' : ''}" data-pick-emp="${e.id}" tabindex="0"><td class="mono">${e.code}</td><td><b>${e.name}</b><br><small>${e.designation ?? ''}</small></td><td>${e.department ?? ''}</td><td>${e.manager ?? ''}</td><td>${chip(e.status)}</td></tr>`)}</tbody></table></div></div>
    <aside class="card detail">${detail}</aside>
  </section>`;
}

// ───────────── Attendance ─────────────
const CODE_NAME: Record<string, string> = { P: 'Present', A: 'Absent', H: 'Half day', L: 'Paid leave', LWP: 'Unpaid leave', WO: 'Weekly off', HOL: 'Holiday' };
function monthGrid(period: string, rows: { work_date: string; status: string; ot_min: number; late_min: number }[]): Raw {
  const first = new Date(period + '-01T00:00:00Z'); const dim = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const by = new Map(rows.map((r) => [r.work_date, r]));
  const cells: Raw[] = [];
  for (let i = 0; i < (first.getUTCDay() + 6) % 7; i++) cells.push(html`<i class="pad"></i>`);
  for (let d = 1; d <= dim; d++) {
    const key = `${period}-${String(d).padStart(2, '0')}`; const r = by.get(key);
    cells.push(html`<div class="day ${r ? 'st-' + r.status : 'none'}" title="${r ? CODE_NAME[r.status] + (r.ot_min ? ' · OT ' + hours(r.ot_min) : '') + (r.late_min ? ' · late ' + r.late_min + ' min' : '') : 'Not marked'}"><b>${d}</b><span>${r?.status ?? ''}</span></div>`);
  }
  return html`<div class="cal"><div class="dow">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => html`<span>${x}</span>`)}</div><div class="days">${cells}</div></div>`;
}

export async function attendanceView(): Promise<Raw> {
  if (!S.attDate) S.attDate = addDays(todayIso(), -1);
  const d = await read(async (db) => {
    const view = await can(db, uid(), 'hr.attendance.view', { siteId: site() });
    const my = await hr.myEmployeeRecord(db, uid());
    const rows = view ? await hr.dailyAttendance(db, uid(), site(), S.attDate) : null;
    const empId = view ? (rows?.find((r) => r.employee_id === S.attEmp)?.employee_id ?? rows?.[0]?.employee_id ?? '') : my?.id ?? '';
    const month = empId ? await hr.monthlyAttendance(db, uid(), empId, S.attDate.slice(0, 7)).catch(() => null) : null;
    const name = rows?.find((r) => r.employee_id === empId)?.name ?? my?.name ?? '';
    const sel = rows?.find((r) => r.employee_id === empId) ?? null;
    return { view, rows, empId, month, name, sel, fill: await can(db, uid(), 'hr.employee.create', { siteId: site() }), mark: await can(db, uid(), 'hr.attendance.mark', { siteId: site() }) };
  });
  if (!d.view && !d.month) return denied('Attendance', 'Daily marks, shifts and overtime.', 'Your role cannot see attendance, and your account is not linked to an employee record.');
  const legend = html`<div class="legend">${Object.entries(CODE_NAME).map(([c, n]) => html`<span><i class="lg st-${c}"></i>${n}</span>`)}</div>`;
  const sum = d.month?.summary;
  const panel = html`
    <div class="dh"><h2>${d.name}</h2><span class="muted">${new Date(S.attDate + 'T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</span></div>
    ${d.month ? monthGrid(S.attDate.slice(0, 7), d.month.rows) : ''}${legend}
    ${sum ? html`<div class="bal"><div><b>${sum.present}</b><span>present</span></div><div><b>${sum.half}</b><span>half</span></div><div><b>${sum.absent}</b><span>absent</span></div><div><b>${sum.leave + sum.unpaidLeave}</b><span>leave</span></div><div><b>${sum.otHours.toFixed(1).replace(/\.0$/, '')}</b><span>OT h</span></div></div>` : ''}
    ${d.mark && d.sel ? html`<form class="form" data-form="mark"><h3>Mark ${new Date(S.attDate + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</h3>
      <div class="grid2"><label>Status<select id="m-status"><option value="">From times</option><option value="P">Present</option><option value="H">Half day</option><option value="A">Absent</option></select></label><span></span>
      <label>In<input id="m-in" type="time" /></label><label>Out<input id="m-out" type="time" /></label></div>
      <label>Reason (needed to change an existing mark)<input id="m-reason" /></label>
      <p class="note">Supervisors mark their own team. Changing a mark that already exists needs HR. Once payroll for the month is approved, the sheet is locked.</p>
      <button type="submit">Save mark</button></form>` : ''}`;
  if (!d.view) return html`${head('Attendance', 'Your own month.')}<div class="card">${panel}</div>`;
  return html`
  ${head('Attendance', 'One row per person per day. Shift times drive lateness and overtime; Sundays and holidays are weekly offs.', d.fill ? html`<button data-act="att-fill">Fill gaps: last 30 days</button>` : undefined)}
  <div class="row datebar"><button data-act="att-prev" aria-label="Previous day">‹</button><input id="att-date" type="date" value="${S.attDate}" max="${todayIso()}" aria-label="Date" /><button data-act="att-next" aria-label="Next day">›</button></div>
  <section class="split">
    <div class="card flush"><div class="tablewrap"><table><thead><tr><th>Person</th><th>Status</th><th>In – out</th><th class="r">Late</th><th class="r">OT</th></tr></thead>
    <tbody>${d.rows!.length ? d.rows!.map((r) => html`<tr class="pick ${r.employee_id === d.empId ? 'on' : ''}" data-pick-att="${r.employee_id}" tabindex="0"><td><b>${r.name}</b><br><span class="mono muted">${r.code}</span></td>
      <td>${r.status ? chip(r.status, CODE_NAME[r.status]) : html`<span class="muted">not marked</span>`}${r.locked ? html` <span class="muted" title="Locked by approved payroll">🔒</span>` : ''}</td>
      <td class="num">${r.in_time ? `${String(r.in_time).slice(0, 5)} – ${String(r.out_time).slice(0, 5)}` : ''}</td><td class="r num">${r.late_min ? r.late_min + ' min' : ''}</td><td class="r num">${hours(r.ot_min)}</td></tr>`)
      : html`<tr><td colspan="5" class="empty">Nobody to show for this date.</td></tr>`}</tbody></table></div></div>
    <aside class="card detail">${panel}</aside>
  </section>`;
}

// ───────────── Leave ─────────────
export async function leaveView(): Promise<Raw> {
  const d = await read(async (db) => {
    const my = await hr.myEmployeeRecord(db, uid());
    const team = my ? ((await db.query('SELECT count(*)::int AS n FROM employee WHERE manager_id=$1 AND status=$2', [my.id, 'active'])).rows[0].n as number) > 0 : false;
    const all = await can(db, uid(), 'hr.leave.view', { siteId: site() });
    const scope = S.leaveScope === 'all' && !all ? 'mine' : S.leaveScope === 'team' && !team ? 'mine' : S.leaveScope;
    return { my, team, all, scope, list: await hr.listLeave(db, uid(), scope), bal: my ? await hr.leaveBalance(db, my.id) : [], ref: await hr.hrReference(db) };
  });
  const tab = (k: 'mine' | 'team' | 'all', label: string) => html`<button class="tab ${d.scope === k ? 'on' : ''}" data-act="leave-scope" data-id="${k}">${label}</button>`;
  return html`
  ${head('Leave', 'Apply for leave, and approve it for your team. The balance is a ledger: approvals subtract, cancellations give back, nothing is typed over.')}
  ${d.my ? html`<section class="cols"><div class="card"><h2>My balance ${new Date().getFullYear()}</h2><div class="bal big">${d.bal.map((b) => html`<div><b>${b.paid ? Number(b.balance) : '–'}</b><span>${b.code}</span><small>${b.name}</small></div>`)}</div></div>
    <form class="card form" data-form="apply"><h2>Apply for leave</h2>
      <div class="grid2"><label>Type<select id="lv-type">${d.ref.leaveTypes.map((t) => html`<option value="${t.code}">${t.name}${t.paid ? '' : ' (unpaid)'}</option>`)}</select></label><span></span>
      <label>From<input id="lv-from" type="date" value="${addDays(todayIso(), 7)}" /></label><label>To<input id="lv-to" type="date" value="${addDays(todayIso(), 7)}" /></label></div>
      <label class="inline"><input id="lv-half" type="checkbox"> Half day (single date)</label>
      <label>Reason<input id="lv-reason" /></label>
      <p class="note">Sundays and holidays are not counted. Your line manager or HR decides; nobody decides their own request.</p>
      <button class="primary" type="submit">Send for approval</button></form></section>` : html`<div class="card"><p class="empty">Your account is not linked to an employee record, so you cannot apply for leave.</p></div>`}
  <div class="row tabs" style="margin-top:18px">${tab('mine', 'My requests')}${d.team ? tab('team', 'My team') : ''}${d.all ? tab('all', 'Everyone') : ''}</div>
  <div class="card flush"><div class="tablewrap"><table><thead><tr><th>No.</th><th>Person</th><th>Type</th><th>Dates</th><th class="r">Days</th><th>Status</th><th></th></tr></thead>
  <tbody>${d.list.length ? d.list.map((l) => html`<tr><td class="mono">${l.number}</td><td>${l.employee}</td><td>${l.leave_type}</td><td>${dateOnly(l.from_date)}${l.to_date !== l.from_date ? ' – ' + dateOnly(l.to_date) : ''}<br><small>${l.reason}${l.decision_note ? ' · ' + l.decision_note : ''}</small></td><td class="r num">${Number(l.days)}</td><td>${chip(l.status)}</td>
    <td class="acts">${l.status === 'pending' && l.applied_by !== uid() ? html`<button data-act="lv-yes" data-id="${l.id}" data-v="${l.version}">Approve</button><button class="ghost" data-act="lv-no" data-id="${l.id}" data-v="${l.version}">Reject</button>` : ''}
      ${['pending', 'approved'].includes(l.status) && l.applied_by === uid() ? html`<button class="ghost" data-act="lv-cancel" data-id="${l.id}" data-v="${l.version}">Cancel</button>` : ''}</td></tr>`) : html`<tr><td colspan="7" class="empty">Nothing here.</td></tr>`}</tbody></table></div>
  <div class="bar2 foot"><input id="lv-note" placeholder="Note (needed to reject or cancel)" aria-label="Note" /></div></div>`;
}

// ───────────── Payroll ─────────────
export async function payrollView(): Promise<Raw> {
  const d = await read(async (db) => {
    const runs = await hr.listPayrollRuns(db, uid());
    const salary = await hr.listSalary(db, uid());
    const caps = { create: await can(db, uid(), 'hr.payroll.create', { siteId: site() }), approve: await can(db, uid(), 'hr.payroll.approve', { siteId: site() }), propose: await can(db, uid(), 'hr.salary.propose', { siteId: site() }), decide: await can(db, uid(), 'hr.salary.approve', { siteId: site() }) };
    let tab: 'runs' | 'salary' | 'mine' = S.payTab;
    if (tab === 'runs' && !runs) tab = 'mine';
    if (tab === 'salary' && !salary) tab = runs ? 'runs' : 'mine';
    const run = runs?.find((r) => r.id === S.runId) ?? runs?.[0] ?? null;
    const slips = tab === 'runs' && run ? await hr.listPayslips(db, uid(), run.id) : tab === 'mine' ? await hr.listPayslips(db, uid()) : [];
    const emps = salary ? (await hr.listEmployees(db, uid())).map((e) => ({ id: e.id, label: `${e.code} · ${e.name}` })) : [];
    return { runs, salary, caps, tab, run, slips, emps };
  });
  const pm = prevMonth();
  const tabBtn = (k: string, label: string) => html`<button class="tab ${d.tab === k ? 'on' : ''}" data-act="pay-tab" data-id="${k}">${label}</button>`;
  const tabs = html`<div class="row tabs">${d.runs ? tabBtn('runs', 'Payroll runs') : ''}${d.salary ? tabBtn('salary', 'Salary structures') : ''}${tabBtn('mine', 'My payslips')}</div>`;
  const slipCard = (s: (typeof d.slips)[number]) => html`
    <div class="dh"><h2>${s.name}</h2><span class="muted">${monthLabel(s.period)}</span></div>
    <div class="tablewrap"><table class="mini slip"><thead><tr><th>Earnings</th><th class="r">₹</th></tr></thead><tbody>
      <tr><td>Basic (${Number(s.paid_days)} of ${s.days_in_month} days)</td><td class="r num">${money(s.basic)}</td></tr><tr><td>House rent allowance</td><td class="r num">${money(s.hra)}</td></tr><tr><td>Other allowance</td><td class="r num">${money(s.other_allowance)}</td></tr>
      ${Number(s.ot_amount) ? html`<tr><td>Overtime (${Number(s.ot_hours)} h at double rate)</td><td class="r num">${money(s.ot_amount)}</td></tr>` : ''}
      <tr class="tot"><td>Gross</td><td class="r num">${money(s.gross)}</td></tr></tbody>
      <thead><tr><th>Deductions</th><th></th></tr></thead><tbody>
      <tr><td>Provident fund (12% of basic, wage capped)</td><td class="r num">${money(s.pf_employee)}</td></tr><tr><td>ESI (0.75%)</td><td class="r num">${money(s.esi_employee)}</td></tr><tr><td>Professional tax</td><td class="r num">${money(s.prof_tax)}</td></tr>
      <tr class="tot"><td>Total deductions</td><td class="r num">${money(s.total_deductions)}</td></tr></tbody>
      <tbody><tr class="net"><td>Net pay</td><td class="r num">${money(s.net)}</td></tr></tbody></table></div>
    ${Number(s.lop_days) ? html`<p class="note">${Number(s.lop_days)} day(s) without pay.</p>` : ''}`;

  let body: Raw;
  if (d.tab === 'mine') {
    const pick = d.slips.find((s) => s.id === S.slipId) ?? d.slips[0];
    body = d.slips.length ? html`<section class="split"><div class="card flush"><div class="tablewrap"><table><thead><tr><th>Month</th><th class="r">Net pay</th></tr></thead><tbody>${d.slips.map((s) => html`<tr class="pick ${s.id === pick.id ? 'on' : ''}" data-pick-slip="${s.id}" tabindex="0"><td>${monthLabel(s.period)}</td><td class="r num">${money(s.net)}</td></tr>`)}</tbody></table></div></div><aside class="card detail">${slipCard(pick)}</aside></section>`
      : html`<div class="card"><p class="empty">No payslips yet. Your payslip appears here once Finance approves the month's payroll.</p></div>`;
  } else if (d.tab === 'salary' && d.salary) {
    body = html`
    ${d.caps.propose ? html`<form class="card form" data-form="salary"><h2>Propose a salary</h2><div class="grid2">
      <label>Employee<select id="sl-emp">${opts(d.emps)}</select></label><label>Effective from<input id="sl-from" type="date" value="${todayIso()}" /></label>
      <label>Basic (₹ / month)<input id="sl-basic" inputmode="decimal" /></label><label>HRA<input id="sl-hra" inputmode="decimal" value="0" /></label><label>Other allowance<input id="sl-oth" inputmode="decimal" value="0" /></label></div>
      <p class="note">HR proposes, Finance approves. Nobody can propose or approve their own pay, and a change cannot reach back into a month that is already closed.</p><button type="submit">Propose</button></form>` : ''}
    <div class="card flush" style="margin-top:14px"><div class="tablewrap"><table><thead><tr><th>Person</th><th>From</th><th class="r">Basic</th><th class="r">HRA</th><th class="r">Other</th><th>Status</th><th>By</th><th></th></tr></thead>
    <tbody>${d.salary.map((s) => html`<tr><td>${s.name}</td><td>${dateOnly(s.effective_from)}</td><td class="r num">${money(s.basic)}</td><td class="r num">${money(s.hra)}</td><td class="r num">${money(s.other_allowance)}</td><td>${chip(s.status)}</td><td class="muted">${s.proposed_by}${s.approved_by ? ' → ' + s.approved_by : ''}</td>
      <td class="acts">${s.status === 'proposed' && d.caps.decide ? html`<button data-act="sl-yes" data-id="${s.id}">Approve</button><button class="ghost" data-act="sl-no" data-id="${s.id}">Reject</button>` : ''}</td></tr>`)}</tbody></table></div></div>`;
  } else {
    const run = d.run;
    const hasPm = d.runs!.some((r) => r.period.startsWith(pm));
    const sumPf = d.slips.reduce((a, s) => a + Number(s.pf_employer) + Number(s.esi_employer), 0);
    body = html`
    ${d.caps.create ? html`<section class="cols"><form class="card form" data-form="newrun"><h2>Run payroll</h2><label>Month<input id="pr-month" type="month" value="${pm}" max="${pm}" /></label>
      <p class="note">Only a completed month can be run. Every day needs an attendance mark first. The result is a draft you can recalculate; approval by a different person makes it final.</p>
      <button class="primary" type="submit">Calculate draft</button></form>
      <div class="card"><h2>See it end to end</h2><p class="sub">${hasPm ? `${monthLabel(pm)} already has a run. Open it below.` : `Plays ${monthLabel(pm)} as HR and Finance would: calculate, a refused self-approval, a late attendance change that blocks approval, recalculate, approve, then the lock.`}</p>
      <button class="primary" data-act="pay-walk" ${hasPm || S.running ? raw('disabled') : ''}>${S.running ? 'Running…' : 'Play the payroll example'}</button>
      ${S.payLog.length ? html`<ol class="steps">${S.payLog.map((s) => html`<li class="${s.ok && s.note?.startsWith('Refused') ? 'refused' : s.ok ? 'done' : 'fail'}"><span class="who">${(PEOPLE[s.who]?.role ?? s.who).split(' · ')[0]}</span><div><b>${s.text}</b>${s.note ? html`<small>${s.note}</small>` : ''}</div></li>`)}</ol>` : ''}</div></section>` : ''}
    <section class="split" style="margin-top:18px"><div class="card flush"><div class="tablewrap"><table><thead><tr><th>Run</th><th>Month</th><th>Status</th><th class="r">Net</th></tr></thead>
      <tbody>${d.runs!.length ? d.runs!.map((r) => html`<tr class="pick ${r.id === run?.id ? 'on' : ''}" data-pick-run="${r.id}" tabindex="0"><td class="mono">${r.number}</td><td>${monthLabel(r.period)}</td><td>${chip(r.status)}</td><td class="r num">${money(r.total_net)}</td></tr>`) : html`<tr><td colspan="4" class="empty">No payroll runs yet.</td></tr>`}</tbody></table></div></div>
      <aside class="card detail wide">${run ? html`
        <div class="dh"><h2 class="mono">${run.number}</h2>${chip(run.status)}</div>
        ${kv('Month', monthLabel(run.period))}${kv('People paid', run.slips)}${kv('Gross', money(run.total_gross))}${kv('Net pay', money(run.total_net))}${kv('Employer PF + ESI', money(String(sumPf)))}${kv('Prepared by', run.created_by)}${kv('Approved by', run.approved_by ?? '–')}
        ${(run.warnings as string[]).length ? html`<div class="pending"><b>Left out of this run</b>${(run.warnings as string[]).map((w) => html`<span>${w}</span>`)}</div>` : ''}
        ${run.status === 'draft' ? html`<div class="row">${d.caps.approve ? html`<button class="primary" data-act="pr-approve" data-id="${run.id}" data-v="${run.version}">Approve (final)</button>` : ''}${d.caps.create ? html`<button data-act="pr-recalc" data-id="${run.id}" data-v="${run.version}">Recalculate</button><button class="ghost" data-act="pr-cancel" data-id="${run.id}" data-v="${run.version}">Cancel draft</button>` : ''}</div>
          <p class="note">Approval is refused if attendance, leave or salary changed since this draft was calculated. It must be a different person from whoever prepared it.</p>` : html`<p class="note">Approved and final. The month's attendance and these payslips are locked.</p>`}
        <h3>Payslips</h3><div class="tablewrap"><table class="mini"><thead><tr><th>Person</th><th class="r">Days</th><th class="r">Gross</th><th class="r">Ded.</th><th class="r">Net</th></tr></thead>
        <tbody>${d.slips.map((s) => html`<tr><td>${s.name}</td><td class="r num">${Number(s.paid_days)}</td><td class="r num">${money(s.gross)}</td><td class="r num">${money(s.total_deductions)}</td><td class="r num"><b>${money(s.net)}</b></td></tr>`)}</tbody></table></div>
        <p class="note">Statutory rates here (PF 12% on wage capped at ₹15,000, ESI 0.75% up to ₹21,000 gross, flat professional tax) are common defaults. Confirm them with your accountant, and note that income tax (TDS) is not handled yet.</p>` : html`<p class="empty">Select a run.</p>`}</aside></section>`;
  }
  return html`${head('Payroll', 'Pay comes from signed-off attendance, approved leave and an approved salary, calculated to the paisa. Preparing and approving are different people.')}${tabs}${body}`;
}

// ───────────── events ─────────────
const nowYear = () => new Date().getFullYear();
export async function onClick(t: HTMLElement): Promise<boolean> {
  const pick = (a: string) => (t.closest(`[data-${a}]`) as HTMLElement | null)?.dataset[a.replace(/-(\w)/g, (_, c) => c.toUpperCase())];
  const pe = pick('pick-emp'); if (pe) { S.empId = pe; S.open.delete('exit'); await R.render(); return true; }
  const pa = pick('pick-att'); if (pa) { S.attEmp = pa; await R.render(); return true; }
  const pr = pick('pick-run'); if (pr) { S.runId = pr; await R.render(); return true; }
  const ps = pick('pick-slip'); if (ps) { S.slipId = ps; await R.render(); return true; }
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b) return false;
  const a = b.dataset.act!, id = b.dataset.id ?? '', v = Number(b.dataset.v ?? 0);
  const flip = async (k: string) => { S.open.has(k) ? S.open.delete(k) : S.open.add(k); await R.render(); return true; };
  switch (a) {
    case 'toggle-newemp': return flip('newemp');
    case 'toggle-exit': return flip('exit');
    case 'toggle-empall': S.empAll = !S.empAll; await R.render(); return true;
    case 'att-prev': S.attDate = addDays(S.attDate, -1); await R.render(); return true;
    case 'att-next': if (S.attDate < todayIso()) S.attDate = addDays(S.attDate, 1); await R.render(); return true;
    case 'att-fill': await act('Gaps filled: Sundays and holidays as offs, everyone else present', (c) => hr.fillDefaultAttendance(c, { siteId: site(), from: addDays(todayIso(), -30), to: addDays(todayIso(), -1) })); return true;
    case 'leave-scope': S.leaveScope = id as typeof S.leaveScope; await R.render(); return true;
    case 'lv-yes': await act('Leave approved. Balance and attendance updated', (c) => hr.decideLeave(c, { leaveId: id, expectedVersion: v, approve: true, note: val('lv-note') || undefined })); return true;
    case 'lv-no': await act('Leave rejected', (c) => hr.decideLeave(c, { leaveId: id, expectedVersion: v, approve: false, note: val('lv-note') })); return true;
    case 'lv-cancel': await act('Leave cancelled', (c) => hr.cancelLeave(c, { leaveId: id, expectedVersion: v, reason: val('lv-note') || 'Cancelled by applicant' })); return true;
    case 'pay-tab': S.payTab = id as typeof S.payTab; await R.render(); return true;
    case 'sl-yes': await act('Salary approved', (c) => hr.decideSalary(c, { salaryId: id, approve: true })); return true;
    case 'sl-no': await act('Salary rejected', (c) => hr.decideSalary(c, { salaryId: id, approve: false })); return true;
    case 'pr-approve': await act('Payroll approved. The month is now locked', (c) => hr.approvePayrollRun(c, { runId: id, expectedVersion: v })); return true;
    case 'pr-recalc': await act('Recalculated from today’s sheets', (c) => hr.recalculatePayrollRun(c, { runId: id, expectedVersion: v })); return true;
    case 'pr-cancel': await act('Draft cancelled', (c) => hr.cancelPayrollRun(c, { runId: id, expectedVersion: v, reason: 'Cancelled from the payroll screen' })); return true;
    case 'pay-walk': {
      const { runPayrollExample } = await import('./walkthrough.js');
      S.running = true; S.payLog = []; await R.render();
      try { const r = await runPayrollExample(K.world, (s) => { S.payLog.push(s); R.scheduleRender(); }); S.runId = r.runId; toast('Payroll example complete'); }
      catch (e) { toast((e as Error).message, 'bad'); }
      S.running = false; await R.render(); return true;
    }
  }
  void nowYear;
  return false;
}

export async function onSubmit(form: string): Promise<boolean> {
  const nul = (s: string) => s || null;
  switch (form) {
    case 'newemp': {
      const r = await act('Employee created', (c) => hr.createEmployee(c, { name: val('ne-name'), siteId: site(), joinDate: val('ne-join'), departmentId: nul(val('ne-dept')), designationId: nul(val('ne-desig')), managerId: nul(val('ne-mgr')), shiftId: nul(val('ne-shift')), empType: val('ne-type'), phone: nul(val('ne-phone')), bankAccount: nul(val('ne-bank')) }));
      if (r) { S.open.delete('newemp'); S.empId = (r as { id: string }).id; await R.render(); } return true;
    }
    case 'editemp': {
      const ver = (await read((db) => hr.listEmployees(db, uid(), { includeExited: true }))).find((e) => e.id === S.empId)!.version;
      await act('Saved', (c) => hr.updateEmployee(c, { employeeId: S.empId, expectedVersion: ver, changes: { phone: nul(val('ee-phone')), departmentId: nul(val('ee-dept')), designationId: nul(val('ee-desig')), managerId: nul(val('ee-mgr')) } })); return true;
    }
    case 'exitemp': {
      const ver = (await read((db) => hr.listEmployees(db, uid()))).find((e) => e.id === S.empId)!.version;
      const r = await act('Exit recorded. Their sign-in is closed', (c) => hr.exitEmployee(c, { employeeId: S.empId, expectedVersion: ver, exitDate: val('ex-date'), reason: val('ex-reason') }));
      if (r) { S.open.delete('exit'); await R.render(); } return true;
    }
    case 'mark': {
      const emp = S.attEmp || (await read((db) => hr.dailyAttendance(db, uid(), site(), S.attDate)))?.[0]?.employee_id || '';
      const st = val('m-status') as 'P' | 'A' | 'H' | '';
      await act('Attendance saved', (c) => hr.markAttendance(c, { employeeId: emp, date: S.attDate, status: st || undefined, inTime: nul(val('m-in')), outTime: nul(val('m-out')), reason: val('m-reason') || undefined })); return true;
    }
    case 'apply': {
      await act('Leave sent for approval', (c) => hr.applyLeave(c, { leaveType: val('lv-type'), from: val('lv-from'), to: val('lv-to'), halfDay: checked('lv-half'), reason: val('lv-reason') })); return true;
    }
    case 'salary': {
      await act('Salary proposed. Finance must approve it', (c) => hr.proposeSalary(c, { employeeId: val('sl-emp'), effectiveFrom: val('sl-from'), basic: val('sl-basic'), hra: val('sl-hra') || '0', otherAllowance: val('sl-oth') || '0' })); return true;
    }
    case 'newrun': {
      const r = await act('Draft calculated', (c) => hr.createPayrollRun(c, { siteId: site(), period: val('pr-month') }));
      if (r) { S.runId = (r as { id: string }).id; await R.render(); } return true;
    }
  }
  return false;
}
export { prevMonth };
