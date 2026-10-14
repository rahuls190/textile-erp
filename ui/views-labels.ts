// Barcode studio: the registry of codes, issuing and printing, and the label designer.
import { html, raw, esc, type Raw } from './lib.js';
import { uid, read, act, R, toast, val, checked, opts } from './ctx.js';
import * as bcs from '../src/domain/barcodes.js';
import { can } from '../src/core/permissions.js';
import JsBarcode from 'jsbarcode';
import qrcode from 'qrcode-generator';

export type LTab = 'codes' | 'issue' | 'layouts';
type El = bcs.Element;
type Layout = { id?: string; name: string; entityType: string; widthMm: number; heightMm: number; columns: number; gapMm: number; elements: El[]; version?: number; is_default?: boolean };

const st = {
  q: '', type: '', status: '', unused: false, limit: 100,
  sel: new Set<string>(), layoutId: '', copies: 1, reason: '',
  draft: null as Layout | null, selEl: -1, last: '' as string, histFor: '' as string, newSeries: false,
};
const KIND_NAME: Record<string, string> = { item: 'Material', lot: 'Roll', location: 'Shelf', employee: 'Staff', carton: 'Carton', asset: 'Asset or tool', generic: 'General' };
const SAMPLE: Record<string, string> = { barcode: 'GRN-0042/1', code: 'GRN-0042/1', item_code: 'FAB-001', item_name: 'Cotton Lycra 4-way', name: 'Cotton Lycra 4-way', unit: 'm', date: '14 Oct 2026', site: 'KP1', qty: '240', kind: 'rack', type: 'Fabric', hsn: '6006', department: 'Stores', note: 'Order 77, 12 pcs' };

