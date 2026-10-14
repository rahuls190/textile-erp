import type { Db } from '../db/pool.js';
import { badRequest } from '../core/errors.js';
import { availableDatasets, catalogue, DATASETS, validateSpec, describe, type Spec, type Agg } from './custom-reports.js';

/**
 * The report assistant. It turns a plain-language request ("total spend by vendor last 90 days, top 5") into a report SPEC.
 *
 *  • It is only ever shown the datasets this person is allowed to use.
 *  • Whatever it returns is checked by validateSpec and run by the same code and permissions as a hand-made report. It writes no SQL,
 *    cannot name a table or a column that is not in the catalogue, and cannot widen the person's site scope.
 *  • With a language-model provider configured (server: ANTHROPIC_API_KEY) it uses that. Without one (including the browser demo)
 *    a built-in keyword reader handles common requests, so the feature works with no outside service.
 */
export type Provider = (system: string, user: string) => Promise<string>;
export interface Interpretation { spec: Spec; explain: string[]; source: 'ai' | 'built-in'; note?: string }

/** Provider that calls the Anthropic Messages API. Only the person's question and the catalogue of allowed columns are sent: no business data. */
export function anthropicProvider(apiKey: string, model = process.env.AI_MODEL ?? 'claude-sonnet-5-5'): Provider {
  return async (system, user) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 700, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`AI service answered ${res.status}`);
    const j = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  };
}

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (s: string, n: number) => new Date(+new Date(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function systemPrompt(cat: ReturnType<typeof catalogue>): string {
  return `You turn a factory manager's request into a JSON report spec for a textile ERP. Reply with ONE JSON object and nothing else.
Shape: {"dataset":string,"group":[column keys],"measures":[{"field":measure key or "*","agg":"sum|count|avg|min|max"}],"filters":[{"field":key,"op":"eq|neq|gt|gte|lt|lte|contains","value":string}],"sort":{"key":string,"dir":"asc|desc"},"limit":number,"title":string}
Rules: use ONLY the datasets, columns and figures below. "*" with "count" counts rows. Sort key is a group column key or "<agg>_<measure>" (or "count"). Dates are YYYY-MM-DD; today is ${today()}. Months are YYYY-MM. Pick at most 3 group columns and 4 figures. If the request cannot be answered from these datasets reply {"error":"short reason"}.
Catalogue: ${JSON.stringify(cat)}`;
}

function parseJson(text: string): Record<string, unknown> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw badRequest('The assistant did not return a report');
  try { return JSON.parse(m[0]); } catch { throw badRequest('The assistant did not return a readable report'); }
}

// ── built-in reader ──
const norm = (s: string) => ' ' + s.toLowerCase().replace(/[^a-z0-9₹.\- ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
const has = (q: string, w: string) => q.includes(' ' + w + ' ') || (w.length > 3 && q.includes(' ' + w));

/** Optimal-string-alignment distance: a swapped or missing letter counts as one slip. */
function dist(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const BASE_WORDS = ['last', 'this', 'month', 'year', 'week', 'days', 'today', 'top', 'bottom', 'highest', 'lowest', 'total', 'average', 'count', 'many', 'number', 'wise', 'past', 'previous', 'pending', 'approved', 'cancelled', 'rejected', 'absent'];
/** Fix small typing slips ("yera", "vender", "employes") against the words the reader knows. */
function fixTypos(text: string, allowed: typeof DATASETS): string {
  const vocab = new Set<string>(BASE_WORDS);
  for (const d of allowed) { d.words.forEach((w) => w.split(' ').forEach((t) => vocab.add(t))); d.fields.forEach((f) => f.words.forEach((w) => w.split(' ').forEach((t) => vocab.add(t)))); }
  const list = [...vocab].filter((w) => w.length >= 4);
  return text.replace(/[a-z]+/gi, (tok) => {
    const t = tok.toLowerCase();
    if (t.length < 4 || vocab.has(t)) return tok;
    const max = t.length > 6 ? 2 : 1;
    let best: string | null = null, bd = 99;
    for (const w of list) { if (Math.abs(w.length - t.length) > max) continue; const x = dist(t, w); if (x < bd) { bd = x; best = w; } }
    return best && bd <= max ? best : tok;
  });
}
const NUMWORD: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
/** Things people ask about that this system does not hold yet. Better to say so than to guess. */
const NOT_BUILT: [RegExp, string][] = [
  [/ (sale|sales|sold|selling|customer|customers|invoice|invoices|revenue|dispatch) /, 'Sales and customer data are not in the system yet (the sales module is not built).'],
  [/ (production|stitching|cutting|wip|garments?) /, 'Production data is not in the system yet.'],
  [/ (profit|expense|expenses|ledger|gst|tax invoice|accounts?) /, 'Finance and accounting data are not in the system yet.'],
];

export function builtIn(question: string, allowed: typeof DATASETS): Interpretation {
  const q = norm(fixTypos(question, allowed));
  let best: { d: (typeof DATASETS)[number]; score: number } | null = null;
  for (const d of allowed) {
    let score = 0;
    for (const w of d.words) if (has(q, w)) score += w.length;
    for (const f of d.fields) if (f.measure && f.words.some((w) => has(q, w))) score += 2 * Math.max(...f.words.filter((w) => has(q, w)).map((w) => w.length));
    if (score > (best?.score ?? 0)) best = { d, score };
  }
  if (!best) {
    const nb = NOT_BUILT.find(([re]) => re.test(q));
    if (nb) throw badRequest(`${nb[1]} What I can report on: ${allowed.map((d) => d.label.toLowerCase()).join(', ')}.`);
    throw badRequest(`I could not tell which data you mean. Try naming it: ${allowed.map((d) => d.label.toLowerCase()).join(', ')}.`);
  }
  const d = best.d;
  const dims = d.fields.filter((f) => !f.measure), meas = d.fields.filter((f) => f.measure);
  const spec: Spec = { dataset: d.key, group: [], measures: [], filters: [], limit: undefined };
  // group by: "by X", "per X", "X wise", "each X"
  const pick = (list: typeof dims, w: string) => list.find((f) => f.key === w || f.words.some((x) => x === w));
  const grp: string[] = [];
  for (const m of q.matchAll(/ (?:by|per|each|wise) ([a-z]+(?: [a-z]+)?)(?= |$)/g)) {
    for (const cand of [m[1], m[1].split(' ')[0]]) { const f = pick(dims, cand); if (f && !grp.includes(f.key)) { grp.push(f.key); break; } }
  }
  for (const m of q.matchAll(/ ([a-z]+) wise /g)) { const f = pick(dims, m[1]); if (f && !grp.includes(f.key)) grp.push(f.key); }
  for (const m of q.matchAll(/ (?:top|bottom|best|worst|highest|lowest) (?:\d+ )?([a-z]+) /g)) {
    const w = m[1].replace(/s$/, ''); const f = pick(dims, m[1]) ?? pick(dims, w);
    if (f && !grp.includes(f.key)) grp.unshift(f.key);
  }
  spec.group = grp.slice(0, 3);
  // figures
  const wantCount = /( how many | count | number of )/.test(q);
  const aggWord: Agg | null = / (average|avg|mean) /.test(q) ? 'avg' : / (highest|maximum|max|largest) /.test(q) && !/top /.test(q) ? 'max' : / (lowest|minimum|min|smallest) /.test(q) && !/bottom /.test(q) ? 'min' : null;
  const measure = meas.find((f) => f.words.some((w) => has(q, w)));
  if (measure && !wantCount) spec.measures.push({ field: measure.key, agg: aggWord ?? 'sum' });
  else if (wantCount || spec.group.length) spec.measures.push({ field: '*', agg: 'count' });
  else if (meas.length) spec.measures.push({ field: meas[0].key, agg: 'sum' });
  // dates
  const df = d.fields.find((f) => f.key === d.dateField)!;
  const nDays0 = q.match(/ (?:last|past|previous) (\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)? ?(day|week|month|year)s? /);
  const nDays = nDays0 ? [nDays0[0], String(nDays0[1] ? (NUMWORD[nDays0[1]] ?? nDays0[1]) : 1), nDays0[3] ?? nDays0[2]] : null;
  const t = today();
  const range = (from: string, to?: string) => { spec.filters.push({ field: df.key, op: 'gte', value: from }); if (to) spec.filters.push({ field: df.key, op: 'lte', value: to }); };
  if (nDays) range(addDays(t, -Number(nDays[1]) * (nDays[2] === 'day' ? 1 : nDays[2] === 'week' ? 7 : nDays[2] === 'month' ? 30 : 365)));
  else if (/ this month /.test(q)) range(t.slice(0, 8) + '01');
  else if (/ last month /.test(q)) { const y = +t.slice(0, 4), mo = +t.slice(5, 7); const f = new Date(Date.UTC(y, mo - 2, 1)); range(f.toISOString().slice(0, 10), new Date(Date.UTC(y, mo - 1, 0)).toISOString().slice(0, 10)); }
  else if (/ this year /.test(q)) range(t.slice(0, 4) + '-01-01');
  else if (/ last week /.test(q)) range(addDays(t, -7));
  else if (/ today /.test(q)) range(t, t);
  // simple value filters: "vendor sunrise", "department stitching", "status pending"
  for (const f of dims) {
    if (f.kind !== 'text' || f.key === 'month') continue;
    for (const w of f.words) {
      const m = q.match(new RegExp(` ${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (?:is |= |of |named |called )?(?!by |wise |per )([a-z0-9][a-z0-9\\-]*)`));
      if (m && !['by', 'for', 'in', 'and', 'with', 'last', 'this', 'the', 'each', 'per', 'wise', 'total', 'sum'].includes(m[1]) && !spec.group.includes(f.key) || (m && spec.group.includes(f.key) && /(is|=|named|called)/.test(m[0]))) {
        if (!spec.filters.some((x) => x.field === f.key)) spec.filters.push({ field: f.key, op: 'contains', value: m![1] });
        break;
      }
    }
  }
  const state = [['pending', 'pending'], ['approved', 'approved'], ['cancelled', 'cancelled'], ['rejected', 'rejected'], ['absent', 'A'], ['exited', 'exited'], ['active', 'active']] as const;
  for (const [w, v] of state) if (has(q, w) && ['status', 'run_status'].some((k) => d.fields.some((f) => f.key === k)) && !spec.filters.some((x) => x.field === 'status')) {
    if (d.key === 'attendance' && w !== 'absent') continue;
    if (d.key === 'stock_lots' || d.key === 'qc' && w !== 'rejected') continue;
    spec.filters.push({ field: d.fields.some((f) => f.key === 'status') ? 'status' : 'run_status', op: d.key === 'attendance' ? 'eq' : 'contains', value: v });
    break;
  }
  // ranking
  const top = q.match(/ (?:top|best|highest|biggest|largest) (\d+)? ?/), bottom = q.match(/ (?:bottom|lowest|smallest|least|worst) (\d+)? ?/);
  const m0 = spec.measures[0];
  const mk = m0 ? (m0.field === '*' ? 'count' : `${m0.agg}_${m0.field}`) : null;
  if (mk && (top || bottom) && spec.group.length) { spec.sort = { key: mk, dir: top ? 'desc' : 'asc' }; spec.limit = Number((top ?? bottom)![1] ?? 10); }
  else if (mk && spec.group.length && !spec.group.some((g) => g === d.dateField || g === 'month' || g === 'join_month')) spec.sort = { key: mk, dir: 'desc' };
  if (!spec.group.length && !spec.measures.length) { spec.group = dims.slice(0, 3).map((f) => f.key); spec.limit = 100; }
  const clean = validateSpec(spec);
  clean.title = question.trim().replace(/\s+/g, ' ').slice(0, 80);
  return { spec: clean, explain: describe(clean), source: 'built-in', note: 'Read by the built-in reader. Check the summary below; ask again in other words if it is not what you meant.' };
}

/** Read a request. Uses the provider if there is one, falls back to the built-in reader when it fails. */
export async function interpret(db: Db, userId: string, question: string, provider?: Provider): Promise<Interpretation> {
  const q = question.trim();
  if (q.length < 6) throw badRequest('Describe the report you want, for example: total purchase value by vendor in the last 90 days');
  if (q.length > 400) throw badRequest('Please keep the request under 400 characters');
  const allowed = await availableDatasets(db, userId);
  if (!allowed.length) throw badRequest('Your role has no data to build reports on');
  if (provider) {
    try {
      const j = parseJson(await provider(systemPrompt(catalogue(allowed)), q));
      if (j.error) throw badRequest(String(j.error).slice(0, 200));
      if (!allowed.some((d) => d.key === j.dataset)) throw badRequest('That data is not available to you');
      const spec = validateSpec(j);
      spec.title ??= q.slice(0, 80);
      return { spec, explain: describe(spec), source: 'ai' };
    } catch (e) {
      if ((e as { status?: number }).status === 400) throw e;      // a refusal or a bad spec: say so rather than guess
      const r = builtIn(q, allowed);
      return { ...r, note: 'The AI service could not be reached, so the built-in reader answered. ' + (r.note ?? '') };
    }
  }
  return builtIn(q, allowed);
}
