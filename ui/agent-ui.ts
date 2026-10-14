// The floating assistant: type or talk. It reads aloud when you use the microphone. Changes are never made without a yes.
import { esc } from './lib.js';
import { K, S, uid, read, toast, R } from './ctx.js';
import * as agent from '../src/domain/agent.js';
import * as aim from '../src/domain/ai-models.js';
import type { View } from './ctx.js';

type Msg = { role: 'user' | 'assistant'; text: string; results?: agent.Reply['results']; proposal?: agent.Proposal; status?: 'pending' | 'done' | 'cancelled'; note?: string; model?: string };
const A = { open: false, msgs: [] as Msg[], draft: '', busy: false, listening: false, speak: false, user: '', caps: [] as { name: string; description: string; write: boolean }[], model: '' as string | null, err: '' };
type Rec = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null };
const Ctor = (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition;
let rec: Rec | null = null;
const canSpeak = 'speechSynthesis' in window;

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|go ahead|do it|proceed|approve|please do|that's right|correct)\b/i;
const NO = /^(no|nope|cancel|stop|don't|do not|never ?mind|not now|leave it)\b/i;
const pending = () => [...A.msgs].reverse().find((m) => m.proposal && m.status === 'pending');

function say(text: string, then?: () => void) {
  if (!A.speak || !canSpeak) { then?.(); return; }
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'en-IN'; u.rate = 1.02; u.onend = () => then?.(); u.onerror = () => then?.(); speechSynthesis.speak(u); } catch { then?.(); }
}

function table(r: { head?: string[]; rows?: string[][] }) {
  if (!r.rows?.length) return '';
  return `<div class="ag-scroll"><table class="ag-t">${r.head ? `<thead><tr>${r.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>` : ''}<tbody>${r.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function msgHtml(m: Msg, i: number): string {
  if (m.role === 'user') return `<div class="ag-m me">${esc(m.text)}</div>`;
  const first = m.results?.find((r) => r.view);
  return `<div class="ag-m bot"><div>${esc(m.text)}</div>${(m.results ?? []).map((r) => table(r)).join('')}
    ${m.note ? `<small class="ag-note">${esc(m.note)}</small>` : ''}
    ${m.proposal ? `<div class="ag-prop ${m.status}"><b>${esc(m.proposal.title)}</b><ul>${m.proposal.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
      ${m.status === 'pending' ? `<div class="ag-row"><button class="primary" data-ag="yes" data-i="${i}">Yes, do it</button><button data-ag="no" data-i="${i}">No</button></div><small>You can also say “yes” or “no”.</small>` : `<small>${m.status === 'done' ? 'Done' : 'Cancelled'}</small>`}</div>` : ''}
    ${first ? `<button class="ag-open" data-ag="go" data-vw="${esc(first.view!)}">Open that screen</button>` : ''}</div>`;
}
const iconMic = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const iconSpark = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>';

function suggestions(): string[] {
  const has = (n: string) => A.caps.some((c) => c.name === n);
  return [ 'What is waiting for me?', has('stock') && 'How much FAB-001 do we have?', has('create_lead') && 'Add lead Ramesh from Gupta Knits worth 50 thousand', has('approve_po') && 'Approve PO 1', has('find_party') && 'Show vendors', has('report') && 'Total purchases by vendor last 90 days', 'How do I make a purchase order?', 'Help' ].filter(Boolean) as string[];
}

export function paint() {
  const root = document.getElementById('agent-root'); if (!root) return;
  if (!S.user || S.mustChange) { root.innerHTML = ''; return; }
  const keepScroll = root.querySelector('.ag-log')?.scrollTop;
  const micOk = !!Ctor;
  root.innerHTML = `<button class="ag-fab ${A.open ? 'on' : ''}" data-ag="toggle" aria-label="${A.open ? 'Close assistant' : 'Open assistant'}" aria-expanded="${A.open}">${iconSpark}<span>Assistant</span></button>
  ${A.open ? `<section class="ag-panel" role="dialog" aria-label="Assistant">
    <header><div><b>Assistant</b><small>${A.model ? 'Using ' + esc(A.model) : 'Built-in, no AI model needed'}</small></div>
      <label class="ag-sp" title="Read answers aloud"><input type="checkbox" id="ag-speak" ${A.speak ? 'checked' : ''} ${canSpeak ? '' : 'disabled'}/> Speak</label><button data-ag="clear" class="ghost" aria-label="Start over">Clear</button><button data-ag="toggle" class="ghost" aria-label="Close">✕</button></header>
    <div class="ag-log" aria-live="polite">${A.msgs.length ? A.msgs.map(msgHtml).join('') : `<div class="ag-hello"><p><b>Hi. I can look things up, explain how to do things, and prepare changes for you to confirm.</b></p><p>Try:</p>${suggestions().map((s) => `<button class="ag-chip" data-ag="say" data-t="${esc(s)}">${esc(s)}</button>`).join('')}</div>`}${A.busy ? '<div class="ag-m bot ag-dots" aria-label="Thinking"><i></i><i></i><i></i></div>' : ''}</div>
    ${A.err ? `<p class="ag-err" role="alert">${esc(A.err)}</p>` : ''}
    <form class="ag-in" data-ag-form="1"><button type="button" class="ag-mic ${A.listening ? 'on' : ''}" data-ag="mic" aria-label="${A.listening ? 'Stop listening' : 'Talk to the assistant'}" ${micOk ? '' : 'title="Voice input needs Chrome, Edge or Safari"'}>${iconMic}</button>
      <input id="ag-text" autocomplete="off" placeholder="${A.listening ? 'Listening…' : 'Ask or tell me what to do'}" value="${esc(A.draft)}" aria-label="Message" /><button class="primary" type="submit">Send</button></form></section>` : ''}`;
  const log = root.querySelector('.ag-log') as HTMLElement | null; if (log) log.scrollTop = A.busy || keepScroll === undefined ? log.scrollHeight : Math.max(keepScroll, 0);
  if (log && A.msgs.length) log.scrollTop = log.scrollHeight;
  if (A.open && document.activeElement === document.body) (document.getElementById('ag-text') as HTMLInputElement | null)?.focus();
}

async function refreshCaps() {
  A.caps = await read((db) => agent.capabilities(db, uid()));
  A.model = await read((db) => aim.modelInUse(db, 'assistant'));
}
export async function sync() {
  if (A.user !== S.user) { A.user = S.user; A.msgs = []; A.draft = ''; A.err = ''; if (S.user) await refreshCaps().catch(() => {}); }
  paint();
}

async function confirmProposal(m: Msg, viaVoice = false) {
  if (!m.proposal || m.status !== 'pending') return;
  m.status = 'done'; A.busy = true; paint();
  try {
    const msg = await K.world.as(S.user, (c) => agent.executeProposal(c, m.proposal!));
    A.msgs.push({ role: 'assistant', text: msg }); toast(msg); say(msg);
  } catch (e) { const err = e as { message?: string; code?: string }; m.status = 'cancelled'; A.msgs.push({ role: 'assistant', text: `I could not do that: ${err.message ?? 'refused'}` }); toast(err.message ?? 'Refused', 'bad', err.code); say(`I could not do that. ${err.message ?? ''}`); }
  A.busy = false; paint(); await R.render(); void viaVoice;
}

export async function send(text: string, viaVoice = false) {
  const t = text.trim(); if (!t || A.busy) return;
  A.err = ''; A.draft = ''; A.msgs.push({ role: 'user', text: t });
  const p = pending();
  if (p) {
    if (YES.test(t)) { paint(); return confirmProposal(p, viaVoice); }
    if (NO.test(t)) { p.status = 'cancelled'; const m = 'Okay, I will not do it.'; A.msgs.push({ role: 'assistant', text: m }); paint(); say(m); return; }
    p.status = 'cancelled'; // asking something else drops the old proposal
  }
  A.busy = true; paint();
  try {
    const hist = A.msgs.filter((m) => m.text).slice(-8, -1).map((m) => ({ role: m.role, text: m.text }));
    const r = await read((db) => agent.chat(db, uid(), t, hist));
    A.model = r.source === 'ai' ? r.model ?? null : A.model;
    A.msgs.push({ role: 'assistant', text: r.text, results: r.results, proposal: r.proposal, status: r.proposal ? 'pending' : undefined, note: r.note, model: r.model });
    const spoken = r.proposal ? `${r.proposal.title}. ${r.proposal.details.slice(0, 2).join('. ')}. Shall I go ahead? Say yes or no.` : r.text;
    A.busy = false; paint();
    say(spoken, () => { if (viaVoice && r.proposal) listen(); });
    const nav = r.results.find((x) => x.view && ['open_screen'].includes(x.tool)); if (nav) go(nav.view!);
  } catch (e) { A.busy = false; A.err = (e as Error).message; paint(); }
}
function go(view: string) { S.view = view as View; history.replaceState(null, '', '#' + view); void R.render(); }

function listen() {
  if (!Ctor) { A.err = 'Voice input needs Chrome, Edge or Safari.'; paint(); return; }
  if (A.listening) { rec?.stop(); return; }
  try { speechSynthesis?.cancel(); } catch { /* optional */ }
  rec = new Ctor(); rec.lang = 'en-IN'; rec.interimResults = true; rec.continuous = false; A.err = '';
  let finalText = '';
  rec.onresult = (e) => { let s = ''; for (let i = 0; i < e.results.length; i++) { s += e.results[i][0].transcript; if (e.results[i].isFinal) finalText = s; } A.draft = s; const el = document.getElementById('ag-text') as HTMLInputElement | null; if (el) el.value = s; };
  rec.onerror = (e) => { A.listening = false; A.err = e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'The microphone is blocked here. Allow it for this site, or open the app from its own web address (not inside another page).' : e.error === 'no-speech' ? 'I did not hear anything. Try again.' : `Voice problem: ${e.error}`; paint(); };
  rec.onend = () => { A.listening = false; paint(); if (finalText.trim()) { A.speak = true; void send(finalText, true); } };
  try { rec.start(); A.listening = true; A.speak = true; paint(); } catch { A.listening = false; A.err = 'Could not start the microphone.'; paint(); }
}

document.addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest('[data-ag]') as HTMLElement | null; if (!b) return;
  const a = b.dataset.ag!;
  if (a === 'toggle') { A.open = !A.open; if (A.open) void refreshCaps().then(paint); else { try { rec?.stop(); speechSynthesis?.cancel(); } catch { /* */ } } paint(); }
  else if (a === 'clear') { A.msgs = []; A.err = ''; try { speechSynthesis?.cancel(); } catch { /* */ } paint(); }
  else if (a === 'say') void send(b.dataset.t ?? '');
  else if (a === 'mic') listen();
  else if (a === 'yes') { const m = A.msgs[Number(b.dataset.i)]; if (m) void confirmProposal(m); }
  else if (a === 'no') { const m = A.msgs[Number(b.dataset.i)]; if (m?.status === 'pending') { m.status = 'cancelled'; A.msgs.push({ role: 'assistant', text: 'Okay, I will not do it.' }); paint(); } }
  else if (a === 'go') go(b.dataset.vw!);
});
document.addEventListener('submit', (ev) => { const f = (ev.target as HTMLElement).closest('[data-ag-form]'); if (!f) return; ev.preventDefault(); ev.stopPropagation(); void send((document.getElementById('ag-text') as HTMLInputElement).value); }, true);
document.addEventListener('input', (ev) => { const t = ev.target as HTMLInputElement; if (t.id === 'ag-text') A.draft = t.value; }, true);
document.addEventListener('change', (ev) => { const t = ev.target as HTMLInputElement; if (t.id === 'ag-speak') { A.speak = t.checked; if (!A.speak) try { speechSynthesis?.cancel(); } catch { /* */ } } }, true);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && A.open) { A.open = false; paint(); } });
