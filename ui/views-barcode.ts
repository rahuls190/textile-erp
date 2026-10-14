import { html, raw, qty, type Raw } from './lib.js';
import { S, uid, read, act, head, denied, R, toast, K } from './ctx.js';
import * as bc from '../src/domain/barcode.js';
import { can } from '../src/core/permissions.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import JsBarcode from 'jsbarcode';

type Labels = Awaited<ReturnType<typeof bc.labelData>>;
let tab: 'scan' | 'labels' = 'scan';
let mode: 'lookup' | 'move' = 'lookup';
let found: Awaited<ReturnType<typeof bc.resolveScan>> | null = null;
let mvLot: { label: string; item: string } | null = null;
let log: { ok: boolean; text: string; sub?: string }[] = [];
const sel = new Set<string>();
let ltype: 'lots' | 'locations' = 'lots', lsize: 'small' | 'large' = 'small', copies = 1;
let cam: { stop: () => void } | null = null;

/** Code 128 barcode as inline SVG (drawn in memory so it can sit inside a template). */
function bars(text: string, height = 40): string {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  try { JsBarcode(s, text, { format: 'CODE128', displayValue: false, height, width: 1.7, margin: 0, background: 'transparent', lineColor: '#000' }); } catch { return '<span class="bad-t">cannot print</span>'; }
  return s.outerHTML;
}
const place = (w: { code: string; status: string; qty: string }) => html`<tr><td>${w.code}</td><td><span class="chip ${w.status === 'ACCEPTED' ? 'ok' : w.status === 'HOLD' ? 'warn' : 'bad'}">${w.status === 'HOLD' ? 'On QC hold' : w.status.toLowerCase()}</span></td><td class="r">${qty(w.qty)}</td></tr>`;

function foundCard(): Raw {
  if (!found) return html`<p class="empty">Scan a roll label or a shelf label. A USB scanner works like a keyboard: click the box and scan.</p>`;
  if (found.type === 'lot') {
    const f = found;
    return html`<div class="sc-card"><div class="sc-barcode">${raw(bars(f.lot.label, 34))}<b>${f.lot.label}</b></div><p><b>${f.lot.item_code}</b> · ${f.lot.item_name} <small>(${f.lot.unit})</small></p>
      ${f.where.length ? html`<table class="mini"><thead><tr><th>Where</th><th>State</th><th class="r">Quantity</th></tr></thead><tbody>${f.where.map(place)}</tbody></table>` : html`<p class="empty">No stock on this roll.</p>`}
      <div class="rp-sum"><div class="rp-tile"><span>Free to use</span><b>${qty(f.availability.available)}</b></div><div class="rp-tile"><span>Reserved</span><b>${qty(f.availability.reserved)}</b></div></div></div>`;
  }
  const f = found;
  return html`<div class="sc-card"><p><b>${f.location.code}</b> · ${f.location.name} <span class="chip neutral">${f.location.kind.toLowerCase()}</span></p>
    ${f.lots.length ? html`<table class="mini"><thead><tr><th>Roll</th><th>Item</th><th>State</th><th class="r">Quantity</th></tr></thead><tbody>${f.lots.map((l) => html`<tr><td>${l.label}</td><td>${l.item_code}</td><td>${l.status.toLowerCase()}</td><td class="r">${qty(l.qty)}</td></tr>`)}</tbody></table>` : html`<p class="empty">Nothing is stored here.</p>`}</div>`;
}

