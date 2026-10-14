import { html, raw, qty, type Raw } from './lib.js';
import { K, S, uid, read, head, PEOPLE } from './ctx.js';
import type { View } from './ctx.js';
import * as po from '../src/domain/po.js';
import * as qc from '../src/domain/qc.js';
import * as q from '../src/domain/queries.js';
import * as owner from '../src/domain/owner.js';
import { can, visibleSites } from '../src/core/permissions.js';

const num = (v: unknown) => Number(v) || 0;
const nf = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
const KIND_VIEW: Record<string, View> = { purchase_order: 'po', stock_adjustment: 'stock', leave_request: 'leave', salary_structure: 'payroll', payroll_run: 'payroll' };
const KIND: Record<string, string> = { purchase_order: 'Order', stock_adjustment: 'Adjustment', leave_request: 'Leave', salary_structure: 'Pay change', payroll_run: 'Payroll' };

type Seg = { v: number; cls: string; label: string };

/** Ring chart. Segments draw themselves in when the page opens. */
function ring(parts: Seg[], big: string, small: string): Raw {
  const total = parts.reduce((a, p) => a + p.v, 0);
  let off = 25;                                                       // start at 12 o'clock
  const segs = total > 0 ? parts.filter((p) => p.v > 0).map((p, i) => {
    const len = (p.v / total) * 100;
    const el = `<circle class="seg ${p.cls}" r="15.9155" cx="21" cy="21" fill="none" stroke-width="5" stroke-dasharray="${Math.max(0, len - 0.6)} ${100 - Math.max(0, len - 0.6)}" stroke-dashoffset="${off}" style="animation-delay:${i * 120}ms"><title>${p.label}: ${nf(p.v)}</title></circle>`;
    off -= len; return el;
  }).join('') : '';
  return raw(`<div class="ringbox"><svg viewBox="0 0 42 42" class="ring" role="img" aria-label="${parts.map((p) => `${p.label} ${nf(p.v)}`).join(', ')}"><circle r="15.9155" cx="21" cy="21" fill="none" class="track" stroke-width="5"/>${segs}</svg><div class="ringc"><b>${big}</b><small>${small}</small></div></div>`);
}
const legend = (parts: Seg[]) => html`<ul class="lg">${parts.map((p) => html`<li><i class="dot ${p.cls}"></i>${p.label}<b>${nf(p.v)}</b></li>`)}</ul>`;

/** Bars that grow in, one per day. */
function spark(days: { d: string; v: number }[], unit: string): Raw {
  const max = Math.max(...days.map((x) => x.v), 1);
  return raw(`<div class="spark" role="img" aria-label="${unit} per day">${days.map((x, i) => `<span class="sp" style="--h:${Math.max(x.v > 0 ? 6 : 2, (x.v / max) * 100)}%;animation-delay:${i * 35}ms" title="${x.d}: ${nf(x.v)} ${unit}"><i class="${x.v > 0 ? 'on' : ''}"></i></span>`).join('')}</div><div class="sp-ax"><small>${days[0]?.d.slice(5)}</small><small>today</small></div>`);
}
function stackBar(parts: Seg[], view: View): Raw {
  const total = parts.reduce((a, p) => a + p.v, 0) || 1;
  return raw(`<div class="pipe">${parts.filter((p) => p.v > 0).map((p, i) => `<button data-view="${view}" class="pp ${p.cls}" style="flex:${p.v};animation-delay:${i * 90}ms" title="${p.label}: ${p.v}"><b>${p.v}</b></button>`).join('')}</div><div class="pipe-l">${parts.map((p) => `<span><i class="dot ${p.cls}"></i>${p.label}</span>`).join('')}</div>`.replace(/\$\{total\}/g, String(total)));
}