// ───────────────────────── drawing ─────────────────────────
const MM_PT = 0.3528;
function barSvg(text: string): { inner: string; w: number; h: number } | null {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  try { JsBarcode(s, text, { format: 'CODE128', displayValue: false, height: 40, width: 2, margin: 0, background: 'transparent', lineColor: '#000' }); } catch { return null; }
  return { inner: s.innerHTML, w: Number(s.getAttribute('width')?.replace('px', '')) || 100, h: Number(s.getAttribute('height')?.replace('px', '')) || 40 };
}
function qrSvg(text: string): { path: string; n: number } {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(); let p = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) p += `M${c} ${r}h1v1h-1z`;
  return { path: p, n };
}
/** One label as an SVG in millimetres, so what the designer shows is what prints. */
export function labelSvg(l: Pick<Layout, 'widthMm' | 'heightMm' | 'elements'>, values: Record<string, string>, code: string, opt: { sel?: number; px?: number } = {}): string {
  const W = l.widthMm, H = l.heightMm;
  const parts = l.elements.map((e, i) => {
    const hi = opt.sel === i ? `<rect x="${e.x}" y="${e.y}" width="${Math.max(e.w, 0.4)}" height="${Math.max(e.h, 0.4)}" fill="rgba(110,70,170,.08)" stroke="#6b46c1" stroke-width="0.3" stroke-dasharray="1 0.8"/>` : '';
    const hit = `<rect data-el="${i}" x="${e.x}" y="${e.y}" width="${Math.max(e.w, 1.5)}" height="${Math.max(e.h, 1.5)}" fill="transparent" class="el-hit"/>`;
    if (e.type === 'line') return `<line x1="${e.x}" y1="${e.y}" x2="${e.x + e.w}" y2="${e.y + e.h}" stroke="#000" stroke-width="0.3"/>${hi}${hit}`;
    if (e.type === 'qr') { const q = qrSvg(code); const s = Math.min(e.w, e.h); return `<svg x="${e.x + (e.w - s) / 2}" y="${e.y + (e.h - s) / 2}" width="${s}" height="${s}" viewBox="-1 -1 ${q.n + 2} ${q.n + 2}" shape-rendering="crispEdges"><rect x="-1" y="-1" width="${q.n + 2}" height="${q.n + 2}" fill="#fff"/><path d="${q.path}" fill="#000"/></svg>${hi}${hit}`; }
    if (e.type === 'barcode') { const b = barSvg(code); if (!b) return `<text x="${e.x}" y="${e.y + 3}" font-size="2.5" fill="#c00">cannot print this code</text>${hi}${hit}`; return `<svg x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" viewBox="0 0 ${b.w} ${b.h}" preserveAspectRatio="none">${b.inner}</svg>${hi}${hit}`; }
    const txt = e.type === 'text' ? (e.text ?? '') : (values[e.field ?? ''] ?? '');
    const fs = (e.size ?? 8) * MM_PT, a = e.align ?? 'left';
    const x = a === 'center' ? e.w / 2 : a === 'right' ? e.w : 0;
    return `<svg x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" overflow="hidden"><text x="${x}" y="${e.h / 2 + fs * 0.35}" font-size="${fs}" font-family="Arial, Helvetica, sans-serif" font-weight="${e.bold ? 700 : 400}" text-anchor="${a === 'center' ? 'middle' : a === 'right' ? 'end' : 'start'}" fill="#000">${esc(txt)}</text></svg>${hi}${hit}`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${opt.px ? opt.px : W + 'mm'}" ${opt.px ? '' : `height="${H}mm"`} class="lbl-svg"><rect width="${W}" height="${H}" fill="#fff"/>${parts}</svg>`;
}

// ───────────────────────── page ─────────────────────────
type Data = Awaited<ReturnType<typeof load>>;
async function load(tab: LTab) {
  return read(async (db) => {
    const p = async (k: string) => can(db, uid(), k, { anySite: true });
    const perms = { view: await p('barcode.view'), issue: await p('barcode.issue'), print: await p('barcode.print'), void: await p('barcode.void'), layout: await p('barcode.layout'), series: await p('barcode.series') };
    if (!perms.view) return { perms, reg: null, series: [] as Awaited<ReturnType<typeof bcs.listSeries>>, layouts: [] as Awaited<ReturnType<typeof bcs.listLayouts>>, sites: [] as { id: string; code: string; name: string }[], selRows: [] as Awaited<ReturnType<typeof bcs.registry>>['rows'] };
    const reg = tab === 'codes' ? await bcs.registry(db, uid(), { q: st.q, type: st.type, status: st.status, unused: st.unused, limit: st.limit }) : null;
    const series = await bcs.listSeries(db, uid());
    const layouts = await bcs.listLayouts(db, uid());
    const sites = (await db.query('SELECT id, code, name FROM site ORDER BY code')).rows as { id: string; code: string; name: string }[];
    const ids = [...st.sel];
    type Row = Awaited<ReturnType<typeof bcs.registry>>['rows'][number];
    const selRows: Row[] = ids.length ? (await bcs.registry(db, uid(), { limit: 500 })).rows.filter((r) => st.sel.has(r.id)) : [];
    const missing = ids.filter((i) => !selRows.some((r) => r.id === i));
    if (missing.length) selRows.push(...(await db.query(`SELECT b.id, b.code, b.entity_type, b.status, b.print_count, b.note FROM barcode b WHERE b.id = ANY($1::uuid[])`, [missing])).rows as unknown as Row[]);
    return { perms, reg, series, layouts, sites, selRows };
  });
}

export async function view(tab: LTab, tabs: Raw): Promise<Raw> {
  const d = await load(tab);
  if (!d.perms.view) return html`<div class="head"><div><h1>Scan and labels</h1></div></div><div class="card"><p class="empty">Your role cannot see the barcode registry.</p></div>`;
  const body = tab === 'codes' ? codesTab(d) : tab === 'issue' ? issueTab(d) : layoutsTab(d);
  return html`<div class="head"><div><h1>Scan and labels</h1><p>Every code has its own number in the database. Issue spare ones, design labels, print, and keep a record of every print.</p></div></div>${tabs}${body}`;
}

// ───────── codes
function codesTab(d: Data): Raw {
  const r = d.reg!;
  const tiles = r.counts.map((c) => html`<button class="crm-k tilebtn ${st.type === c.entity_type ? 'on' : ''}" data-act="lb-type" data-id="${st.type === c.entity_type ? '' : c.entity_type}"><span>${KIND_NAME[c.entity_type] ?? c.entity_type} codes</span><b>${c.n}</b>${c.voided ? html`<small>${c.voided} cancelled</small>` : ''}</button>`);
  return html`<section class="card crm-sum">${tiles}</section>
  ${printPanel(d)}
  <section class="card"><div class="row"><input id="lb-q" type="search" placeholder="Search a code or note" value="${st.q}" style="flex:1;min-width:160px" />
    <select id="lb-status" aria-label="Status">${opts([{ id: 'active', label: 'In use' }, { id: 'void', label: 'Cancelled' }], st.status, 'Any status')}</select>
    <label class="chk"><input type="checkbox" id="lb-unused" ${st.unused ? raw('checked') : ''} /> Not attached yet</label></div>
    ${r.rows.length ? html`<div class="scroll"><table class="mini"><thead><tr><th></th><th>Code</th><th>For</th><th>Attached to</th><th>Series</th><th>Plant</th><th class="r">Printed</th><th>Status</th><th></th></tr></thead><tbody>
      ${r.rows.map((b) => html`<tr class="${b.status === 'void' ? 'dim' : ''}"><td><input type="checkbox" data-act="lb-tog" data-id="${b.id}" ${st.sel.has(b.id) ? raw('checked') : ''} ${b.status === 'void' ? raw('disabled') : ''} aria-label="Select ${b.code}" /></td>
        <td><code>${b.code}</code>${b.note ? html`<br><small>${b.note}</small>` : ''}</td><td>${KIND_NAME[b.entity_type] ?? b.entity_type}</td>
        <td>${b.attached_to ?? (['item', 'lot', 'location', 'employee'].includes(b.entity_type) ? html`<span class="chip held">not attached</span>` : html`<small>stands alone</small>`)}</td><td>${b.series ?? html`<small>automatic</small>`}</td><td>${b.site ?? ''}</td>
        <td class="r">${b.print_count ? html`<button class="link" data-act="lb-hist" data-id="${b.id}">${b.print_count}×</button>` : '–'}</td>
        <td>${b.status === 'void' ? html`<span class="chip rejected" title="${b.void_reason ?? ''}">cancelled</span>` : html`<span class="chip accepted">in use</span>`}</td>
        <td>${d.perms.void && b.status === 'active' && !b.own_identity ? html`<button class="ghost sm" data-act="lb-void" data-id="${b.id}">Cancel</button>` : ''}</td></tr>
        ${st.histFor === b.id ? html`<tr><td></td><td colspan="8"><div id="lb-hist" class="sub">Loading print history…</div></td></tr>` : ''}
        ${open.has('void-' + b.id) ? html`<tr><td></td><td colspan="8"><form class="row" data-form="lb-void" data-id="${b.id}"><input id="lbv-reason" placeholder="Why is it cancelled? (lost, torn, wrong print)" style="flex:1" /><button type="submit">Confirm cancel</button></form></td></tr>` : ''}`)}
    </tbody></table></div>${r.total > r.rows.length ? html`<div class="row"><small>${r.rows.length} of ${r.total}</small><button data-act="lb-more">Show more</button></div>` : html`<small>${r.total} code${r.total === 1 ? '' : 's'}</small>`}` : html`<p class="empty">No codes match.</p>`}</section>`;
}
const open = new Set<string>();

// ───────── issue
function issueTab(d: Data): Raw {
  const usable = d.series.filter((s) => s.active);
  return html`<section class="split">
    <div class="card"><h2>Issue new codes</h2><p class="sub">For cartons, assets, tools and spare roll labels you want to print before you know what they go on. Each number is used once, ever.</p>
      ${d.perms.issue ? html`<form class="form" data-form="lb-issue"><div class="grid2">
        <label>Series<select id="is-series">${opts(usable.map((s) => ({ id: s.id, label: `${s.name} (${s.prefix}-…)` })))}</select></label>
        <label>How many<input id="is-count" inputmode="numeric" value="10" /></label>
        <label>Plant <small>(optional)</small><select id="is-site">${opts(d.sites.map((s) => ({ id: s.id, label: `${s.code} · ${s.name}` })), '', 'Whole company')}</select></label>
        <label>Note <small>(printed if the label shows it)</small><input id="is-note" placeholder="Order 77, Lot A…" /></label></div>
        <div class="row"><button class="primary" type="submit">Issue codes</button></div></form>` : html`<p class="empty">Your role cannot issue codes.</p>`}
      ${st.last ? html`<p class="ok-t">${st.last}</p>` : ''}
      <h3>Series</h3><table class="mini"><thead><tr><th>Name</th><th>Looks like</th><th class="r">Issued</th><th class="r">Not attached</th></tr></thead><tbody>${d.series.map((s) => html`<tr><td>${s.name}<br><small>${KIND_NAME[s.entity_type]} · ${s.symbology === 'QR' ? 'QR' : 'Code 128'}</small></td><td><code>${s.prefix}-${String(s.next_no).padStart(s.digits, '0')}</code> <small>next</small></td><td class="r">${s.issued}</td><td class="r">${s.unused}</td></tr>`)}</tbody></table>
      ${d.perms.series ? (st.newSeries ? html`<form class="form" data-form="lb-series"><div class="grid2"><label>Name<input id="se-name" /></label><label>Prefix <small>(letters)</small><input id="se-prefix" maxlength="6" /></label>
        <label>For<select id="se-kind">${opts(['lot', 'carton', 'asset', 'generic'].map((k) => ({ id: k, label: KIND_NAME[k] })))}</select></label><label>Code type<select id="se-sym"><option value="CODE128">Code 128 (any scanner)</option><option value="QR">QR (phones and 2D scanners)</option></select></label></div>
        <div class="row"><button class="primary" type="submit">Create series</button><button type="button" data-act="lb-newseries">Cancel</button></div></form>` : html`<div class="row"><button data-act="lb-newseries">New series</button></div>`) : ''}</div>
    <div class="card"><h2>Attach a spare code</h2><p class="sub">Stuck a pre-printed roll code on a roll? Type the code and what it is on, and scanning it will find that roll.</p>
      ${d.perms.issue ? html`<form class="form" data-form="lb-assign"><div class="grid2"><label>Spare code<input id="as-code" placeholder="RL-000012" /></label><label>Roll label, shelf code, material code or staff code<input id="as-target" placeholder="GRN-00012/1" /></label></div><div class="row"><button class="primary" type="submit">Attach</button></div></form>` : ''}
    </div></section>
  ${printPanel(d)}`;
}

// ───────── print panel (shown on Codes and Issue tabs when codes are picked)
function printPanel(d: Data): Raw {
  if (!st.sel.size) return html`${raw('')}`;
  const rows = d.selRows; const types = [...new Set(rows.map((r) => r.entity_type))];
  const lays = types.length === 1 ? d.layouts.filter((l) => l.entity_type === types[0]) : [];
  if (lays.length && !lays.some((l) => l.id === st.layoutId)) st.layoutId = (lays.find((l) => l.is_default) ?? lays[0]).id;
  const lay = lays.find((l) => l.id === st.layoutId);
  const again = rows.filter((r) => r.print_count > 0).length;
  const first = rows[0];
  return html`<section class="card no-print"><h2>Print ${st.sel.size} label${st.sel.size === 1 ? '' : 's'}</h2>
    ${types.length > 1 ? html`<p class="bad-t">These are different kinds of codes (${types.map((t) => KIND_NAME[t]).join(', ')}). Pick one kind at a time; each kind has its own layout.</p>` : html`
    <div class="lb-ctl"><label>Layout<select id="pr-layout">${opts(lays.map((l) => ({ id: l.id, label: `${l.name}${l.is_default ? ' (default)' : ''}` })), st.layoutId)}</select></label>
      <label>Copies of each<input id="pr-copies" type="number" min="1" max="100" value="${st.copies}" style="width:80px" /></label>
      ${again ? html`<label>Why again? <small>(${again} printed before)</small><input id="pr-reason" value="${st.reason}" placeholder="Torn, faded, extra copy" /></label>` : ''}
      <button class="primary" data-act="lb-print">Record and print</button><button data-act="lb-clearsel">Clear</button></div>
    <p class="sub">Printing opens your browser's print window and is recorded against each code. It may be blocked inside the preview; use the hosted site. Reprinting needs a reason.</p>
    ${lay && first ? html`<div class="lb-prev"><div id="pr-prev">${raw(labelSvg({ widthMm: Number(lay.width_mm), heightMm: Number(lay.height_mm), elements: lay.elements }, { ...SAMPLE, code: first.code, barcode: first.code, note: first.note ?? '' }, first.code))}</div><small>Preview shows the first code with sample words; the real words come from the database when you print.</small></div>` : ''}`}
    <div id="lb-sheet" class="label-sheet2" aria-hidden="true"></div></section>`;
}

// ───────── layouts
const blank = (type: string): Layout => ({ name: '', entityType: type, widthMm: 50, heightMm: 30, columns: 1, gapMm: 2, elements: [{ type: 'barcode', x: 2, y: 2, w: 46, h: 14 }, { type: 'field', field: 'code', x: 2, y: 18, w: 46, h: 6, size: 9, align: 'center' }] });
function layoutsTab(d: Data): Raw {
  const L = st.draft;
  const byType = Object.keys(KIND_NAME).map((t) => ({ t, list: d.layouts.filter((l) => l.entity_type === t) })).filter((g) => g.list.length);
  return html`<section class="split lay">
    <div class="card"><h2>Layouts</h2>${byType.map((g) => html`<h4 class="muted-h">${KIND_NAME[g.t]} labels</h4><ul class="plain">${g.list.map((l) => html`<li><button class="link ${L?.id === l.id ? 'on' : ''}" data-act="lb-open" data-id="${l.id}">${l.name}</button> ${l.is_default ? html`<span class="chip info">default</span>` : ''}<br><small>${Number(l.width_mm)} × ${Number(l.height_mm)} mm${l.columns > 1 ? ` · ${l.columns} across` : ''}</small></li>`)}</ul>`)}
      ${d.perms.layout ? html`<h4 class="muted-h">New layout for</h4><div class="row">${Object.keys(KIND_NAME).map((t) => html`<button class="sm" data-act="lb-newlayout" data-id="${t}">${KIND_NAME[t]}</button>`)}</div>` : html`<p class="sub">Your role can look at layouts but not change them.</p>`}</div>
    <div class="card">${L ? designer(L, d) : html`<p class="empty">Pick a layout to see it, or start a new one.</p>`}</div></section>`;
}
function designer(L: Layout, d: Data): Raw {
  const can_ = d.perms.layout; const fields = bcs.FIELDS[L.entityType as bcs.EntityType];
  const num = (i: number, k: 'x' | 'y' | 'w' | 'h' | 'size', v: number | undefined) => html`<input class="nm" data-el="${i}" data-k="${k}" type="number" step="0.5" value="${v ?? ''}" ${can_ ? '' : raw('disabled')} aria-label="${k}" />`;
  return html`<h2>${L.id ? L.name : 'New ' + KIND_NAME[L.entityType].toLowerCase() + ' layout'}</h2>
  <div class="grid2"><label>Name<input id="ly-name" value="${L.name}" ${can_ ? '' : raw('disabled')} /></label><label>Width mm<input id="ly-w" type="number" step="0.5" value="${L.widthMm}" ${can_ ? '' : raw('disabled')} /></label><label>Height mm<input id="ly-h" type="number" step="0.5" value="${L.heightMm}" ${can_ ? '' : raw('disabled')} /></label>
    <label>Labels across a sheet <small>(1 for a label printer)</small><input id="ly-c" type="number" min="1" max="8" value="${L.columns}" ${can_ ? '' : raw('disabled')} /></label><label>Gap mm<input id="ly-g" type="number" step="0.5" value="${L.gapMm}" ${can_ ? '' : raw('disabled')} /></label></div>
  <div class="lb-design"><div class="lb-stage" id="ly-stage">${raw(labelSvg(L, { ...SAMPLE }, SAMPLE.barcode, { sel: st.selEl }))}</div><small>${can_ ? 'Drag things on the label to move them. ' : ''}Sample words are shown; real ones come from the database.</small></div>
  <div class="scroll"><table class="mini"><thead><tr><th>Item</th><th>What</th><th>x</th><th>y</th><th>wide</th><th>high</th><th>pt</th><th></th></tr></thead><tbody>
    ${L.elements.map((e, i) => html`<tr class="${st.selEl === i ? 'sel' : ''}" data-act="lb-pickel" data-id="${i}"><td>${e.type === 'field' ? 'Word' : e.type === 'text' ? 'Fixed text' : e.type === 'barcode' ? 'Barcode' : e.type === 'qr' ? 'QR code' : 'Line'}</td>
      <td>${e.type === 'field' ? html`<select data-el="${i}" data-k="field" ${can_ ? '' : raw('disabled')}>${opts(fields.map((f) => ({ id: f.key, label: f.label })), e.field ?? '')}</select>` : e.type === 'text' ? html`<input data-el="${i}" data-k="text" value="${e.text ?? ''}" ${can_ ? '' : raw('disabled')} />` : ''}
        ${e.type === 'field' || e.type === 'text' ? html`<select data-el="${i}" data-k="align" ${can_ ? '' : raw('disabled')}><option value="left" ${e.align === 'left' || !e.align ? raw('selected') : ''}>left</option><option value="center" ${e.align === 'center' ? raw('selected') : ''}>centre</option><option value="right" ${e.align === 'right' ? raw('selected') : ''}>right</option></select><label class="chk"><input type="checkbox" data-el="${i}" data-k="bold" ${e.bold ? raw('checked') : ''} ${can_ ? '' : raw('disabled')} /> bold</label>` : ''}</td>
      <td>${num(i, 'x', e.x)}</td><td>${num(i, 'y', e.y)}</td><td>${num(i, 'w', e.w)}</td><td>${num(i, 'h', e.h)}</td><td>${e.type === 'field' || e.type === 'text' ? num(i, 'size', e.size ?? 8) : ''}</td>
      <td>${can_ ? html`<button class="ghost sm" data-act="lb-delel" data-id="${i}" aria-label="Remove item">✕</button>` : ''}</td></tr>`)}</tbody></table></div>
  ${can_ ? html`<div class="row"><span class="sub">Add:</span><button class="sm" data-act="lb-addel" data-id="field">Word</button><button class="sm" data-act="lb-addel" data-id="text">Fixed text</button><button class="sm" data-act="lb-addel" data-id="barcode">Barcode</button><button class="sm" data-act="lb-addel" data-id="qr">QR code</button><button class="sm" data-act="lb-addel" data-id="line">Line</button></div>
  <div class="row"><button class="primary" data-act="lb-save">Save layout</button>${L.id && !L.is_default ? html`<button data-act="lb-default">Make default</button>` : ''}${L.id ? html`<button data-act="lb-copy">Save as a copy</button><button class="ghost" data-act="lb-rm">Remove</button>` : ''}</div>` : ''}`;
}

// ───────────────────────── events ─────────────────────────
const num = (id: string) => Number(val(id));
function readDraft() {
  const L = st.draft; if (!L) return;
  L.name = val('ly-name'); L.widthMm = num('ly-w') || L.widthMm; L.heightMm = num('ly-h') || L.heightMm; L.columns = num('ly-c') || 1; L.gapMm = num('ly-g') || 0;
}
const repaint = () => { const s = document.getElementById('ly-stage'); if (s && st.draft) s.innerHTML = labelSvg(st.draft, { ...SAMPLE }, SAMPLE.barcode, { sel: st.selEl }); };

export async function onClick(t: HTMLElement): Promise<boolean> {
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b || !b.dataset.act?.startsWith('lb-')) return false;
  const id = b.dataset.id ?? '';
  switch (b.dataset.act) {
    case 'lb-type': st.type = id; st.limit = 100; await R.render(); return true;
    case 'lb-more': st.limit += 200; await R.render(); return true;
    case 'lb-tog': if (st.sel.has(id)) st.sel.delete(id); else st.sel.add(id); await R.render(); return true;
    case 'lb-clearsel': st.sel.clear(); await R.render(); return true;
    case 'lb-hist': {
      st.histFor = st.histFor === id ? '' : id; await R.render();
      if (st.histFor) { const h = await read((db) => bcs.printHistory(db, uid(), id)); const el = document.getElementById('lb-hist'); if (el) el.innerHTML = h.length ? h.map((x) => `${esc(new Date(x.printed_at).toLocaleString('en-IN'))} · ${esc(x.who ?? '')} · ${x.copies} copy · ${esc(x.layout_name ?? '')}${x.is_reprint ? ' · reprint: ' + esc(x.reason ?? '') : ''}`).join('<br>') : 'Not printed yet.'; }
      return true;
    }
    case 'lb-void': open.has('void-' + id) ? open.delete('void-' + id) : open.add('void-' + id); await R.render(); return true;
    case 'lb-newseries': st.newSeries = !st.newSeries; await R.render(); return true;
    case 'lb-print': return printNow();
    // layouts
    case 'lb-open': { const l = (await read((db) => bcs.listLayouts(db, uid()))).find((x) => x.id === id); if (l) st.draft = { id: l.id, name: l.name, entityType: l.entity_type, widthMm: Number(l.width_mm), heightMm: Number(l.height_mm), columns: l.columns, gapMm: Number(l.gap_mm), elements: JSON.parse(JSON.stringify(l.elements)), version: l.version, is_default: l.is_default }; st.selEl = -1; await R.render(); return true; }
    case 'lb-newlayout': st.draft = blank(id); st.selEl = -1; await R.render(); return true;
    case 'lb-pickel': if (t.closest('input,select,button')) return false; st.selEl = Number(id); readDraft(); repaint(); document.querySelectorAll('tr[data-act=lb-pickel]').forEach((r) => r.classList.toggle('sel', (r as HTMLElement).dataset.id === id)); return true;
    case 'lb-addel': {
      readDraft(); const L = st.draft!; const type = id as El['type'];
      const e: El = type === 'field' ? { type, field: bcs.FIELDS[L.entityType as bcs.EntityType][1]?.key ?? 'code', x: 2, y: 2, w: Math.min(30, L.widthMm - 4), h: 5, size: 8 }
        : type === 'text' ? { type, text: 'Text', x: 2, y: 2, w: Math.min(30, L.widthMm - 4), h: 5, size: 8 }
        : type === 'line' ? { type, x: 2, y: L.heightMm / 2, w: L.widthMm - 4, h: 0 }
        : { type, x: 2, y: 2, w: Math.min(type === 'qr' ? 14 : 30, L.widthMm - 4), h: Math.min(type === 'qr' ? 14 : 10, L.heightMm - 4) };
      L.elements.push(e); st.selEl = L.elements.length - 1; await R.render(); return true;
    }
    case 'lb-delel': { readDraft(); st.draft!.elements.splice(Number(id), 1); st.selEl = -1; await R.render(); return true; }
    case 'lb-save': case 'lb-copy': {
      readDraft(); const L = st.draft!; const copy = b.dataset.act === 'lb-copy';
      const r = await act('Layout saved', (c) => bcs.saveLayout(c, { id: copy ? undefined : L.id, name: copy ? L.name + ' copy' : L.name, entityType: L.entityType, widthMm: L.widthMm, heightMm: L.heightMm, columns: L.columns, gapMm: L.gapMm, elements: L.elements, expectedVersion: copy ? undefined : L.version }));
      if (r) { st.draft = { id: r.id, name: r.name, entityType: r.entity_type, widthMm: Number(r.width_mm), heightMm: Number(r.height_mm), columns: r.columns, gapMm: Number(r.gap_mm), elements: r.elements, version: r.version, is_default: r.is_default }; await R.render(); }
      return true;
    }
    case 'lb-default': { const L = st.draft!; if (await act('Now the default', (c) => bcs.setDefaultLayout(c, { id: L.id! }))) { L.is_default = true; await R.render(); } return true; }
    case 'lb-rm': { const L = st.draft!; if (await act('Layout removed', (c) => bcs.removeLayout(c, { id: L.id! }))) { st.draft = null; await R.render(); } return true; }
  }
  return false;
}

async function printNow(): Promise<boolean> {
  const ids = [...st.sel]; if (!ids.length || !st.layoutId) return true;
  st.copies = Math.min(100, Math.max(1, num('pr-copies') || 1)); st.reason = val('pr-reason');
  let data;
  try { data = await read((db) => bcs.labelValues(db, uid(), ids, st.layoutId)); } catch (e) { toast((e as Error).message, 'bad'); return true; }
  const rec = await act('Print recorded', (c) => bcs.recordPrint(c, { barcodeIds: ids, layoutId: st.layoutId, copies: st.copies, reason: st.reason || undefined }));
  if (!rec) return true;
  const lay = data.layout as { width_mm: string; height_mm: string; columns: number; gap_mm: string; elements: El[] };
  const W = Number(lay.width_mm), H = Number(lay.height_mm), cols = lay.columns;
  const labels = data.labels.flatMap((l) => Array.from({ length: st.copies }, () => `<div class="lbl-cell">${labelSvg({ widthMm: W, heightMm: H, elements: lay.elements }, l.values, l.code)}</div>`));
  const sheet = document.getElementById('lb-sheet')!;
  sheet.className = 'label-sheet2 printing ' + (cols > 1 ? 'multi' : 'single');
  sheet.style.setProperty('--cols', String(cols)); sheet.style.setProperty('--gap', lay.gap_mm + 'mm'); sheet.style.setProperty('--lw', W + 'mm'); sheet.style.setProperty('--lh', H + 'mm');
  sheet.innerHTML = labels.join('');
  let pg = document.getElementById('lbl-page'); if (!pg) { pg = document.createElement('style'); pg.id = 'lbl-page'; document.head.appendChild(pg); }
  pg.textContent = cols > 1 ? '@media print { @page { size: A4; margin: 8mm; } }' : `@media print { @page { size: ${W}mm ${H}mm; margin: 0; } }`;
  st.sel.clear(); st.reason = '';
  setTimeout(() => { try { window.print(); } catch { /* blocked */ } setTimeout(() => void R.render(), 400); }, 60);
  return true;
}

export async function onSubmit(form: string, ev?: Event): Promise<boolean> {
  if (!form.startsWith('lb-')) return false;
  switch (form) {
    case 'lb-issue': {
      const r = await act('Codes issued', (c) => bcs.issueCodes(c, { seriesId: val('is-series'), count: num('is-count'), siteId: val('is-site') || null, note: val('is-note') || undefined }));
      if (r) { st.sel = new Set(r.ids); st.last = `${r.count} code${r.count === 1 ? '' : 's'} issued: ${r.first}${r.count > 1 ? ' to ' + r.last : ''}. They are picked below, ready to print.`; await R.render(); }
      return true;
    }
    case 'lb-series': { const r = await act('Series created', (c) => bcs.createSeries(c, { name: val('se-name'), entityType: val('se-kind') as bcs.EntityType, prefix: val('se-prefix'), symbology: val('se-sym') })); if (r) { st.newSeries = false; await R.render(); } return true; }
    case 'lb-assign': {
      const code = val('as-code'), target = val('as-target'); if (!code || !target) { toast('Type the spare code and what it is on', 'bad'); return true; }
      const found = await read(async (db) => {
        const reg = (await db.query('SELECT entity_type FROM barcode WHERE code=$1', [code])).rows[0]; if (!reg) return { err: 'That code is not in the registry' };
        const sql: Record<string, string> = { lot: 'SELECT id FROM lot WHERE label=$1', location: 'SELECT id FROM location WHERE code=$1', item: 'SELECT id FROM item WHERE code=$1', employee: 'SELECT id FROM employee WHERE code=$1' };
        const q = sql[reg.entity_type]; if (!q) return { err: 'Cartons, assets and general codes stand on their own; there is nothing to attach' };
        const e = (await db.query(q, [target])).rows[0]; return e ? { id: e.id as string } : { err: `No ${KIND_NAME[reg.entity_type].toLowerCase()} found with the code "${target}"` };
      });
      if ('err' in found) { toast(found.err ?? 'Not found', 'bad'); return true; }
      if (await act('Attached', (c) => bcs.assignCode(c, { code, entityId: found.id! }))) await R.render();
      return true;
    }
    case 'lb-void': {
      const id = (ev?.target as HTMLElement).closest('form')!.dataset.id!;
      if (await act('Code cancelled', (c) => bcs.voidCode(c, { id, reason: val('lbv-reason') }))) { open.delete('void-' + id); await R.render(); }
      return true;
    }
  }
  return false;
}

// live fields in the designer, filters, drag to move
document.addEventListener('input', (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === 'lb-q') { st.q = t.value; clearTimeout(qT); qT = setTimeout(() => void R.render().then(() => { const i = document.getElementById('lb-q') as HTMLInputElement | null; if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }), 250); return; }
  if (t.closest('#lb-root, .lay') && st.draft) {
    if (t.dataset.el !== undefined) { const e = st.draft.elements[Number(t.dataset.el)]; const k = t.dataset.k!; if (!e) return;
      if (t.type === 'checkbox') (e as unknown as Record<string, unknown>)[k] = t.checked; else if (k === 'field' || k === 'text' || k === 'align') (e as unknown as Record<string, unknown>)[k] = t.value; else (e as unknown as Record<string, unknown>)[k] = Number(t.value); st.selEl = Number(t.dataset.el); repaint(); }
    else if (t.id.startsWith('ly-')) { readDraft(); repaint(); }
  }
});
let qT: ReturnType<typeof setTimeout> | undefined;
document.addEventListener('change', (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === 'lb-status') { st.status = t.value; void R.render(); }
  else if (t.id === 'lb-unused') { st.unused = t.checked; void R.render(); }
  else if (t.id === 'pr-layout') { st.layoutId = t.value; st.copies = num('pr-copies') || 1; void R.render(); }
  else if (t.id === 'pr-copies') st.copies = Math.min(100, Math.max(1, Number(t.value) || 1));
  else if (t.dataset?.el !== undefined && t.tagName === 'SELECT' && st.draft) { const e = st.draft.elements[Number(t.dataset.el)]; (e as unknown as Record<string, unknown>)[t.dataset.k!] = t.value; repaint(); }
});
let drag: { i: number; sx: number; sy: number; ex: number; ey: number; k: number } | null = null;
document.addEventListener('pointerdown', (ev) => {
  const t = ev.target as SVGElement; const hit = t.closest?.('.el-hit') as SVGElement | null; const stage = document.getElementById('ly-stage');
  if (!hit || !stage || !stage.contains(hit) || !st.draft) return;
  const i = Number(hit.getAttribute('data-el')); const svg = stage.querySelector('svg')!; const k = svg.getBoundingClientRect().width / st.draft.widthMm;
  const e = st.draft.elements[i]; st.selEl = i; drag = { i, sx: ev.clientX, sy: ev.clientY, ex: e.x, ey: e.y, k }; ev.preventDefault(); repaint();
  document.querySelectorAll('tr[data-act=lb-pickel]').forEach((r) => r.classList.toggle('sel', (r as HTMLElement).dataset.id === String(i)));
});
document.addEventListener('pointermove', (ev) => {
  if (!drag || !st.draft) return; const e = st.draft.elements[drag.i]; const r = (n: number) => Math.round(n * 2) / 2;
  e.x = Math.max(0, Math.min(st.draft.widthMm - e.w, r(drag.ex + (ev.clientX - drag.sx) / drag.k))); e.y = Math.max(0, Math.min(st.draft.heightMm - e.h, r(drag.ey + (ev.clientY - drag.sy) / drag.k)));
  repaint(); const row = document.querySelector(`tr[data-act=lb-pickel][data-id="${drag.i}"]`); if (row) { (row.querySelector('[data-k=x]') as HTMLInputElement).value = String(e.x); (row.querySelector('[data-k=y]') as HTMLInputElement).value = String(e.y); }
});
document.addEventListener('pointerup', () => { drag = null; });
void checked;
