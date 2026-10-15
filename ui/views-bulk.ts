// Shared tools for every master list: add several at once, import a CSV, export a CSV. Plus the SKUs list.
import { html, raw, chip, type Raw } from './lib.js';
import { K, S, uid, read, val, head, denied, R, opts, toast } from './ctx.js';
import * as md from '../src/domain/master-data.js';
import * as bulk from '../src/domain/bulk.js';
import * as BM from './views-bom.js';
import { can } from '../src/core/permissions.js';

const ANY = { anySite: true } as const;
type Mode = 'grid' | 'import' | 'export';
type Res = { created: number; updated?: number; skipped?: number; errors: { row: number; message: string }[]; dryRun: boolean };
const st = {
  panel: null as null | { head: bulk.Head; mode: Mode }, rows: [] as string[][], text: '', res: null as Res | null, exp: null as null | { csv: string; rows: number; file: string },
  sku: { q: '', style: '', status: '' },
};
const LABEL: Record<bulk.Head, string> = { vendors: 'vendors', distributors: 'distributors', retailers: 'retailers', materials: 'materials', finished: 'finished goods', skus: 'SKUs' };
const cols = (h: bulk.Head) => bulk.HEADS[h].header.split(',').filter((c) => c !== 'code'); // the add-several grid never asks for a code
const HINT: Record<string, string> = {
  name: 'Name', gstin: '29ABCDE1234F1Z5', pan: 'ABCDE1234F', city: 'City', state: 'State', phone: 'Phone', email: 'Email', payment_days: 'Days', contact_name: 'Contact', contact_phone: 'Contact phone',
  type: 'Type code', description: 'Description', hsn: 'HSN', gst: 'GST %', reorder_level: 'Reorder at', unit: 'Unit', style: 'Style code', size: 'Size', colour_code: 'BLK', colour_name: 'Black',
};
const NARROW = new Set(['payment_days', 'gst', 'hsn', 'unit', 'reorder_level', 'size', 'colour_code', 'type']);

const syncGrid = () => { const h = st.panel?.head; if (!h || st.panel?.mode !== 'grid') return; const n = cols(h).length; st.rows = st.rows.map((r, i) => Array.from({ length: n }, (_, c) => (document.getElementById(`bk-${i}-${c}`) as HTMLInputElement | null)?.value.trim() ?? r[c] ?? '')); };
const blankRows = (h: bulk.Head, n = 5) => Array.from({ length: n }, () => cols(h).map(() => ''));

