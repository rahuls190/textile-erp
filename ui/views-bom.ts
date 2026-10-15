import { html, raw, qty, chip, dateOnly, when, type Raw } from './lib.js';
import { uid, read, val, act, head, denied, R, opts, toast } from './ctx.js';
import * as bom from '../src/domain/bom.js';
import { can } from '../src/core/permissions.js';

const ANY = { anySite: true } as const;
type Ln = { section: string; itemId: string; qty: string; wastage: string; sizes: string[] | null; colours: string[] | null; qbs: Record<string, string>; note: string; open: boolean };
type Pk = { skus: { skuId: string; qty: string }[]; mats: { itemId: string; qty: string }[] };
const st = {
  tab: 'styles' as 'styles' | 'bom' | 'packs' | 'plan',
  styleId: '', bomId: '', skuPrev: '',
  ed: null as null | { bomId: string; rev: number; lines: Ln[]; notes: string },
  pk: { skus: [], mats: [] } as Pk, pkCode: '', pkName: '', pkNotes: '',
  newStyle: false, editStyle: false, pickCells: new Set<string>(),
  plan: {} as Record<string, string>, planRes: null as null | Awaited<ReturnType<typeof bom.requirements>>,
  draft: {} as Record<string, string>,
};
const rs = (n: number | null) => (n == null ? '–' : '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const SECTION_LABEL: Record<string, string> = { FABRIC: 'Fabric', TRIM: 'Trims', CUP: 'Cups', PACKING: 'Packing', PROCESS: 'Process', WIP: 'Work in progress' };
const BOM_TONE: Record<string, string> = { draft: 'neutral', submitted: 'warn', active: 'ok', superseded: 'neutral' };
const bChip = (s: string) => html`<span class="chip ${BOM_TONE[s] ?? 'neutral'}">${s === 'submitted' ? 'waiting for approval' : s === 'active' ? 'in use' : s}</span>`;
const parseSizes = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const parseColours = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).map((x) => { const [c, ...n] = x.split(/[:=-]/); return { code: c.trim().toUpperCase(), name: (n.join(' ').trim() || c.trim()) }; });

// ───────────── reading the editor back from the page ─────────────
function syncLines() {
  const ed = st.ed; if (!ed || !document.getElementById('bl-notes')) return;
  ed.notes = val('bl-notes');
  ed.lines.forEach((l, i) => {
    const g = (k: string) => document.getElementById(`bl-${i}-${k}`) as HTMLInputElement | null;
    if (!g('qty')) return;
    l.section = g('sec')?.value ?? l.section; l.itemId = g('item')?.value ?? l.itemId; l.qty = g('qty')!.value.trim(); l.wastage = g('waste')?.value.trim() ?? l.wastage; l.note = g('note')?.value.trim() ?? l.note;
    const boxes = (kind: string) => [...document.querySelectorAll(`input[data-bl="${i}-${kind}"]`)] as HTMLInputElement[];
    const sz = boxes('sz'); if (sz.length) { const on = sz.filter((b) => b.checked).map((b) => b.value); l.sizes = on.length === sz.length ? null : on; }
    const co = boxes('co'); if (co.length) { const on = co.filter((b) => b.checked).map((b) => b.value); l.colours = on.length === co.length ? null : on; }
    const q: Record<string, string> = {}; document.querySelectorAll(`input[data-bq="${i}"]`).forEach((e) => { const x = e as HTMLInputElement; if (x.value.trim()) q[x.dataset.size!] = x.value.trim(); });
    if (document.querySelector(`input[data-bq="${i}"]`)) l.qbs = q;
  });
}
function syncPack() {
  if (!document.getElementById('pk-code')) return;
  st.pkCode = val('pk-code'); st.pkName = val('pk-name'); st.pkNotes = val('pk-notes');
  st.pk.skus.forEach((s, i) => { s.skuId = val(`pk-s-${i}`) || s.skuId; s.qty = val(`pk-sq-${i}`) || s.qty; });
  st.pk.mats.forEach((m, i) => { m.itemId = val(`pk-m-${i}`) || m.itemId; m.qty = val(`pk-mq-${i}`) || m.qty; });
}
const syncPlan = () => document.querySelectorAll('input[data-plan]').forEach((e) => { const x = e as HTMLInputElement; st.plan[x.dataset.plan!] = x.value.trim(); });

const toLn = (l: Record<string, unknown>): Ln => ({ section: l.section as string, itemId: l.item_id as string, qty: String(l.qty_t ?? l.qty), wastage: String(Number(l.wastage_pct)), sizes: (l.sizes as string[] | null)?.length ? (l.sizes as string[]) : null, colours: (l.colours as string[] | null)?.length ? (l.colours as string[]) : null, qbs: Object.fromEntries(Object.entries((l.qty_by_size ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)])), note: (l.note as string) ?? '', open: false });
const blank = (section = 'FABRIC'): Ln => ({ section, itemId: '', qty: '', wastage: '0', sizes: null, colours: null, qbs: {}, note: '', open: true });

