// Shared state and helpers for every screen.
import type { LitePool } from './lite-pool.js';
import type { World } from '../src/seed/demo.js';
import type { Ctx } from '../src/core/command.js';
import type { Step } from './walkthrough.js';
import { html, esc, raw, type Raw } from './lib.js';

export type Db = import('../src/db/pool.js').Db;
export const DEMO_PASSWORD = 'Demo-Passw0rd!';

export type View =
  | 'overview' | 'po' | 'receiving' | 'quality' | 'stock'
  | 'employees' | 'attendance' | 'leave' | 'payroll'
  | 'users' | 'roles' | 'audit' | 'signins' | 'account' | 'owner' | 'escalations' | 'reports' | 'barcodes' | 'crm' | 'quotes' | 'sales' | 'materials' | 'mtypes' | 'vendors' | 'clients' | 'aimodels' | 'products';

export const K = { world: null as unknown as World, pool: null as unknown as LitePool };
export const R = { render: async () => {}, scheduleRender: () => {} };

export const S = {
  user: '', token: '', mustChange: false, view: 'overview' as View,
  poId: '', inspId: '', lotId: '', open: new Set<string>(), log: [] as Step[], running: false, filter: '',
  // people
  payLog: [] as Step[], empId: '', attDate: '', attEmp: '', leaveScope: 'mine' as 'mine' | 'team' | 'all', runId: '', slipId: '', payTab: 'runs' as 'runs' | 'salary' | 'mine', empAll: false,
  // admin
  userSel: '', roleSel: '', roleDraft: null as null | Set<string>,
  // owner desk: the demo clock can be moved forward to watch escalations climb the ladder
  skewHours: 0, ovr: '' as string, escFor: '' as string,
  // reports
  rep: '' as string, repP: {} as Record<string, string>,
};

export const $ = (s: string) => document.querySelector(s) as HTMLElement;
export const uid = () => K.world.actors[S.user].id;
export async function read<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const c = await K.pool.connect();
  try { return await fn(c as never); } finally { c.release(); }
}
export const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';
export const checked = (id: string) => !!(document.getElementById(id) as HTMLInputElement | null)?.checked;

export function toast(msg: string, kind: 'ok' | 'bad' = 'ok', detail?: string) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<strong>${kind === 'ok' ? 'Done' : 'Blocked'}</strong><span>${esc(msg)}</span>${detail ? `<small>${esc(detail)}</small>` : ''}`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'ok' ? 3200 : 7000);
}
/** Run one business command as the signed-in person; refusals from the rules engine show as toasts. */
export async function act<T = unknown>(label: string, fn: (c: Ctx) => Promise<T>): Promise<T | undefined> {
  try { const r = await K.world.as(S.user, fn); toast(label); await R.render(); return r; }
  catch (e) { const err = e as { code?: string; message?: string }; toast(err.message ?? 'Failed', 'bad', err.code); return undefined; }
}

export const head = (title: string, sub: string, right?: Raw) => html`<div class="head"><div><h1>${title}</h1><p>${sub}</p></div>${right ?? ''}</div>`;
export const kv = (k: string, v: unknown) => html`<div class="kv"><span>${k}</span><b>${v}</b></div>`;
export const denied = (title: string, sub: string, why: string) => html`${head(title, sub)}<div class="card"><p class="empty">${why}</p></div>`;
export const opts = (rows: { id: string; label: string }[], sel = '', blank?: string) =>
  html`${blank ? html`<option value="">${blank}</option>` : ''}${rows.map((r) => html`<option value="${r.id}" ${r.id === sel ? raw('selected') : ''}>${r.label}</option>`)}`;

export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const todayIso = () => iso(new Date());
export const addDays = (s: string, n: number) => iso(new Date(+new Date(s + 'T00:00:00Z') + n * 86400000));
export const prevMonth = () => { const t = todayIso(); return iso(new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 2, 1))).slice(0, 7); };
export const monthLabel = (p: string) => new Date(p.slice(0, 7) + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

export const PEOPLE: Record<string, { name: string; role: string }> = {
  buy: { name: 'Asha Rao', role: 'Buyer' },
  com: { name: 'Vikram Shah', role: 'Commercial approver · limit ₹5,00,000' },
  sto: { name: 'Imran Qureshi', role: 'Storekeeper' },
  qci: { name: 'Meera Nair', role: 'Quality inspector' },
  qcm: { name: 'Dr. Suresh Pillai', role: 'Quality manager' },
  inv: { name: 'Lakshmi Iyer', role: 'Inventory controller · limit 1,000 m' },
  md: { name: 'Rahul Sharma', role: 'Master-data steward' },
  eng: { name: 'Deepak Menon', role: 'Engineer / technical approver' },
  fc: { name: 'Anita Desai', role: 'Finance controller' },
  aud: { name: 'Karan Mehta', role: 'Auditor (read-only)' },
  hrm: { name: 'Neha Kapoor', role: 'HR manager' },
  hre: { name: 'Rohan Das', role: 'HR executive' },
  sup: { name: 'Ganesh Patil', role: 'Line supervisor' },
  emp: { name: 'Sunita Kamble', role: 'Machine operator (no system role)' },
  sal: { name: 'Priya Menon', role: 'Sales executive' },
  slm: { name: 'Rohit Verma', role: 'Sales manager · limit ₹10,00,000' },
  own: { name: 'Business owner', role: 'Owner · sees everything, can override approvals' },
  admin: { name: 'System admin', role: 'Administrator (no business approvals)' },
};
export const ORDER = ['own', 'slm', 'sal', 'admin', 'hrm', 'hre', 'sup', 'emp', 'buy', 'com', 'sto', 'qci', 'qcm', 'inv', 'md', 'eng', 'fc', 'aud'];

/** The demo clock: real time plus any hours the owner has fast-forwarded. */
export const demoNow = () => new Date(Date.now() + S.skewHours * 3600000);
export const hoursText = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 24 ? `${Math.round(h)} h` : `${Math.floor(h / 24)} d ${Math.round(h % 24)} h`);