/** Buttons for a list plus whichever panel is open. `canAdd` hides the add and import buttons from people who may only look. */
export function bulkBar(h: bulk.Head, canAdd: boolean): Raw {
  const p = st.panel?.head === h ? st.panel : null;
  const btn = (m: Mode, label: string) => html`<button class="${p?.mode === m ? 'on' : ''}" data-act="bk-open" data-id="${h}:${m}">${label}</button>`;
  return html`<div class="row bulk">${canAdd ? html`${btn('grid', 'Add several')}${btn('import', 'Import CSV')}` : ''}${btn('export', 'Export CSV')}</div>${p ? panel(h, p.mode, canAdd) : ''}`;
}
function result(r: Res | null): Raw {
  if (!r) return html``;
  if (r.errors.length) return html`<div class="note bad-t"><b>${r.errors.length} row${r.errors.length > 1 ? 's' : ''} need fixing. Nothing was saved.</b><ul>${r.errors.slice(0, 30).map((e) => html`<li>Row ${e.row}: ${e.message}</li>`)}${r.errors.length > 30 ? html`<li>…and ${r.errors.length - 30} more</li>` : ''}</ul></div>`;
  const parts = [r.created ? `${r.created} new` : '', r.updated ? `${r.updated} changed` : '', r.skipped ? `${r.skipped} already there` : ''].filter(Boolean).join(', ') || 'nothing to do';
  return html`<p class="note">${r.dryRun ? `All rows look good: ${parts}. Press “Save all” to apply them.` : `Done: ${parts}.`}</p>`;
}
function panel(h: bulk.Head, mode: Mode, canAdd: boolean): Raw {
  const label = LABEL[h];
  if (mode === 'grid' && canAdd) {
    const cs = cols(h);
    if (!st.rows.length) st.rows = blankRows(h);
    return html`<form class="card form" data-form="bk-grid"><h2>Add several ${label}</h2><p class="sub">Fill one row for each. Empty rows are ignored. Every row is checked and nothing is saved unless all of them are good.</p>
      <div class="scroll"><table class="mini grid-in"><thead><tr><th>#</th>${cs.map((c) => html`<th>${c.replace(/_/g, ' ')}</th>`)}<th></th></tr></thead><tbody>${st.rows.map((r, i) => html`<tr><td>${i + 1}</td>${cs.map((c, k) => html`<td><input id="bk-${i}-${k}" value="${r[k] ?? ''}" placeholder="${HINT[c] ?? ''}" ${NARROW.has(c) ? raw('style="width:84px"') : ''} aria-label="${c.replace(/_/g, ' ')}, row ${i + 1}" /></td>`)}<td><button type="button" class="ghost" data-act="bk-rowdel" data-id="${i}" aria-label="Remove row">✕</button></td></tr>`)}</tbody></table></div>
      <div class="row"><button type="button" data-act="bk-rowadd">Add a row</button><button type="submit" data-check="1">Check</button><button class="primary" type="submit">Save all</button><button type="button" data-act="bk-close">Close</button></div>${result(st.res)}</form>`;
  }
  if (mode === 'import' && canAdd) {
    return html`<form class="card form" data-form="bk-import"><h2>Import ${label} from a CSV file</h2>
      <p class="sub">The first line is the column names: <code>${bulk.HEADS[h].header}</code>. Leave <code>code</code> empty to add a new one. Put an existing code to change that row instead. Export first to get a file you can edit and load back.</p>
      <div class="row"><input type="file" id="bk-file" accept=".csv,text/csv,text/plain" aria-label="Choose a CSV file" /></div>
      <label>…or paste rows here<textarea id="bk-text" rows="7" placeholder="${bulk.HEADS[h].header}&#10;${bulk.HEADS[h].sample}">${st.text}</textarea></label>
      <div class="row"><button type="submit" data-check="1">Check only</button><button class="primary" type="submit">Save all</button><button type="button" data-act="bk-close">Close</button></div>${result(st.res)}</form>`;
  }
  const e = st.exp;
  return html`<section class="card"><h2>Export ${label}</h2>${e ? html`<p class="sub">${e.rows} row${e.rows === 1 ? '' : 's'}. The columns match the import, so the file can be edited and loaded back.</p>
    <div class="row"><button class="primary" data-act="bk-download">Download ${e.file}</button><button data-act="bk-copy">Copy to clipboard</button><button data-act="bk-close">Close</button></div>
    <p class="note">If the download does not start (some browsers and this demo page block it), press Copy and paste into a spreadsheet.</p>
    <label>File contents<textarea id="bk-out" rows="7" readonly>${e.csv}</textarea></label>` : html`<p class="empty">Preparing…</p>`}</section>`;
}

const reset = () => { st.rows = []; st.text = ''; st.res = null; st.exp = null; };
async function run(h: bulk.Head, csv: string, dry: boolean) {
  try {
    const r = await K.world.as(S.user, (c) => (h === 'skus' ? bulk.importSkus(c, csv, dry) : h === 'materials' || h === 'finished' ? md.importMaterials(c, csv, dry, h === 'finished' ? 'fg' : 'materials') : md.importParties(c, csv, dry, h === 'vendors' ? 'vendor' : h === 'distributors' ? 'distributor' : 'retailer'))) as Res;
    st.res = r;
    if (!dry && !r.errors.length) { toast(`${LABEL[h]}: ${[r.created && r.created + ' added', r.updated && r.updated + ' changed'].filter(Boolean).join(', ') || 'no changes'}`); st.rows = blankRows(h); st.text = ''; }
  } catch (e) { toast((e as Error).message, 'bad'); }
  await R.render();
}

