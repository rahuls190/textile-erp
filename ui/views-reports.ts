import { html, raw, esc, when, money, type Raw } from './lib.js';
import { S, uid, read, act, head, denied, R, toast, todayIso, prevMonth } from './ctx.js';
import * as reports from '../src/domain/reports.js';
import * as custom from '../src/domain/custom-reports.js';
import * as ai from '../src/domain/ai.js';

type List = Awaited<ReturnType<typeof reports.listReports>>;
type Out = Awaited<ReturnType<typeof reports.runReport>>;
type Col = reports.Column;

let last: Out | null = null;            // result of the last run; kept so re-drawing the page never re-runs (and re-audits) a report
let cache: List = [];
let lastCustom: { explain: string[]; source: string; note?: string; question: string; spec: custom.Spec } | null = null;
let saved: Awaited<ReturnType<typeof custom.listSaved>> = [];
let aiq = '';
let repId = '';
const EXAMPLES: Record<string, string> = { purchase_orders: 'Total purchase value by vendor, last 90 days', po_lines: 'Rejected quantity by item', stock_lots: 'Accepted stock by item', qc: 'Inspections by outcome this year', employees: 'How many employees by department', attendance: 'Top 5 employees by late minutes this month', leave: 'Leave days by type this year', payslips: 'Net pay by month' };

const dflt = (d: reports.ParamDef): string => {
  const t = todayIso();
  switch (d.default) {
    case 'ago90': return new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    case 'today': return t;
    case 'this_month': return t.slice(0, 7);
    case 'last_month': return prevMonth();
    case 'this_year': return t.slice(0, 4);
    default: return '';
  }
};
const nf = (n: number, d = 2) => n.toLocaleString('en-IN', { maximumFractionDigits: d });
const cell = (c: Col, v: unknown): string => {
  if (v === null || v === undefined || v === '') return '';
  if (c.kind === 'money') return '₹' + nf(Number(v), 0);
  if (c.kind === 'num') return nf(Number(v));
  if (c.kind === 'pct') return nf(Number(v)) + '%';
  return c.key === 'status' ? String(v).replace(/_/g, ' ') : String(v);
};
const csvOf = (o: Out) => {
  const q = (v: string) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const lines = [o.columns.map((c) => q(c.label)).join(',')];
  for (const r of o.rows) lines.push(o.columns.map((c) => q(r[c.key] === null || r[c.key] === undefined ? '' : String(r[c.key]))).join(','));
  return lines.join('\n') + '\n';
};

function bars(o: Out): Raw {
  if (!o.chart) return raw('');
  const ch = o.chart;
  const rows = ((o as unknown as { chartRows: Record<string, string | number | null>[] }).chartRows ?? o.rows).slice(0, 12);
  const max = Math.max(...rows.map((r) => Number(r[ch.valueKey]) || 0), 0.0001);
  return html`<div class="rp-chart"><h3>${ch.title}</h3>${rows.map((r) => {
    const v = Number(r[ch.valueKey]) || 0;
    return html`<div class="rp-bar"><span class="rp-l" title="${String(r[ch.labelKey])}">${String(r[ch.labelKey])}</span><span class="rp-t"><i style="width:${Math.max(2, (v / max) * 100)}%"></i></span><b>${ch.unit === '₹' ? '₹' + nf(v, 0) : nf(v) + (ch.unit && ch.unit !== '₹' ? ' ' + ch.unit : '')}</b></div>`;
  })}</div>`;
}

const body = (o: Out): Raw => html`
    <div class="rp-sum">${o.summary.map((s) => html`<div class="rp-tile"><span>${s.label}</span><b>${s.value}</b></div>`)}</div>
    ${o.note ? html`<p class="sub">${o.note}</p>` : ''}
    ${bars(o)}
    <div class="rp-actions"><button data-act="rp-copy">Copy CSV</button><button data-act="rp-download">Download CSV</button><small>${o.rows.length} row(s) · run ${when(o.ranAt)}</small></div>
    ${o.rows.length ? html`<div class="tablewrap"><table class="mini"><thead><tr>${o.columns.map((c) => html`<th class="${c.kind === 'text' || c.kind === 'date' ? '' : 'r'}">${c.label}</th>`)}</tr></thead>
      <tbody>${o.rows.map((r) => html`<tr>${o.columns.map((c) => html`<td class="${c.kind === 'text' || c.kind === 'date' ? '' : 'r'}">${cell(c, r[c.key])}</td>`)}</tr>`)}</tbody></table></div>` : html`<p class="empty">Nothing matches these filters.</p>`}`;