// ───────────── the view ─────────────
export async function productsView(): Promise<Raw> {
  const d = await read(async (db) => {
    const styles = await bom.listStyles(db, uid()).catch(() => null);
    if (!styles) return null;
    if (!st.styleId && styles.length) st.styleId = styles[0].id;
    if (st.styleId && !styles.some((s) => s.id === st.styleId)) st.styleId = styles[0]?.id ?? '';
    const sel = st.styleId ? await bom.getStyle(db, uid(), st.styleId) : null;
    if (sel && !sel.boms.some((b) => b.id === st.bomId)) st.bomId = (sel.boms.find((b) => ['draft', 'submitted'].includes(b.status)) ?? sel.boms.find((b) => b.status === 'active') ?? sel.boms[0])?.id ?? '';
    const bm = st.bomId && sel ? await bom.getBom(db, uid(), st.bomId) : null;
    const items = (await db.query(`SELECT id, code, name, kind, stock_unit FROM item WHERE status='active' AND kind <> 'FG' ORDER BY code`)).rows as { id: string; code: string; name: string; kind: string; stock_unit: string }[];
    const allSkus = (await db.query(`SELECT k.id, k.code, k.size, k.colour_code, s.code AS style, i.status FROM sku k JOIN product_style s ON s.id=k.style_id JOIN item i ON i.id=k.item_id ORDER BY k.code`)).rows as { id: string; code: string; size: string; colour_code: string; style: string; status: string }[];
    const packs = await bom.listPacks(db, uid());
    const overview = bm ? await bom.bomOverview(db, uid(), bm.bom.id) : [];
    const prev = bm && st.skuPrev && sel?.skus.some((k) => k.id === st.skuPrev) ? await bom.skuBom(db, uid(), { bomId: bm.bom.id, skuId: st.skuPrev }) : null;
    return { styles, sel, bm, items, allSkus, packs, overview, prev, create: await can(db, uid(), 'bom.create', ANY), approve: await can(db, uid(), 'bom.approve', ANY) };
  });
  if (!d) return denied('Products and BOM', 'Styles, SKUs by size and colour, and what each piece is made of.', 'Your role cannot see products.');
  if (d.bm && ['draft'].includes(d.bm.bom.status) && d.create && (!st.ed || st.ed.bomId !== d.bm.bom.id)) st.ed = { bomId: d.bm.bom.id, rev: d.bm.bom.rev, lines: d.bm.lines.map(toLn), notes: d.bm.bom.notes ?? '' };
  if (!d.bm || d.bm.bom.status !== 'draft') st.ed = null;
  const tab = (id: typeof st.tab, label: string) => html`<button class="${st.tab === id ? 'on' : ''}" data-act="bm-tab" data-id="${id}">${label}</button>`;
  const tabs = html`<div class="tabs">${tab('styles', 'Styles & SKUs')}${tab('bom', 'BOM builder')}${tab('packs', 'Packs (final box)')}${tab('plan', 'Requirements')}</div>`;
  const body = st.tab === 'styles' ? stylesTab(d) : st.tab === 'bom' ? bomTab(d) : st.tab === 'packs' ? packsTab(d) : planTab(d);
  return html`${head('Products and BOM', 'A style has sizes and colours. Each size and colour is a SKU. A BOM says what one piece needs, and a pack is the final box.', d.create ? html`<div class="row"><button class="primary" data-act="bm-newstyle">New style</button></div>` : undefined)}${tabs}${body}`;
}
type D = NonNullable<Awaited<ReturnType<typeof loadType>>>;
declare function loadType(): Promise<{
  styles: Awaited<ReturnType<typeof bom.listStyles>>; sel: Awaited<ReturnType<typeof bom.getStyle>> | null; bm: Awaited<ReturnType<typeof bom.getBom>> | null;
  items: { id: string; code: string; name: string; kind: string; stock_unit: string }[]; allSkus: { id: string; code: string; size: string; colour_code: string; style: string; status: string }[];
  packs: Awaited<ReturnType<typeof bom.listPacks>>; overview: Awaited<ReturnType<typeof bom.bomOverview>>; prev: Awaited<ReturnType<typeof bom.skuBom>> | null; create: boolean; approve: boolean;
} | null>;

const stylePicker = (d: D) => html`<label class="inline">Style <select id="bm-style" data-bm="style">${opts(d.styles.map((s) => ({ id: s.id, label: `${s.code} · ${s.name}` })), st.styleId)}</select></label>`;