export async function onClick(t: HTMLElement): Promise<boolean> {
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b || !b.dataset.act?.startsWith('bk-')) return false;
  const id = b.dataset.id ?? '';
  syncGrid();
  switch (b.dataset.act) {
    case 'bk-open': {
      const [h, m] = id.split(':') as [bulk.Head, Mode];
      if (st.panel?.head === h && st.panel.mode === m) { st.panel = null; return done(); }
      reset(); st.panel = { head: h, mode: m };
      if (m === 'export') { await R.render(); try { st.exp = await read((db) => bulk.exportCsv(db, uid(), h)); } catch (e) { toast((e as Error).message, 'bad'); st.panel = null; } }
      return done();
    }
    case 'bk-close': st.panel = null; reset(); return done();
    case 'bk-rowadd': if (st.panel) st.rows.push(cols(st.panel.head).map(() => '')); return done();
    case 'bk-rowdel': st.rows.splice(Number(id), 1); return done();
    case 'bk-copy': {
      const text = st.exp?.csv ?? ''; try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into a spreadsheet'); } catch { const ta = document.getElementById('bk-out') as HTMLTextAreaElement | null; ta?.select(); toast('Select the text and copy it (Ctrl+C)', 'bad'); } return true;
    }
    case 'bk-download': {
      if (!st.exp) return true;
      try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([st.exp.csv], { type: 'text/csv' })); a.download = st.exp.file; document.body.appendChild(a); a.click(); a.remove(); toast(`Saving ${st.exp.file}. If nothing happens, use Copy instead`); } catch { toast('Download is blocked here. Use Copy instead', 'bad'); } return true;
    }
    case 'bk-gostyle': BM.gotoStyle(id); S.view = 'products'; history.replaceState(null, '', '#products'); return done();
  }
  return false;
}
const done = async () => { await R.render(); return true; };

export async function onSubmit(form: string, _f?: HTMLElement, ev?: SubmitEvent): Promise<boolean> {
  if (!form.startsWith('bk-')) return false;
  const h = st.panel?.head; if (!h) return true;
  const dry = (ev?.submitter as HTMLElement | null)?.dataset.check === '1';
  if (form === 'bk-grid') {
    syncGrid();
    const rows = st.rows.filter((r) => r.some((x) => x));
    if (!rows.length) { toast('Fill in at least one row', 'bad'); return true; }
    const csv = bulk.toCsv(cols(h), rows);
    // Row numbers in messages refer to the filled rows, so map them back to what the person sees.
    const shown = st.rows.map((r, i) => (r.some((x) => x) ? i + 1 : 0)).filter(Boolean);
    await run(h, csv, dry);
    if (st.res?.errors.length) st.res = { ...st.res, errors: st.res.errors.map((e) => ({ ...e, row: shown[e.row - 2] ?? e.row })) };
    await R.render(); return true;
  }
  if (form === 'bk-import') { st.text = val('bk-text'); if (!st.text.trim()) { toast('Choose a file or paste rows first', 'bad'); return true; } await run(h, st.text, dry); return true; }
  return false;
}
export async function onChange(t: HTMLInputElement): Promise<boolean> {
  if (t.id === 'bk-file' && t.files?.[0]) { const f = t.files[0]; if (f.size > 2_000_000) { toast('That file is over 2 MB. Split it into smaller files', 'bad'); return true; } st.text = await f.text(); st.res = null; await R.render(); return true; }
  if (t.id === 'sk-style') { st.sku.style = t.value; await R.render(); return true; }
  if (t.id === 'sk-status') { st.sku.status = t.value; await R.render(); return true; }
  return false;
}
export async function onInput(t: HTMLInputElement): Promise<boolean> {
  if (t.id !== 'sk-q') return false;
  st.sku.q = t.value; await R.render(); const el = document.getElementById('sk-q') as HTMLInputElement | null; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } return true;
}