const customHead = (): Raw => lastCustom ? html`<div class="ai-read"><b>How I read your request ${lastCustom.source === 'ai' ? html`<span class="chip info">AI</span>` : html`<span class="chip neutral">Built-in reader</span>`}</b>
  <ul>${lastCustom.explain.map((l) => html`<li>${l}</li>`)}</ul>${lastCustom.note ? html`<small>${lastCustom.note}</small>` : ''}${last?.sensitive ? html`<p class="rp-warn">Sensitive figures. Your name and this request are recorded.</p>` : ''}</div>` : raw('');
const saveForm = (): Raw => lastCustom && !repId ? html`<form class="rp-save" data-form="savereport"><b>Keep this report</b><input id="sv-name" placeholder="Name it" maxlength="60" value="${(lastCustom.spec.title ?? '').slice(0, 60)}" required /><label class="inl"><input id="sv-shared" type="checkbox" /> Share with others who can see this data</label><button type="submit">Save</button></form>` : raw('');

export async function reportsView(): Promise<Raw> {
  const d = await read(async (db) => ({ list: await reports.listReports(db, uid()), runs: await reports.recentRuns(db, uid(), 8), ds: await custom.availableDatasets(db, uid()), saved: await custom.listSaved(db, uid()) }));
  cache = d.list; saved = d.saved;
  if (!d.list.length && !d.ds.length) return denied('Reports', 'Figures from across the business.', 'Your role has no reports.');
  const isCustom = S.rep === '__custom';
  const sel = d.list.find((r) => r.key === S.rep) ?? null;
  const groups = ['Buying & stock', 'People', 'Control'].map((g) => ({ g, items: d.list.filter((r) => r.group === g) })).filter((x) => x.items.length);
  const o = isCustom ? last : last && sel && last.key === sel.key ? last : null;
  const savedItem = (r: (typeof saved)[number]) => html`<li class="rp-sv"><button class="rp-item ${isCustom && repId === r.id ? 'on' : ''}" data-act="rp-saved" data-id="${r.id}"><b>${r.name}</b><small>${r.mine ? (r.shared ? 'Shared by you' : 'Only you') : 'Shared by ' + r.owner}</small></button>${r.mine ? html`<button class="rp-x" data-act="rp-del" data-id="${r.id}" title="Delete this saved report" aria-label="Delete ${r.name}">×</button>` : ''}</li>`;
  const mineList = d.saved.filter((r) => r.mine), theirs = d.saved.filter((r) => !r.mine);
  const picker = [...(mineList.length ? [html`<h3>My reports</h3><ul class="rp-list">${mineList.map(savedItem)}</ul>`] : []), ...(theirs.length ? [html`<h3>Shared with me</h3><ul class="rp-list">${theirs.map(savedItem)}</ul>`] : []), ...groups.map((x) => html`<h3>${x.g}</h3><ul class="rp-list">${x.items.map((r) => html`<li><button class="rp-item ${sel?.key === r.key ? 'on' : ''}" data-act="rp-pick" data-id="${r.key}"><b>${r.title}</b>${r.sensitive ? html` <span class="chip warn">Sensitive</span>` : ''}<small>${r.description}</small></button></li>`)}</ul>`)];
  const form = sel ? html`<form class="rp-form" data-form="report">${sel.params.map((p) => html`<label>${p.label}<input id="rp-${p.key}" type="${p.kind === 'date' ? 'date' : p.kind === 'month' ? 'month' : 'number'}" value="${S.repP[p.key] ?? dflt(p)}" ${p.kind === 'year' ? raw('min="2000" max="2100" step="1"') : ''} required /></label>`)}
      <button class="primary" type="submit">Run report</button></form>` : '';
  const result = isCustom ? (o ? html`${customHead()}${body(o)}${saveForm()}` : html`<p class="empty">Describe a report above, or open one you saved.</p>`)
    : !sel ? html`<p class="empty">Choose a report on the left, or ask for a custom one above.</p>` : !o ? html`<p class="empty">Set the filters and press <b>Run report</b>. Each run is recorded in the audit trail.</p>` : body(o);
  return html`
  ${head('Reports', 'Figures from across the business. You only see reports your role allows, limited to your sites.')}
  <div class="card ai"><h2>Ask for a report</h2><p class="sub">Describe what you want in your own words. The assistant sets up the report; it can only use data your role allows, and it runs with your rights.</p>
    <form class="ai-form" data-form="ask"><input id="ai-q" value="${aiq}" maxlength="400" autocomplete="off" placeholder="e.g. Total purchase value by vendor, last 90 days, top 5" /><button class="primary" type="submit">Build report</button></form>
    <div class="ai-ex">${d.ds.slice(0, 5).map((x) => html`<button type="button" class="chip neutral" data-act="ai-ex" data-id="${EXAMPLES[x.key] ?? ''}">${EXAMPLES[x.key] ?? x.label}</button>`)}</div></div>
  <section class="split rp">
    <div class="card">${picker}</div>
    <div class="card"><h2>${isCustom ? (last?.title ?? 'Custom report') : sel ? sel.title : 'Report'}</h2>${sel ? html`<p class="sub">${sel.description}</p>${sel.sensitive ? html`<p class="rp-warn">Sensitive figures. Your name and the filters are recorded each time this is run.</p>` : ''}` : ''}${form}${result}</div>
  </section>
  ${d.runs && d.runs.length ? html`<div class="card"><h2>Recent report runs</h2><p class="sub">Shown to people who can read the audit trail.</p><div class="tablewrap"><table class="mini"><thead><tr><th>When</th><th>Who</th><th>Report</th><th>Filters</th><th class="r">Rows</th></tr></thead><tbody>${d.runs.map((r: { at: string; actor: string; report: string; params: Record<string, string>; rows: number }) => html`<tr><td>${r.at}</td><td>${r.actor}</td><td>${r.report}</td><td>${Object.entries(r.params ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ')}</td><td class="r">${r.rows}</td></tr>`)}</tbody></table></div></div>` : ''}`;
}

