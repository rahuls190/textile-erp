// Multi-item purchase order form: every item has its own quantity and due date.
import { html, raw, money, qty as fq, type Raw } from './lib.js';
import { R, S, K, act, read, toast, uid } from './ctx.js';
import * as po from '../src/domain/po.js';

type Line = { item: string; qty: string; due: string };
type Item = { id: string; code: string; name: string; stock_unit: string };
type Vendor = { id: string; code: string; name: string };
export const F = { rated: [] as string[], open: false, poId: '', version: 0, vendor: '', lines: [] as Line[], quote: [] as { rate: string | null; unit: string | null; amount: string | null }[] };

const addDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const blankLine = (item: string, due?: string): Line => ({ item, qty: '', due: due ?? addDays(30) });

async function loadRated() { try { F.rated = await read((db) => po.pricedItems(db, uid(), F.vendor)); } catch { F.rated = []; } }
export async function openNew(items: Item[], vendors: Vendor[]) {
  F.open = true; F.poId = ''; F.version = 0; F.vendor = vendors[0]?.id ?? ''; F.quote = []; await loadRated();
  F.lines = [blankLine(items.find((i) => F.rated.includes(i.id))?.id ?? items[0]?.id ?? '')];
}
export async function openEdit(poId: string) {
  const p = await read((db) => po.getPO(db, uid(), poId));
  F.open = true; F.poId = poId; F.version = p.version; F.vendor = p.partner_id;
  F.lines = p.lines.map((l: Record<string, string>) => ({ item: l.item_id, qty: String(l.qty).replace(/\.?0+$/, ''), due: l.due_date ? String(l.due_date).slice(0, 10) : '' }));
  F.quote = []; await loadRated();
}

export function formView(items: Item[], vendors: Vendor[]): Raw {
  if (!F.open) return html``;
  const unit = (id: string) => items.find((i) => i.id === id)?.stock_unit ?? '';
  const editing = !!F.poId;
  const total = F.quote.reduce((a, q) => a + (q.amount ? Number(q.amount) : 0), 0);
  const missing = F.quote.some((q, i) => !q.rate && Number(F.lines[i]?.qty) > 0);
  return html`<form class="card form pof" data-form="newpo">
    <h2>${editing ? 'Edit draft order' : 'New purchase order'}</h2>
    <label>Vendor<select id="pl-vendor" ${editing ? raw('disabled') : ''}>${vendors.map((v) => html`<option value="${v.id}" ${v.id === F.vendor ? raw('selected') : ''}>${v.code} · ${v.name}</option>`)}</select></label>
    <div class="scroll"><table class="mini pol"><thead><tr><th>#</th><th>Item</th><th>Quantity</th><th>Due date</th><th class="r">Price</th><th class="r">Amount</th><th></th></tr></thead><tbody>
      ${F.lines.map((l, i) => html`<tr><td>${i + 1}</td>
        <td><select data-pl="item" data-i="${i}" aria-label="Item ${i + 1}"><optgroup label="Priced with this vendor">${items.filter((it) => F.rated.includes(it.id)).map((it) => html`<option value="${it.id}" ${it.id === l.item ? raw('selected') : ''}>${it.code} · ${it.name}</option>`)}</optgroup><optgroup label="No approved price yet">${items.filter((it) => !F.rated.includes(it.id)).map((it) => html`<option value="${it.id}" ${it.id === l.item ? raw('selected') : ''}>${it.code} · ${it.name}</option>`)}</optgroup></select></td>
        <td><div class="qwrap"><input data-pl="qty" data-i="${i}" inputmode="decimal" value="${l.qty}" placeholder="0" aria-label="Quantity ${i + 1}" /><span class="u" id="pl-u-${i}">${unit(l.item)}</span></div></td>
        <td><input data-pl="due" data-i="${i}" type="date" value="${l.due}" aria-label="Due date ${i + 1}" /></td>
        <td class="r" id="pl-rate-${i}">${rateText(i)}</td><td class="r" id="pl-amt-${i}">${F.quote[i]?.amount ? money(F.quote[i].amount!) : '–'}</td>
        <td>${F.lines.length > 1 ? html`<button type="button" class="ghost sm" data-act="pl-del" data-id="${i}" aria-label="Remove item ${i + 1}">✕</button>` : ''}</td></tr>`)}
    </tbody><tfoot><tr><td colspan="5" class="r"><b>Total (before tax)</b></td><td class="r"><b id="pl-total">${total ? money(String(total)) : '–'}</b></td><td></td></tr></tfoot></table></div>
    <div class="row"><button type="button" data-act="pl-add">+ Add next item</button><small>${F.lines.length} item${F.lines.length === 1 ? '' : 's'}. Each has its own quantity and due date.</small></div>
    <p class="note" id="pl-warn">${missing ? raw('<span class="bad-t">Some items have no approved price with this vendor for that quantity. Propose and approve a rate first.</span>') : "Prices come from the vendor's approved rates and are copied onto the order, so later rate changes never rewrite it."}</p>
    <div class="row"><button class="primary" type="submit">${editing ? 'Save changes' : 'Create draft'}</button><button type="button" data-act="toggle-newpo">Close</button></div></form>`;
}
function rateText(i: number): string { const q = F.quote[i]; return q?.rate ? `${money(q.rate)} / ${q.unit ?? ''}` : (Number(F.lines[i]?.qty) > 0 ? '<span class="bad-t">no rate</span>' : '–'); }

