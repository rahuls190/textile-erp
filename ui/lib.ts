// Tiny rendering helpers: auto-escaping html`` tag, number/date formatting.
export class Raw { constructor(public s: string) {} }
export const raw = (s: string) => new Raw(s);
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export function html(strings: TemplateStringsArray, ...vals: unknown[]): Raw {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      out += v instanceof Raw ? v.s : Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('') : esc(v);
    }
  });
  return new Raw(out);
}

/** "480.0000" → "480", "12.5000" → "12.5" (display only; stored values stay exact strings). */
export const qty = (v: string | null | undefined): string => {
  if (v === null || v === undefined || v === '') return '–';
  const s = String(v);
  const t = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  const [i, f] = t.split('.');
  return Number(i).toLocaleString('en-IN') + (f ? '.' + f : '');
};
export const money = (v: string | null | undefined): string =>
  v === null || v === undefined ? '–' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const when = (v: unknown): string => {
  const d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
export const dateOnly = (v: string | null | undefined): string => (v ? new Date(v + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '–');

const TONE: Record<string, string> = {
  draft: 'neutral', approval_pending: 'warn', approved: 'info', released: 'info', acknowledged: 'info', partial_receipt: 'warn',
  completed: 'ok', closed: 'neutral', cancelled: 'bad',
  pending: 'neutral', inspecting: 'info', submitted: 'warn', accepted: 'ok', held: 'warn', rejected: 'bad', partial: 'warn',
  proposed: 'warn', posted: 'ok', active: 'ok', released_: 'neutral',
};
export const chip = (status: string, label?: string): Raw =>
  html`<span class="chip ${TONE[status] ?? 'neutral'}">${label ?? status.replace(/_/g, ' ')}</span>`;