async function run() {
  const sel = cache.find((r) => r.key === S.rep); if (!sel) return;
  const p: Record<string, string> = {};
  for (const d of sel.params) p[d.key] = (document.getElementById('rp-' + d.key) as HTMLInputElement | null)?.value ?? '';
  S.repP = p;
  try {
    last = await read((db) => reports.runReport(db, { id: uid(), username: S.user }, sel.key, p));
  } catch (e) { last = null; toast((e as Error).message, 'bad'); }
  await R.render();
}

async function showCustom(out: Awaited<ReturnType<typeof custom.runCustom>>, extra: { source: string; note?: string; question: string }) {
  last = out as unknown as Out; S.rep = '__custom';
  lastCustom = { explain: out.explain, spec: out.spec, source: extra.source, note: extra.note, question: extra.question };
}

export async function onClick(t: HTMLElement): Promise<boolean> {
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b) return false;
  switch (b.dataset.act) {
    case 'ai-ex': aiq = b.dataset.id ?? ''; await R.render(); return true;
    case 'rp-saved': {
      try {
        const out = await read((db) => custom.runSaved(db, { id: uid(), username: S.user }, b.dataset.id!));
        const sr = saved.find((x) => x.id === b.dataset.id);
        repId = b.dataset.id!; await showCustom(out, { source: 'saved', question: sr?.question ?? '', note: sr && !sr.mine ? `Shared by ${sr.owner}. It runs with your own access, so you may see different rows.` : undefined });
      } catch (e) { toast((e as Error).message, 'bad'); }
      await R.render(); return true;
    }
    case 'rp-del': {
      await act('Saved report deleted', (c) => custom.deleteSaved(c, { id: b.dataset.id! }));
      if (repId === b.dataset.id) { repId = ''; last = null; lastCustom = null; S.rep = ''; }
      await R.render(); return true;
    }
    case 'rp-pick': S.rep = b.dataset.id!; S.repP = {}; last = null; lastCustom = null; repId = ''; await R.render(); return true;
    case 'rp-copy': {
      if (!last) return true;
      try { await navigator.clipboard.writeText(csvOf(last)); toast('CSV copied'); } catch { toast('Copy was blocked here. Use Download CSV on the hosted site.', 'bad'); }
      return true;
    }
    case 'rp-download': {
      if (!last) return true;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csvOf(last)], { type: 'text/csv' }));
      a.download = `${last.key}-${todayIso()}.csv`; document.body.appendChild(a); a.click(); a.remove();
      toast('If nothing downloaded, use Copy CSV (downloads are blocked in some previews)');
      return true;
    }
  }
  return false;
}
export async function onSubmit(form: string): Promise<boolean> {
  if (form === 'report') { await run(); return true; }
  if (form === 'ask') {
    aiq = (document.getElementById('ai-q') as HTMLInputElement).value.trim();
    try {
      const it = await read(async (db) => { const i = await ai.interpret(db, uid(), aiq); return { i, out: await custom.runCustom(db, { id: uid(), username: S.user }, i.spec, 'manual', aiq) }; });
      repId = ''; await showCustom(it.out, { source: it.i.source, note: it.i.note, question: aiq });
    } catch (e) { toast((e as Error).message, 'bad'); }
    await R.render(); return true;
  }
  if (form === 'savereport') {
    const name = (document.getElementById('sv-name') as HTMLInputElement).value, shared = (document.getElementById('sv-shared') as HTMLInputElement).checked;
    if (!lastCustom) return true;
    const r = await act('Report saved', (c) => custom.saveCustom(c, { name, spec: lastCustom!.spec, shared, question: lastCustom!.question }));
    if (r) { repId = r.id; await R.render(); }
    return true;
  }
  return false;
}
void act; void esc; void money;