export async function overviewView(): Promise<Raw> {
  const me = PEOPLE[S.user] ?? { name: S.user, role: '' };
  const d = await read(async (db) => {
    const sid = K.world.siteId;
    const hasPo = await can(db, uid(), 'po.view', { anySite: true });
    const hasInv = await can(db, uid(), 'inventory.view', { anySite: true });
    const hasQc = await can(db, uid(), 'qc.view', { anySite: true });
    const hasAtt = await can(db, uid(), 'hr.attendance.view', { anySite: true });
    const pos = hasPo ? await po.listPOs(db, uid()) : null;
    const stock = hasInv ? await q.stockSummary(db, uid()) : null;
    const insp = hasQc ? await qc.listInspections(db, uid()) : null;
    const needs = await owner.pendingItems(db, uid());
    let recv: { d: string; v: number }[] | null = null;
    if (hasInv) {
      const sites = await visibleSites(db, uid(), 'inventory.view');
      const rows = (await db.query(
        `SELECT r.received_at::date AS d, sum(rl.qty)::float8 AS v FROM receipt r JOIN receipt_line rl ON rl.receipt_id = r.id
          WHERE ($1::uuid[] IS NULL OR r.site_id = ANY($1::uuid[])) AND r.received_at >= now() - interval '13 days' GROUP BY 1`, [sites])).rows;
      const by = new Map(rows.map((x) => [x.d instanceof Date ? x.d.toISOString().slice(0, 10) : String(x.d).slice(0, 10), num(x.v)]));
      recv = Array.from({ length: 14 }, (_, i) => { const dt = new Date(Date.now() - (13 - i) * 86400000).toISOString().slice(0, 10); return { d: dt, v: by.get(dt) ?? 0 }; });
    }
    let att: { date: string; present: number; absent: number; leave: number; total: number } | null = null;
    if (hasAtt) {
      const sites = await visibleSites(db, uid(), 'hr.attendance.view');
      const last = (await db.query(`SELECT max(a.work_date)::text AS d FROM attendance a JOIN employee e ON e.id = a.employee_id WHERE ($1::uuid[] IS NULL OR e.site_id = ANY($1::uuid[])) AND a.work_date <= current_date AND a.status NOT IN ('WO','HOL')`, [sites])).rows[0]?.d as string | null;
      if (last) {
        const r = (await db.query(`SELECT count(*) FILTER (WHERE a.status IN ('P','H'))::int AS present, count(*) FILTER (WHERE a.status='A')::int AS absent, count(*) FILTER (WHERE a.status IN ('L','LWP'))::int AS leave, count(*)::int AS total
          FROM attendance a JOIN employee e ON e.id = a.employee_id WHERE a.work_date = $2::date AND ($1::uuid[] IS NULL OR e.site_id = ANY($1::uuid[]))`, [sites, last])).rows[0];
        att = { date: last, ...r };
      }
    }
    void sid;
    return { pos, stock, insp, needs, recv, att };
  });

  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const needs = d.needs.slice(0, 5);
  const late = d.needs.filter((n) => n.overdue).length;
  const tiles: Raw[] = [];

  if (d.stock) {
    const sum = (f: 'accepted' | 'held' | 'rejected' | 'reserved' | 'available') => d.stock!.reduce((a, s) => a + num(s[f]), 0);
    const parts: Seg[] = [{ v: sum('available'), cls: 'c-ok', label: 'Free to use' }, { v: sum('reserved'), cls: 'c-info', label: 'Reserved' }, { v: sum('held'), cls: 'c-warn', label: 'On QC hold' }, { v: sum('rejected'), cls: 'c-bad', label: 'Rejected' }];
    tiles.push(html`<button class="card vt" data-view="stock"><h2>Stock</h2>${ring(parts, nf(sum('available')), 'metres free')}${legend(parts)}</button>`);
  }
  if (d.pos) {
    const c = (...s: string[]) => d.pos!.filter((p) => s.includes(p.status)).length;
    const parts: Seg[] = [{ v: c('draft'), cls: 'c-mute', label: 'Draft' }, { v: c('approval_pending'), cls: 'c-warn', label: 'Needs approval' }, { v: c('approved'), cls: 'c-info', label: 'Ready to send' },
      { v: c('released', 'acknowledged'), cls: 'c-acc', label: 'With vendor' }, { v: c('partial_receipt'), cls: 'c-acc2', label: 'Arriving' }, { v: c('completed', 'closed'), cls: 'c-ok', label: 'Done' }];
    tiles.unshift(html`<div class="card vt wide"><h2>Orders on their way</h2><p class="sub">${d.pos.length} purchase order${d.pos.length === 1 ? '' : 's'} · click a block to open</p>${stackBar(parts, 'po')}</div>`);
  }
  if (d.insp) {
    const acc = d.insp.reduce((a, i) => a + num(i.accepted_qty), 0), rej = d.insp.reduce((a, i) => a + num(i.rejected_qty), 0);
    const queue = d.insp.filter((i) => ['pending', 'inspecting', 'submitted', 'partial', 'held'].includes(i.status)).length;
    const parts: Seg[] = [{ v: acc, cls: 'c-ok', label: 'Accepted' }, { v: rej, cls: 'c-bad', label: 'Rejected' }];
    tiles.push(html`<button class="card vt" data-view="quality"><h2>Quality</h2>${ring(parts, acc + rej > 0 ? Math.round((acc / (acc + rej)) * 100) + '%' : '–', 'passed')}<p class="sub">${queue} waiting to be inspected</p></button>`);
  }
  if (d.recv) tiles.push(html`<button class="card vt" data-view="receiving"><h2>Material received</h2><p class="sub">Last 14 days · ${nf(d.recv.reduce((a, x) => a + x.v, 0))} m</p>${spark(d.recv, 'm')}</button>`);
  if (d.att) {
    const a = d.att;
    const parts: Seg[] = [{ v: a.present, cls: 'c-ok', label: 'Present' }, { v: a.leave, cls: 'c-info', label: 'On leave' }, { v: a.absent, cls: 'c-bad', label: 'Absent' }];
    tiles.push(html`<button class="card vt" data-view="attendance"><h2>People</h2><p class="sub">${new Date(a.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}</p>${ring(parts, `${a.present}/${a.total}`, 'present')}${legend(parts)}</button>`);
  }

  return html`
  <section class="hero"><div><h1>${hello}, ${me.name.split(' ')[0]}</h1>
    <p>${needs.length ? html`<b>${d.needs.length}</b> thing${d.needs.length === 1 ? '' : 's'} waiting for approval${late ? html`, <b class="bad-t">${late} past the time limit</b>` : ''}.` : 'Nothing is waiting for you right now.'}</p></div>
    <span class="role-pill">${me.role}</span></section>
  ${needs.length ? html`<section class="card needs-card"><h2>Waiting for approval</h2><ul class="nl">${needs.map((n) => html`<li class="${n.overdue ? 'od' : ''}"><button class="link" data-view="${KIND_VIEW[n.type]}"><span class="chip neutral">${KIND[n.type]}</span> <b>${n.title}</b></button><span class="when">${n.age_hours < 1 ? 'just now' : n.age_hours < 24 ? Math.round(n.age_hours) + ' h' : Math.floor(n.age_hours / 24) + ' d'}${n.escalation ? html` <span class="chip warn">Urgent</span>` : ''}</span></li>`)}</ul>${d.needs.length > needs.length ? html`<button class="link" data-view="${d.needs.length ? 'escalations' : 'overview'}">See all ${d.needs.length}</button>` : ''}</section>` : ''}
  <section class="vgrid">${tiles}</section>
  <details class="card more"><summary><b>Try it: the 500 m worked example</b> <small>(plays the whole buying-to-stock story, including steps the system refuses)</small></summary>
    <button class="primary" data-act="walk" ${S.running ? raw('disabled') : ''}>${S.running ? 'Running…' : 'Run the 500 m example'}</button>
    ${S.log.length ? html`<ol class="steps">${S.log.map((s) => html`<li class="${s.ok && s.note?.startsWith('Refused') ? 'refused' : s.ok ? 'done' : 'fail'}"><span class="who">${PEOPLE[s.who]?.role.split(' · ')[0]}</span><div><b>${s.text}</b>${s.note ? html`<small>${s.note}</small>` : ''}</div></li>`)}</ol>` : html`<p class="empty">Each run adds a new purchase order and roll to the lists.</p>`}
  </details>`;
}
void head; void qty;