let qT: ReturnType<typeof setTimeout> | undefined;
export const requoteNow = () => void requote();
async function requote() {
  if (!F.open || !F.vendor) return;
  try {
    F.quote = await read((db) => po.quoteLines(db, uid(), { partnerId: F.vendor, lines: F.lines.map((l) => ({ itemId: l.item, qty: l.qty })) }));
  } catch { F.quote = []; }
  F.lines.forEach((_, i) => { const u = document.getElementById('pl-u-' + i); if (u && F.quote[i]?.unit) u.textContent = F.quote[i].unit; const r = document.getElementById('pl-rate-' + i); if (r) r.innerHTML = rateText(i); const a = document.getElementById('pl-amt-' + i); if (a) a.textContent = F.quote[i]?.amount ? money(F.quote[i].amount!) : '–'; });
  const t = document.getElementById('pl-total'); if (t) { const sum = F.quote.reduce((x, q) => x + (q.amount ? Number(q.amount) : 0), 0); t.textContent = sum ? money(String(sum)) : '–'; }
  const w = document.getElementById('pl-warn'); if (w) { const miss = F.quote.some((q, i) => !q.rate && Number(F.lines[i]?.qty) > 0); if (miss) w.innerHTML = '<span class="bad-t">Some items have no approved price with this vendor for that quantity. Propose and approve a rate first.</span>'; }
}

export async function onClick(t: HTMLElement, items: () => Promise<Item[]>): Promise<boolean> {
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b) return false;
  switch (b.dataset.act) {
    case 'pl-add': { const last = F.lines[F.lines.length - 1]; const its = await items(); F.lines.push(blankLine((its.find((i) => F.rated.includes(i.id) && !F.lines.some((l) => l.item === i.id)) ?? its.find((i) => !F.lines.some((l) => l.item === i.id)))?.id ?? last.item, last.due)); await R.render(); await requote(); setTimeout(() => (document.querySelector(`[data-pl=qty][data-i="${F.lines.length - 1}"]`) as HTMLInputElement | null)?.focus(), 30); return true; }
    case 'pl-del': F.lines.splice(Number(b.dataset.id), 1); await R.render(); await requote(); return true;
    case 'po-editlines': await openEdit(S.poId); await R.render(); await requote(); return true;
  }
  return false;
}

export async function onSubmit(): Promise<void> {
  const lines = F.lines.map((l) => ({ itemId: l.item, qty: l.qty.trim(), dueDate: l.due || null }));
  if (lines.some((l) => !l.qty)) { toast('Give every item a quantity, or remove the empty row', 'bad'); return; }
  await act(F.poId ? 'Draft updated' : 'Draft purchase order created', async (c) => {
    const p = F.poId ? await po.updateDraftPO(c, { poId: F.poId, expectedVersion: F.version, lines }) : await po.createPO(c, { siteId: K.world.siteId, partnerId: F.vendor, lines });
    S.poId = p.id; F.open = false; return p;
  });
}

document.addEventListener('input', (ev) => {
  const t = ev.target as HTMLInputElement; if (!t.dataset?.pl) return;
  const l = F.lines[Number(t.dataset.i)]; if (!l) return;
  if (t.dataset.pl === 'qty') l.qty = t.value; else if (t.dataset.pl === 'due') l.due = t.value; else return;
  clearTimeout(qT); qT = setTimeout(() => void requote(), 250);
});
document.addEventListener('change', (ev) => {
  const t = ev.target as HTMLSelectElement;
  if (t.id === 'pl-vendor') { F.vendor = t.value; void loadRated().then(async () => { await R.render(); void requote(); }); return; }
  if (t.dataset?.pl === 'item') { const i = Number(t.dataset.i); F.lines[i].item = t.value; void requote(); }
  if (t.dataset?.pl === 'due') F.lines[Number(t.dataset.i)].due = (t as unknown as HTMLInputElement).value;
});
void fq;