export async function barcodesView(): Promise<Raw> {
  const d = await read(async (db) => ({ ok: await can(db, uid(), 'inventory.view', { anySite: true }), move: await can(db, uid(), 'putaway.execute', { anySite: true }), labels: tab === 'labels' ? await bc.labelData(db, uid()) : null }));
  if (!d.ok) return denied('Scan and labels', 'Barcodes for rolls and shelves.', 'Your role cannot see stock.');
  const camOk = typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const tabs = html`<div class="tabs"><button class="${tab === 'scan' ? 'on' : ''}" data-act="bc-tab" data-id="scan">Scan</button><button class="${tab === 'labels' ? 'on' : ''}" data-act="bc-tab" data-id="labels">Print labels</button></div>`;
  if (tab === 'scan') {
    const step = mode === 'move' ? (mvLot ? 2 : 1) : 0;
    return html`${head('Scan and labels', 'Read a roll or a shelf, or move stock forward by scanning the roll and then the next place.')}${tabs}
    <section class="split sc">
      <div class="card"><div class="seg2"><button class="${mode === 'lookup' ? 'on' : ''}" data-act="bc-mode" data-id="lookup">Look up</button>${d.move ? html`<button class="${mode === 'move' ? 'on' : ''}" data-act="bc-mode" data-id="move">Move forward</button>` : ''}</div>
        ${mode === 'move' ? html`<ol class="sc-steps"><li class="${step === 1 ? 'now' : 'done'}">1 · Scan the roll</li><li class="${step === 2 ? 'now' : ''}">2 · Scan where it goes next</li></ol>
          <label class="sc-q">Quantity to move <input id="sc-qty" inputmode="decimal" placeholder="all usable stock" /></label><p class="sub">Route: Receiving → Store → Rack. Only released stock moves; held or rejected rolls are refused.</p>` : ''}
        <form class="sc-form" data-form="scan"><input id="sc-in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${mode === 'move' ? (mvLot ? 'Scan the shelf label (L:STORE-A)' : 'Scan the roll label') : 'Scan a roll or shelf label'}" /><button class="primary" type="submit">Read</button>${camOk ? html`<button type="button" data-act="bc-cam">${cam ? 'Stop camera' : 'Camera'}</button>` : ''}</form>
        ${cam ? html`<video id="sc-video" class="sc-video" playsinline muted></video>` : ''}
        ${mvLot ? html`<p class="sc-now">Roll in hand: <b>${mvLot.label}</b> · ${mvLot.item} <button class="link" data-act="bc-clear">clear</button></p>` : ''}
        ${log.length ? html`<ul class="sc-log">${log.slice(0, 8).map((l) => html`<li class="${l.ok ? 'ok' : 'no'}"><b>${l.text}</b>${l.sub ? html`<small>${l.sub}</small>` : ''}</li>`)}</ul>` : ''}</div>
      <div class="card"><h2>${mode === 'move' ? 'Roll and where it is' : 'What it is'}</h2>${foundCard()}</div>
    </section>`;
  }
  const L = d.labels as Labels;
  const rows = ltype === 'lots' ? L.lots.filter((l) => l.printable) : L.locations;
  const keyOf = (r: (typeof rows)[number]) => (ltype === 'lots' ? (r as Labels['lots'][number]).label : (r as Labels['locations'][number]).barcode);
  const chosen = rows.filter((r) => sel.has(keyOf(r)));
  const one = (r: (typeof rows)[number]): Raw => {
    if (ltype === 'lots') { const l = r as Labels['lots'][number]; return html`<div class="lbl ${lsize}"><div class="lb-top"><b>${l.item_code}</b><span>${l.site} · ${l.date}</span></div><div class="lb-name">${l.item_name}</div>${raw(bars(l.label, lsize === 'large' ? 56 : 34))}<div class="lb-code">${l.label}</div><div class="lb-qty">${qty(l.qty)} ${l.unit}</div></div>`; }
    const x = r as Labels['locations'][number]; return html`<div class="lbl ${lsize}"><div class="lb-top"><b>${x.code}</b><span>${x.site}</span></div><div class="lb-name">${x.name}</div>${raw(bars(x.barcode, lsize === 'large' ? 56 : 34))}<div class="lb-code">${x.barcode}</div></div>`;
  };
  const sheet = chosen.flatMap((r) => Array.from({ length: copies }, () => one(r)));
  return html`${head('Scan and labels', 'Print Code 128 labels for rolls and shelves. Every scanner reads them.')}${tabs}
  <section class="card no-print"><div class="lb-ctl">
    <div class="seg2"><button class="${ltype === 'lots' ? 'on' : ''}" data-act="bc-ltype" data-id="lots">Roll labels</button><button class="${ltype === 'locations' ? 'on' : ''}" data-act="bc-ltype" data-id="locations">Shelf labels</button></div>
    <label>Size <select id="lb-size"><option value="small" ${lsize === 'small' ? raw('selected') : ''}>Small 50 × 25 mm</option><option value="large" ${lsize === 'large' ? raw('selected') : ''}>Large 100 × 50 mm</option></select></label>
    <label>Copies <input id="lb-copies" type="number" min="1" max="10" value="${copies}" style="width:70px" /></label>
    <button data-act="bc-all">${chosen.length === rows.length && rows.length ? 'Clear selection' : 'Select all'}</button>
    <button class="primary" data-act="bc-print" ${chosen.length ? '' : raw('disabled')}>Print ${sheet.length || ''} label${sheet.length === 1 ? '' : 's'}</button></div>
    <p class="sub">Printing opens your browser's print window (it may be blocked inside the preview; use the hosted site). Reprinting a roll gives the same barcode; the code is its identity.</p>
    <ul class="lb-pick">${rows.map((r) => html`<li><label><input type="checkbox" data-act="bc-tog" data-id="${keyOf(r)}" ${sel.has(keyOf(r)) ? raw('checked') : ''} /> <b>${ltype === 'lots' ? (r as Labels['lots'][number]).label : (r as Labels['locations'][number]).code}</b> <small>${ltype === 'lots' ? (r as Labels['lots'][number]).item_name + ' · ' + qty((r as Labels['lots'][number]).qty) + ' ' + (r as Labels['lots'][number]).unit : (r as Labels['locations'][number]).name}</small></label></li>`)}</ul></section>
  ${sheet.length ? html`<section class="card"><h2>Preview</h2><div class="label-sheet ${lsize}">${sheet}</div></section>` : ''}`;
}