// ───────────── SKUs list ─────────────
export async function skusView(): Promise<Raw> {
  const d = await read(async (db) => {
    if (!(await can(db, uid(), 'bom.view', ANY))) return null;
    const rows = (await db.query(
      `SELECT k.id, k.code, k.size, k.colour_code, s.id AS style_id, s.code AS style, s.name AS style_name, i.status AS item_status, i.name,
              (SELECT b.version FROM bom b WHERE b.style_id=s.id AND b.status='active') AS bom_version,
              COALESCE((SELECT sum(qty) FROM stock_ledger l WHERE l.item_id=i.id AND l.status='ACCEPTED'),0)::text AS on_hand
         FROM sku k JOIN product_style s ON s.id=k.style_id JOIN item i ON i.id=k.item_id ORDER BY k.code`)).rows as { id: string; code: string; size: string; colour_code: string; style_id: string; style: string; style_name: string; item_status: string; name: string; bom_version: number | null; on_hand: string }[];
    const styles = (await db.query('SELECT id, code, name FROM product_style ORDER BY code')).rows as { id: string; code: string; name: string }[];
    return { rows, styles, create: await can(db, uid(), 'bom.create', ANY) };
  });
  if (!d) return denied('SKUs', 'One stock item for every size and colour of a style.', 'Your role cannot see SKUs.');
  const q = st.sku.q.toLowerCase();
  const list = d.rows.filter((r) => (!st.sku.style || r.style_id === st.sku.style) && (!st.sku.status || (st.sku.status === 'ready' ? r.item_status === 'active' : r.item_status !== 'active')) && (!q || r.code.toLowerCase().includes(q) || r.colour_code.toLowerCase().includes(q)));
  const ready = d.rows.filter((r) => r.item_status === 'active').length;
  return html`${head('SKUs', 'One stock item for every size and colour of a style, each with its own barcode. A SKU is ready once its style has an approved BOM.', d.create ? html`<button class="primary" data-act="bk-gostyle" data-id="${d.styles[0]?.id ?? ''}">New style or SKUs by grid</button>` : undefined)}
  <section class="card crm-sum"><div class="crm-k"><span>SKUs</span><b>${d.rows.length}</b></div><div class="crm-k"><span>Styles</span><b>${d.styles.length}</b></div><div class="crm-k"><span>Ready</span><b>${ready}</b></div><div class="crm-k"><span>Waiting for a BOM</span><b class="${d.rows.length - ready ? 'warn-t' : ''}">${d.rows.length - ready}</b></div></section>
  ${bulkBar('skus', d.create)}
  <section class="card"><div class="row"><input id="sk-q" type="search" placeholder="Search SKU code or colour" value="${st.sku.q}" style="flex:1;min-width:140px" /><select id="sk-style" aria-label="Style">${opts(d.styles.map((s) => ({ id: s.id, label: `${s.code} · ${s.name}` })), st.sku.style, 'Every style')}</select><select id="sk-status" aria-label="Status">${opts([{ id: 'ready', label: 'Ready' }, { id: 'waiting', label: 'Waiting for a BOM' }], st.sku.status, 'Any status')}</select></div>
    ${list.length ? html`<div class="scroll"><table class="mini"><thead><tr><th>SKU</th><th>Style</th><th>Size</th><th>Colour</th><th class="r">In stock</th><th>BOM</th><th>Status</th><th></th></tr></thead><tbody>${list.slice(0, 300).map((r) => html`<tr><td class="mono">${r.code}</td><td>${r.style_name}</td><td>${r.size}</td><td>${r.colour_code}</td><td class="r">${Number(r.on_hand).toLocaleString('en-IN')}</td><td>${r.bom_version ? `v${r.bom_version}` : '–'}</td><td>${chip(r.item_status === 'active' ? 'active' : 'draft', r.item_status === 'active' ? 'ready' : 'waiting')}</td><td>${d.create ? html`<button class="link" data-act="bk-gostyle" data-id="${r.style_id}">edit style</button>` : ''}</td></tr>`)}</tbody></table></div>${list.length > 300 ? html`<p class="note">Showing the first 300 of ${list.length}. Narrow the search.</p>` : ''}` : html`<p class="empty">No SKUs match.</p>`}</section>`;
}
void uid;