// ── Styles & SKUs ──
function stylesTab(d: D): Raw {
  const s = d.sel?.style;
  const newForm = st.newStyle ? html`<form class="card form" data-form="bm-newstyle"><h2>New style</h2>
    <div class="grid2"><label>Style code<input id="ns-code" placeholder="BRF-01" value="${st.draft['ns-code'] ?? ''}" /></label><label>Name<input id="ns-name" placeholder="Classic brief" value="${st.draft['ns-name'] ?? ''}" /></label>
    <label>Category <small>(optional)</small><input id="ns-cat" placeholder="Innerwear" value="${st.draft['ns-cat'] ?? ''}" /></label><label>HSN <small>(optional)</small><input id="ns-hsn" value="${st.draft['ns-hsn'] ?? ''}" /></label>
    <label>GST % <small>(optional)</small><input id="ns-gst" inputmode="decimal" value="${st.draft['ns-gst'] ?? ''}" /></label></div>
    <label>Sizes <small>(separate with commas)</small><input id="ns-sizes" placeholder="S, M, L, XL" value="${st.draft['ns-sizes'] ?? ''}" /></label>
    <label>Colours <small>(code:name, one per line or comma separated)</small><textarea id="ns-cols" rows="3" placeholder="BLK:Black, WHT:White, NVY:Navy">${st.draft['ns-cols'] ?? ''}</textarea></label>
    <div class="row"><button class="primary" type="submit">Save style</button><button type="button" data-act="bm-newstyle">Close</button></div></form>` : '';
  const list = html`<section class="card"><h2>Styles</h2>${d.styles.length ? html`<div class="scroll"><table class="mini"><thead><tr><th>Code</th><th>Name</th><th class="r">Sizes</th><th class="r">Colours</th><th class="r">SKUs</th><th>BOM</th></tr></thead><tbody>${d.styles.map((x) => html`<tr class="pick ${x.id === st.styleId ? 'on' : ''}" tabindex="0" data-act="bm-style" data-id="${x.id}"><td class="mono">${x.code}</td><td>${x.name}</td><td class="r">${x.n_sizes}</td><td class="r">${x.n_colours}</td><td class="r">${x.n_skus}</td><td>${x.open_status ? bChip(x.open_status) : x.active_version ? html`<span class="chip ok">v${x.active_version} in use</span>` : html`<span class="chip neutral">none</span>`}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No styles yet.${d.create ? ' Press “New style”.' : ''}</p>`}</section>`;
  if (!s || !d.sel) return html`${newForm}${list}`;
  const sizes = s.sizes as string[]; const cols = s.colours as { code: string; name: string }[];
  const byKey = new Map(d.sel.skus.map((k) => [`${k.colour_code}|${k.size}`, k]));
  const missing = cols.flatMap((c) => sizes.filter((z) => !byKey.has(`${c.code}|${z}`)).map((z) => `${c.code}|${z}`));
  const pickN = [...st.pickCells].filter((k) => missing.includes(k)).length;
  const grid = html`<div class="scroll"><table class="mini"><thead><tr><th>Colour</th>${sizes.map((z) => html`<th class="r">${z}</th>`)}<th></th></tr></thead><tbody>${cols.map((c) => html`<tr><td><b class="mono">${c.code}</b> ${c.name}</td>${sizes.map((z) => { const k = byKey.get(`${c.code}|${z}`); const key = `${c.code}|${z}`; return k ? html`<td class="r" title="${k.code}">${chip(k.status === 'active' ? 'active' : 'draft', k.status === 'active' ? 'ready' : 'draft')}</td>` : d.create ? html`<td class="r"><input type="checkbox" data-cell="${key}" ${st.pickCells.has(key) ? raw('checked') : ''} aria-label="Create ${c.code} ${z}" /></td>` : html`<td class="r">–</td>`; })}<td>${d.create && missing.some((m) => m.startsWith(c.code + '|')) ? html`<button class="link" data-act="bm-rowall" data-id="${c.code}">tick row</button>` : ''}</td></tr>`)}</tbody></table></div>`;
  const edit = st.editStyle ? html`<form class="card form" data-form="bm-editstyle"><h3>Change ${s.code}</h3><p class="sub">Add sizes or colours any time. A size or colour that SKUs or BOM lines use cannot be removed.</p>
    <div class="grid2"><label>Name<input id="es-name" value="${s.name}" /></label><label>Category<input id="es-cat" value="${s.category ?? ''}" /></label></div>
    <label>Sizes<input id="es-sizes" value="${sizes.join(', ')}" /></label><label>Colours <small>(code:name)</small><textarea id="es-cols" rows="3">${cols.map((c) => `${c.code}:${c.name}`).join(', ')}</textarea></label>
    <div class="row"><button class="primary" type="submit">Save changes</button><button type="button" data-act="bm-editstyle">Close</button></div></form>` : '';
  return html`${newForm}${list}
  <section class="card"><div class="row between"><h2>${s.code} · ${s.name}</h2>${d.create ? html`<button data-act="bm-editstyle">Change sizes and colours</button>` : ''}</div>
    <p class="sub">${s.category ?? 'No category'} · ${sizes.length} sizes × ${cols.length} colours = ${sizes.length * cols.length} possible SKUs · ${d.sel.skus.length} made</p>${edit}
    ${grid}
    ${d.create ? html`<div class="row"><button class="primary" data-act="bm-makeskus" ${pickN ? '' : raw('disabled')}>Create ${pickN} ticked SKU${pickN === 1 ? '' : 's'}</button><button data-act="bm-makeall" ${missing.length ? '' : raw('disabled')}>Create all ${missing.length} missing</button></div><p class="note">A new SKU is a draft stock item with its own barcode. It becomes ready when a BOM for this style is approved.</p>` : ''}</section>`;
}

// ── BOM builder ──
function bomTab(d: D): Raw {
  if (!d.sel) return html`<section class="card"><p class="empty">Make a style first.</p></section>`;
  const s = d.sel.style; const sizes = s.sizes as string[]; const cols = s.colours as { code: string; name: string }[];
  const b = d.bm?.bom; const open = d.sel.boms.find((x) => ['draft', 'submitted'].includes(x.status));
  const versions = html`<section class="card"><div class="row between"><h2>Versions</h2>${d.create && !open && d.sel.skus.length ? html`<button class="primary" data-act="bm-start">${d.sel.boms.length ? 'Start a new version' : 'Start the BOM'}</button>` : ''}</div>
    ${d.sel.boms.length ? html`<div class="scroll"><table class="mini"><thead><tr><th>Version</th><th>Status</th><th class="r">Lines</th><th>Made by</th><th>Approved</th></tr></thead><tbody>${d.sel.boms.map((x) => html`<tr class="pick ${x.id === st.bomId ? 'on' : ''}" tabindex="0" data-act="bm-pick" data-id="${x.id}"><td>v${x.version}</td><td>${bChip(x.status)}</td><td class="r">${x.n_lines}</td><td>${x.creator ?? ''}</td><td>${x.approved_at ? html`${dateOnly(String(x.effective_from ?? '').slice(0, 10))} by ${x.approver}` : x.return_reason ? html`<span class="warn-t">returned: ${x.return_reason}</span>` : '–'}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">${d.sel.skus.length ? 'No BOM yet.' : 'Create the SKUs on the first tab before starting a BOM.'}</p>`}</section>`;
  if (!b || !d.bm) return html`<div class="card">${stylePicker(d)}</div>${versions}`;
  const editable = b.status === 'draft' && d.create && st.ed;
  const itemsFor = (sec: string, cur: string) => d.items.filter((i) => i.kind === sec || i.id === cur);
  const lineRow = (l: Ln, i: number) => {
    const it = d.items.find((x) => x.id === l.itemId);
    const sum = `${l.sizes ? l.sizes.join(' ') : 'All sizes'} · ${l.colours ? l.colours.join(' ') : 'All colours'}${Object.keys(l.qbs).length ? ' · size quantities' : ''}`;
    return html`<tr><td><select id="bl-${i}-sec" data-bm="sec" aria-label="Section">${opts(Object.entries(SECTION_LABEL).map(([k, v]) => ({ id: k, label: v })), l.section)}</select></td>
      <td><select id="bl-${i}-item" aria-label="Material">${opts(itemsFor(l.section, l.itemId).map((x) => ({ id: x.id, label: `${x.code} · ${x.name}` })), l.itemId, 'Choose material…')}</select></td>
      <td class="r"><input id="bl-${i}-qty" class="num" inputmode="decimal" value="${l.qty}" aria-label="Quantity per piece" /> <small>${it?.stock_unit ?? ''}</small></td>
      <td class="r"><input id="bl-${i}-waste" class="num" inputmode="decimal" value="${l.wastage}" aria-label="Wastage percent" /></td>
      <td><button type="button" class="link" data-act="bm-lopen" data-id="${i}">${l.open ? 'hide' : sum}</button></td>
      <td><button type="button" class="ghost" data-act="bm-ldel" data-id="${i}" aria-label="Remove line">✕</button></td></tr>
      ${l.open ? html`<tr class="sub-row"><td colspan="6"><div class="grid2">
        <div><b>Sizes this line applies to</b><div class="row wrap">${sizes.map((z) => html`<label class="chk"><input type="checkbox" data-bl="${i}-sz" value="${z}" ${!l.sizes || l.sizes.includes(z) ? raw('checked') : ''} /> ${z}</label>`)}</div></div>
        <div><b>Colours this line applies to</b><div class="row wrap">${cols.map((c) => html`<label class="chk"><input type="checkbox" data-bl="${i}-co" value="${c.code}" ${!l.colours || l.colours.includes(c.code) ? raw('checked') : ''} /> ${c.code}</label>`)}</div></div></div>
        <b>Different quantity for some sizes</b> <small>(leave empty to use the quantity above)</small>
        <div class="row wrap">${sizes.map((z) => html`<label class="chk">${z} <input class="num" inputmode="decimal" data-bq="${i}" data-size="${z}" value="${l.qbs[z] ?? ''}" aria-label="Quantity for size ${z}" /></label>`)}</div>
        <label>Note<input id="bl-${i}-note" value="${l.note}" placeholder="e.g. cut width 150 cm" /></label></td></tr>` : ''}`;
  };
  const roStatic = html`<div class="scroll"><table class="mini"><thead><tr><th>Section</th><th>Material</th><th class="r">Per piece</th><th class="r">Waste %</th><th>Applies to</th></tr></thead><tbody>${d.bm.lines.map((l) => html`<tr><td>${SECTION_LABEL[l.section]}</td><td><span class="mono">${l.item_code}</span> ${l.item_name}</td><td class="r">${qty(l.qty_t)} ${l.unit}${l.qty_by_size && Object.keys(l.qty_by_size).length ? html`<br /><small>${Object.entries(l.qty_by_size as Record<string, string>).map(([k, v]) => `${k}: ${qty(String(v))}`).join(' · ')}</small>` : ''}</td><td class="r">${Number(l.wastage_pct)}</td><td>${(l.sizes?.length ? l.sizes.join(' ') : 'All sizes')} · ${(l.colours?.length ? l.colours.join(' ') : 'All colours')}${l.note ? html`<br /><small>${l.note}</small>` : ''}</td></tr>`)}</tbody></table></div>`;
  const status = b.status;
  const actions = html`<div class="row">
    ${editable ? html`<button class="primary" data-act="bm-save">Save</button><button data-act="bm-ladd">Add a line</button><button data-act="bm-submit">Save and send for approval</button><button class="ghost" data-act="bm-discard">Discard draft</button>` : ''}
    ${status === 'submitted' && d.approve ? html`<button class="primary" data-act="bm-approve">Approve</button><input id="bm-reason" placeholder="Reason (to return)" aria-label="Reason" /><button data-act="bm-return">Return</button>` : ''}
    ${status === 'submitted' && !d.approve ? html`<span class="note">Waiting for an approver. The person who made or sent it cannot approve it.</span>` : ''}
    ${d.create && status === 'active' && !open ? html`<button data-act="bm-start">Start a new version from this</button>` : ''}</div>`;
  const editor = editable ? html`<div class="scroll"><table class="mini bl"><thead><tr><th>Section</th><th>Material</th><th class="r">Per piece</th><th class="r">Waste %</th><th>Applies to</th><th></th></tr></thead><tbody>${st.ed!.lines.length ? st.ed!.lines.map(lineRow) : html`<tr><td colspan="6" class="empty">No lines yet. Press “Add a line”.</td></tr>`}</tbody></table></div><label>Notes<input id="bl-notes" value="${st.ed!.notes}" /></label>` : roStatic;
  const ov = d.overview;
  const prev = d.prev;
  return html`<div class="card">${stylePicker(d)}</div>${versions}
  <section class="card"><div class="row between"><h2>${s.code} · BOM v${b.version} ${bChip(status)}</h2></div>
    <p class="sub">Per piece, before wastage is added. Made by ${b.creator ?? ''}${b.submitter ? `, sent by ${b.submitter}` : ''}${b.approver ? `, approved by ${b.approver}` : ''}.</p>
    ${b.return_reason && status === 'draft' ? html`<p class="note bad-t">Returned: ${b.return_reason}</p>` : ''}
    ${editor}${actions}</section>
  <section class="card"><h2>What each SKU needs</h2><p class="sub">Every size and colour gets the lines that apply to it. Cost uses the cheapest approved vendor price.</p>
    <div class="scroll"><table class="mini"><thead><tr><th>SKU</th><th class="r">Lines</th><th class="r">Material cost per piece</th><th></th></tr></thead><tbody>${ov.map((o) => html`<tr class="pick ${o.id === st.skuPrev ? 'on' : ''}" tabindex="0" data-act="bm-prev" data-id="${o.id}"><td class="mono">${o.code}</td><td class="r">${o.lines === 0 ? html`<span class="chip bad">none</span>` : o.lines}</td><td class="r">${rs(o.cost)}</td><td>${o.unpriced ? html`<small class="warn-t">${o.unpriced} without a price</small>` : ''}</td></tr>`)}</tbody></table></div>
    ${prev ? html`<h3>${prev.sku.code}</h3><div class="scroll"><table class="mini"><thead><tr><th>Material</th><th class="r">Net</th><th class="r">Waste</th><th class="r">Gross</th><th class="r">Rate</th><th class="r">Cost</th></tr></thead><tbody>${prev.lines.map((l) => html`<tr><td><span class="mono">${l.item_code}</span> ${l.item_name}${l.size_specific ? html` <small>(size quantity)</small>` : ''}</td><td class="r">${l.net} ${l.unit}</td><td class="r">${l.wastage_pct}%</td><td class="r">${l.gross}</td><td class="r">${rs(l.rate)}</td><td class="r">${rs(l.cost)}</td></tr>`)}</tbody><tfoot><tr><td colspan="5"><b>Total per piece</b></td><td class="r"><b>${rs(prev.cost)}</b></td></tr></tfoot></table></div>` : html`<p class="note">Click a SKU to see its materials.</p>`}</section>
  ${d.bm.history.length ? html`<section class="card"><h3>History</h3><ul class="plain">${d.bm.history.map((h) => html`<li>${when(h.at)} · ${h.action.replace('bom.', '')} · ${h.who ?? ''}${h.reason ? ` · ${h.reason}` : ''}</li>`)}</ul></section>` : ''}`;
}

// ── Packs ──
function packsTab(d: D): Raw {
  const skuOpts = d.allSkus.map((k) => ({ id: k.id, label: k.code }));
  const packItems = d.items.filter((i) => i.kind === 'PACKING');
  const sty = d.sel?.style; const sizes = (sty?.sizes ?? []) as string[]; const cols = (sty?.colours ?? []) as { code: string; name: string }[];
  const builder = d.create ? html`<form class="card form" data-form="bm-newpack"><h2>Build a pack</h2><p class="sub">A pack is the final box you sell: several SKUs together, plus the box and other packing material.</p>
    <div class="grid2"><label>Pack code<input id="pk-code" value="${st.pkCode}" placeholder="BRF-01-3PK-M" /></label><label>Name<input id="pk-name" value="${st.pkName}" placeholder="Classic brief 3-pack, size M" /></label></div>
    <h3>SKUs in the box</h3>
    ${st.pk.skus.length ? html`<table class="mini"><thead><tr><th>SKU</th><th class="r">Pieces</th><th></th></tr></thead><tbody>${st.pk.skus.map((s, i) => html`<tr><td><select id="pk-s-${i}" aria-label="SKU">${opts(skuOpts, s.skuId, 'Choose SKU…')}</select></td><td class="r"><input id="pk-sq-${i}" class="num" inputmode="numeric" value="${s.qty}" aria-label="Pieces" /></td><td><button type="button" class="ghost" data-act="bm-pdel" data-id="s${i}" aria-label="Remove">✕</button></td></tr>`)}</tbody></table>` : html`<p class="empty">No SKUs yet.</p>`}
    <div class="row wrap"><button type="button" data-act="bm-padd" data-id="s">Add a SKU</button>
      ${sty ? html`<label class="inline">Quick fill from ${sty.code}: <select id="pk-fill" aria-label="Quick fill">${opts([...sizes.map((z) => ({ id: 'z:' + z, label: `Size ${z}, one of every colour` })), ...cols.map((c) => ({ id: 'c:' + c.code, label: `${c.name}, one of every size` }))], '', 'Choose…')}</select></label><button type="button" data-act="bm-pfill">Add</button>` : ''}</div>
    <h3>Packing material</h3>
    ${st.pk.mats.length ? html`<table class="mini"><thead><tr><th>Material</th><th class="r">Per pack</th><th></th></tr></thead><tbody>${st.pk.mats.map((m, i) => html`<tr><td><select id="pk-m-${i}" aria-label="Packing material">${opts(packItems.map((x) => ({ id: x.id, label: `${x.code} · ${x.name}` })), m.itemId, 'Choose…')}</select></td><td class="r"><input id="pk-mq-${i}" class="num" inputmode="decimal" value="${m.qty}" aria-label="Quantity" /></td><td><button type="button" class="ghost" data-act="bm-pdel" data-id="m${i}" aria-label="Remove">✕</button></td></tr>`)}</tbody></table>` : html`<p class="empty">None added.</p>`}
    <div class="row"><button type="button" data-act="bm-padd" data-id="m">Add packing material</button></div>
    <label>Notes <small>(optional)</small><input id="pk-notes" value="${st.pkNotes}" /></label>
    <div class="row"><button class="primary" type="submit">Create pack</button></div></form>` : '';
  return html`${stylePicker(d)}${builder}
  <section class="card"><h2>Packs</h2>${d.packs.length ? html`<div class="scroll"><table class="mini"><thead><tr><th>Code</th><th>Name</th><th class="r">Pieces</th><th>Contents</th><th>Status</th></tr></thead><tbody>${d.packs.map((p) => html`<tr><td class="mono">${p.code}</td><td>${p.name}</td><td class="r">${p.pieces}</td><td><small>${(p.lines as { kind: string; code: string; qty: string }[]).map((l) => `${qty(String(l.qty))} × ${l.code}`).join(', ')}</small></td><td>${chip(p.status)}${d.create ? html` <button class="link" data-act="bm-pstat" data-id="${p.id}" data-v="${p.status === 'active' ? 'inactive' : 'active'}">${p.status === 'active' ? 'switch off' : 'switch on'}</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No packs yet.</p>`}</section>`;
}

// ── Requirements ──
function planTab(d: D): Raw {
  if (!d.sel) return html`<section class="card"><p class="empty">Make a style first.</p></section>`;
  const s = d.sel.style; const sizes = s.sizes as string[]; const cols = s.colours as { code: string; name: string }[];
  const bm = d.sel.boms.find((x) => x.status === 'active');
  if (!bm) return html`<div class="card">${stylePicker(d)}</div><section class="card"><p class="empty">This style has no approved BOM yet. Requirements are worked out from the BOM in use.</p></section>`;
  const byKey = new Map(d.sel.skus.map((k) => [`${k.colour_code}|${k.size}`, k]));
  const r = st.planRes;
  return html`<div class="card">${stylePicker(d)}</div>
  <section class="card"><h2>How much material for a production plan</h2><p class="sub">Enter pieces per SKU. Uses BOM v${bm.version}, adds wastage, and compares with accepted stock and open purchase orders.</p>
    <div class="scroll"><table class="mini"><thead><tr><th>Colour</th>${sizes.map((z) => html`<th class="r">${z}</th>`)}</tr></thead><tbody>${cols.map((c) => html`<tr><td><b class="mono">${c.code}</b></td>${sizes.map((z) => { const k = byKey.get(`${c.code}|${z}`); return k ? html`<td class="r"><input class="num" inputmode="numeric" data-plan="${k.id}" value="${st.plan[k.id] ?? ''}" aria-label="Pieces of ${k.code}" /></td>` : html`<td class="r">–</td>`; })}</tr>`)}</tbody></table></div>
    <div class="row"><button class="primary" data-act="bm-calc">Work it out</button><button class="ghost" data-act="bm-clear">Clear</button></div></section>
  ${r ? html`<section class="card"><h2>${r.pieces.toLocaleString('en-IN')} pieces need</h2><p class="sub">${r.short_items ? `${r.short_items} material${r.short_items > 1 ? 's' : ''} short. Estimated cost to buy the shortage ${rs(r.buy_cost)}.` : 'Everything is covered by stock and orders.'}</p>
    <div class="scroll"><table class="mini"><thead><tr><th>Material</th><th class="r">Required</th><th class="r">In stock</th><th class="r">On order</th><th class="r">Short</th><th class="r">Buy cost</th></tr></thead><tbody>${r.rows.map((x) => html`<tr><td><span class="mono">${x.code}</span> ${x.name}</td><td class="r">${qty(String(x.required))} ${x.unit}</td><td class="r">${qty(String(x.in_stock))}</td><td class="r">${qty(String(x.on_order))}</td><td class="r ${x.short > 0 ? 'bad-t' : ''}">${x.short > 0 ? qty(String(x.short)) : '–'}</td><td class="r">${x.short > 0 ? rs(x.buy_cost) : '–'}${x.short > 0 && x.rate == null ? html` <small class="warn-t">no price</small>` : ''}</td></tr>`)}</tbody></table></div></section>` : ''}`;
}

// ───────────── events ─────────────
const styleVer = (id: string) => read(async (db) => (await db.query('SELECT version FROM product_style WHERE id=$1', [id])).rows[0].version as number);
const done = async () => { await R.render(); return true; };
const fresh = () => { st.ed = null; };

export async function onClick(t: HTMLElement): Promise<boolean> {
  const cell = t.closest('[data-cell]') as HTMLInputElement | null;
  if (cell) { const k = cell.dataset.cell!; cell.checked ? st.pickCells.add(k) : st.pickCells.delete(k); return done(); }
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b || !b.dataset.act?.startsWith('bm-')) return false;
  const a = b.dataset.act, id = b.dataset.id ?? '';
  syncLines(); syncPack(); syncPlan();
  const ed = st.ed;
  switch (a) {
    case 'bm-tab': st.tab = id as typeof st.tab; return done();
    case 'bm-newstyle': st.newStyle = !st.newStyle; st.draft = {}; return done();
    case 'bm-style': st.styleId = id; st.bomId = ''; st.skuPrev = ''; st.pickCells.clear(); st.planRes = null; st.plan = {}; st.editStyle = false; fresh(); return done();
    case 'bm-editstyle': st.editStyle = !st.editStyle; return done();
    case 'bm-rowall': { const row = id; const s = await read((db) => bom.getStyle(db, uid(), st.styleId)); const have = new Set(s.skus.map((k) => `${k.colour_code}|${k.size}`)); for (const z of s.style.sizes as string[]) if (!have.has(`${row}|${z}`)) st.pickCells.add(`${row}|${z}`); return done(); }
    case 'bm-makeskus': { const combos = [...st.pickCells].map((k) => { const [colour, size] = k.split('|'); return { colour, size }; }); const r = await act('SKUs created', (c) => bom.createSkus(c, { styleId: st.styleId, combos })); if (r) st.pickCells.clear(); return true; }
    case 'bm-makeall': await act('SKUs created', (c) => bom.createSkus(c, { styleId: st.styleId })); st.pickCells.clear(); return true;
    case 'bm-start': { const r = await act('New BOM version started', (c) => bom.startBom(c, { styleId: st.styleId })); if (r) { st.bomId = r.id; fresh(); await R.render(); } return true; }
    case 'bm-pick': st.bomId = id; st.skuPrev = ''; fresh(); return done();
    case 'bm-prev': st.skuPrev = st.skuPrev === id ? '' : id; return done();
    case 'bm-ladd': if (ed) { ed.lines.forEach((l) => (l.open = false)); ed.lines.push(blank()); } return done();
    case 'bm-ldel': if (ed) ed.lines.splice(Number(id), 1); return done();
    case 'bm-lopen': if (ed) ed.lines[Number(id)].open = !ed.lines[Number(id)].open; return done();
    case 'bm-save': case 'bm-submit': {
      if (!ed) return true;
      const lines = ed.lines.map((l) => ({ section: l.section as bom.Section, itemId: l.itemId, qty: l.qty, wastagePct: l.wastage || '0', sizes: l.sizes, colours: l.colours, qtyBySize: l.qbs, note: l.note || undefined }));
      const saved = await act('BOM saved', (c) => bom.saveBomLines(c, { bomId: ed.bomId, expectedRev: ed.rev, lines, notes: ed.notes || undefined }));
      if (!saved) return true;
      if (a === 'bm-submit') { const rv = await read(async (db) => (await db.query('SELECT rev FROM bom WHERE id=$1', [ed.bomId])).rows[0].rev as number); await act('Sent for approval', (c) => bom.submitBom(c, { bomId: ed.bomId, expectedRev: rv })); }
      fresh(); return done();
    }
    case 'bm-discard': if (ed) { await act('Draft discarded', (c) => bom.discardBom(c, { bomId: ed.bomId, expectedRev: ed.rev })); st.bomId = ''; fresh(); } return true;
    case 'bm-approve': case 'bm-return': {
      const cur = await read(async (db) => (await db.query('SELECT rev FROM bom WHERE id=$1', [st.bomId])).rows[0].rev as number);
      if (a === 'bm-approve') await act('BOM approved. Its SKUs are ready', (c) => bom.approveBom(c, { bomId: st.bomId, expectedRev: cur }));
      else await act('Returned to the maker', (c) => bom.returnBom(c, { bomId: st.bomId, expectedRev: cur, reason: val('bm-reason') }));
      fresh(); return true;
    }
    case 'bm-padd': (id === 's' ? st.pk.skus : st.pk.mats).push(id === 's' ? { skuId: '', qty: '1' } as never : { itemId: '', qty: '1' } as never); return done();
    case 'bm-pdel': (id[0] === 's' ? st.pk.skus : st.pk.mats).splice(Number(id.slice(1)), 1); return done();
    case 'bm-pfill': {
      const f = val('pk-fill'); if (!f) { toast('Choose what to add first', 'bad'); return true; }
      const s = await read((db) => bom.getStyle(db, uid(), st.styleId)); const [kind, v] = [f[0], f.slice(2)];
      const pick = s.skus.filter((k) => (kind === 'z' ? k.size === v : k.colour_code === v));
      if (!pick.length) { toast('No SKUs made yet for that choice. Create them on the first tab', 'bad'); return true; }
      for (const k of pick) if (!st.pk.skus.some((x) => x.skuId === k.id)) st.pk.skus.push({ skuId: k.id, qty: '1' });
      return done();
    }
    case 'bm-pstat': { await act('Pack updated', (c) => bom.setPackStatus(c, { packId: id, status: b.dataset.v as 'active' | 'inactive' })); return true; }
    case 'bm-calc': {
      const plan = Object.entries(st.plan).map(([skuId, q]) => ({ skuId, qty: Number(q) })).filter((p) => p.qty > 0);
      return calc(plan);
    }
    case 'bm-clear': st.plan = {}; st.planRes = null; return done();
  }
  return false;
}
async function calc(plan: { skuId: string; qty: number }[]) {
  try {
    const bomId = await read(async (db) => (await db.query(`SELECT id FROM bom WHERE style_id=$1 AND status='active'`, [st.styleId])).rows[0]?.id as string);
    st.planRes = await read((db) => bom.requirements(db, uid(), { bomId, plan }));
  } catch (e) { st.planRes = null; toast((e as Error).message, 'bad'); }
  return done();
}

export async function onSubmit(form: string, f?: HTMLElement): Promise<boolean> {
  if (!form.startsWith('bm-')) return false;
  if (form === 'bm-newstyle') {
    const r = await act('Style saved. Now create its SKUs', (c) => bom.createStyle(c, { code: val('ns-code'), name: val('ns-name'), category: val('ns-cat') || undefined, hsnCode: val('ns-hsn') || undefined, gstRate: val('ns-gst') || undefined, sizes: parseSizes(val('ns-sizes')), colours: parseColours(val('ns-cols')) }));
    if (r) { st.newStyle = false; st.styleId = r.id; st.draft = {}; fresh(); await R.render(); }
    else for (const k of ['ns-code', 'ns-name', 'ns-cat', 'ns-hsn', 'ns-gst', 'ns-sizes', 'ns-cols']) st.draft[k] = val(k);
    return true;
  }
  if (form === 'bm-editstyle') {
    const v = await styleVer(st.styleId);
    const r = await act('Style changed', (c) => bom.updateStyle(c, { styleId: st.styleId, expectedVersion: v, name: val('es-name'), category: val('es-cat') || undefined, sizes: parseSizes(val('es-sizes')), colours: parseColours(val('es-cols')) }));
    if (r) { st.editStyle = false; await R.render(); }
    return true;
  }
  if (form === 'bm-newpack') {
    syncPack();
    const r = await act('Pack created', (c) => bom.createPack(c, { code: st.pkCode, name: st.pkName, notes: st.pkNotes || undefined, skus: st.pk.skus.map((s) => ({ skuId: s.skuId, qty: Number(s.qty) })), materials: st.pk.mats.map((m) => ({ itemId: m.itemId, qty: m.qty })) }));
    if (r) { st.pk = { skus: [], mats: [] }; st.pkCode = st.pkName = st.pkNotes = ''; await R.render(); }
    void f; return true;
  }
  return false;
}

export async function onChange(t: HTMLInputElement): Promise<boolean> {
  if (t.id === 'bm-style') { syncLines(); syncPack(); st.styleId = t.value; st.bomId = ''; st.skuPrev = ''; st.pickCells.clear(); st.planRes = null; st.plan = {}; fresh(); await R.render(); return true; }
  if (t.dataset.bm === 'sec') { syncLines(); const i = Number(t.id.split('-')[1]); if (st.ed) st.ed.lines[i].itemId = ''; await R.render(); return true; }
  return false;
}

/** Used by the SKUs list to open a style on this screen. */
export function gotoStyle(id: string) { st.styleId = id; st.bomId = ''; st.tab = 'styles'; st.pickCells.clear(); st.ed = null; st.planRes = null; st.plan = {}; }