async function handleScan(code: string) {
  code = code.trim(); if (!code) return;
  const me = { id: uid(), username: S.user };
  if (mode === 'lookup') {
    try { found = await read((db) => bc.resolveScan(db, uid(), code)); log.unshift({ ok: true, text: code }); } catch (e) { found = null; log.unshift({ ok: false, text: code, sub: (e as Error).message }); }
    return R.render();
  }
  // move forward
  if (!mvLot) {
    try {
      const r = await read((db) => bc.resolveScan(db, uid(), code));
      if (r.type !== 'lot') { log.unshift({ ok: false, text: code, sub: 'That is a shelf. Scan the roll first.' }); return R.render(); }
      mvLot = { label: r.lot.label, item: r.lot.item_code }; found = r; log.unshift({ ok: true, text: 'Roll ' + r.lot.label });
    } catch (e) { log.unshift({ ok: false, text: code, sub: (e as Error).message }); }
    return R.render();
  }
  const q = (document.getElementById('sc-qty') as HTMLInputElement | null)?.value.trim();
  const lotCode = mvLot.label;
  const out = await act('Moved forward', (c) => bc.moveForward(c, { lotCode, toLocationCode: code, qty: q || undefined }));
  if (out) {
    log.unshift({ ok: true, text: `Moved ${out.moved.map((m) => `${m.qty} m from ${m.from}`).join(', ')} to ${out.to}`, sub: lotCode });
    mvLot = null;
    try { found = await read((db) => bc.resolveScan(db, uid(), lotCode)); } catch { /* keep previous */ }
  } else log.unshift({ ok: false, text: `Not moved to ${code}`, sub: 'See the message above; fix it and scan the shelf again.' });
  void me; await R.render();
}

async function startCamera() {
  const BD = (window as unknown as { BarcodeDetector: new (o: object) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    cam = { stop: () => { stream.getTracks().forEach((t) => t.stop()); cam = null; } };
    await R.render();
    const v = document.getElementById('sc-video') as HTMLVideoElement; v.srcObject = stream; await v.play();
    const det = new BD({ formats: ['code_128', 'qr_code'] }); let lastCode = '', lastAt = 0;
    const tick = async () => {
      if (!cam) return;
      try { const r = await det.detect(v); const c = r[0]?.rawValue; if (c && (c !== lastCode || Date.now() - lastAt > 3000)) { lastCode = c; lastAt = Date.now(); await handleScan(c); } } catch { /* frame not ready */ }
      setTimeout(tick, 350);
    };
    void tick();
  } catch { cam = null; toast('The camera could not be opened here. Use a scanner or type the code.', 'bad'); await R.render(); }
}

export async function onClick(t: HTMLElement): Promise<boolean> {
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b) return false;
  const id = b.dataset.id ?? '';
  switch (b.dataset.act) {
    case 'bc-tab': tab = id as typeof tab; await R.render(); return true;
    case 'bc-mode': mode = id as typeof mode; mvLot = null; found = null; await R.render(); focusScan(); return true;
    case 'bc-clear': mvLot = null; await R.render(); focusScan(); return true;
    case 'bc-cam': if (cam) { cam.stop(); await R.render(); } else await startCamera(); return true;
    case 'bc-ltype': ltype = id as typeof ltype; sel.clear(); await R.render(); return true;
    case 'bc-tog': { if (sel.has(id)) sel.delete(id); else sel.add(id); await R.render(); return true; }
    case 'bc-all': {
      const L = await read((db) => bc.labelData(db, uid()));
      const keys = ltype === 'lots' ? L.lots.filter((l) => l.printable).map((l) => l.label) : L.locations.map((l) => l.barcode);
      if (keys.every((k) => sel.has(k)) && keys.length) sel.clear(); else keys.forEach((k) => sel.add(k));
      await R.render(); return true;
    }
    case 'bc-print': window.print(); return true;
  }
  return false;
}
const focusScan = () => setTimeout(() => (document.getElementById('sc-in') as HTMLInputElement | null)?.focus(), 30);

document.addEventListener('change', (ev) => {
  const t = ev.target as HTMLElement;
  if (t.id === 'lb-size') { lsize = (t as HTMLSelectElement).value as typeof lsize; void R.render(); }
  if (t.id === 'lb-copies') { copies = Math.min(10, Math.max(1, Number((t as HTMLInputElement).value) || 1)); void R.render(); }
});

export async function onSubmit(form: string): Promise<boolean> {
  if (form !== 'scan') return false;
  const inp = document.getElementById('sc-in') as HTMLInputElement; const code = inp.value; inp.value = '';
  await handleScan(code); focusScan(); return true;
}
void K;
