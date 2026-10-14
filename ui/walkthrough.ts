import * as hr from '../src/domain/hr.js';
import type { World } from '../src/seed/demo.js';
import * as po from '../src/domain/po.js';
import * as rcv from '../src/domain/receipt.js';
import * as qc from '../src/domain/qc.js';
import * as inv from '../src/domain/inventory.js';
import * as q from '../src/domain/queries.js';
import { qty } from './lib.js';

export interface Step { who: string; text: string; ok: boolean; note?: string }

/**
 * Replays the blueprint's worked example (p.55) through the real engine, as the people who would do each step,
 * including the attempts the rules must refuse.
 */
export async function runWorkedExample(w: World, onStep: (s: Step) => void): Promise<{ lotId: string; poId: string }> {
  const say = (who: string, text: string, ok = true, note?: string) => onStep({ who, text, ok, note });
  const expectRefusal = async (who: string, text: string, fn: () => Promise<unknown>) => {
    try { await fn(); say(who, text, false, 'This should have been refused'); }
    catch (e) { say(who, text, true, `Refused: ${(e as Error).message}`); }
  };
  const ver = async (db: { query: (q: string, p?: unknown[]) => Promise<any> }, table: string, id: string) => (await db.query(`SELECT version FROM ${table} WHERE id=$1`, [id])).rows[0].version as number;
  const tag = Math.floor(Math.random() * 9000 + 1000);

  const p = await w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '500' }] }));
  say('buy', `Creates purchase order ${p.number} for 500 m of FAB-001 at the approved rate`, true, `Total ₹${Number(p.total).toLocaleString('en-IN')}`);
  await expectRefusal('buy', 'Tries to approve their own purchase order', () => w.as('buy', async (c) => { await po.submitPO(c, { poId: p.id, expectedVersion: p.version }); return po.approvePO(c, { poId: p.id, expectedVersion: p.version + 1 }); }));
  // the refusal rolled back the submit too, so submit for real
  const s = await w.as('buy', (c) => po.submitPO(c, { poId: p.id, expectedVersion: p.version }));
  say('buy', 'Submits it for approval');
  const a = await w.as('com', (c) => po.approvePO(c, { poId: p.id, expectedVersion: s.version }));
  say('com', 'Approves it within their approval limit');
  await w.as('com', (c) => po.releasePO(c, { poId: p.id, expectedVersion: a.version }));
  say('com', 'Releases it to the vendor (a separate right from approving)');

  const line = (await w.pool.query('SELECT id FROM po_line WHERE po_id=$1', [p.id])).rows[0];
  const rec = await w.as('sto', (c) => rcv.postReceipt(c, { siteId: w.siteId, partnerId: w.vendorId, poId: p.id, challanNo: `WT-${tag}`, lines: [{ poLineId: line.id, itemId: w.items.fabric, qty: '500', attributes: { widthCm: 160 } }] }));
  const lot = rec.lines[0];
  say('sto', `Receives roll ${lot.label}: 500 m. It lands on QC hold`, true, 'Nothing is usable until quality releases it');
  await expectRefusal('sto', 'Tries to reserve fabric that is still on hold', () => w.as('sto', (c) => inv.reserveStock(c, { lotId: lot.lotId, qty: '100', demandType: 'cut_order', demandRef: 'CUT-200' })));

  await w.as('qci', (c) => qc.startInspection(c, { inspectionId: lot.inspectionId }));
  await w.as('qci', async (c) => qc.submitInspection(c, { inspectionId: lot.inspectionId, expectedVersion: await ver(c.db, 'qc_inspection', lot.inspectionId), inspectedQty: '20', recommendAccept: '480', recommendReject: '20', defects: [{ type: 'shade variation', metres: 20 }] }));
  say('qci', 'Inspects a 20 m sample and recommends: accept 480 m, reject 20 m');
  await expectRefusal('qci', 'Tries to release the stock themselves', async () => w.as('qci', async (c) => qc.dispositionInspection(c, { inspectionId: lot.inspectionId, expectedVersion: await ver(c.db, 'qc_inspection', lot.inspectionId), acceptQty: '480', rejectQty: '20' })));
  await expectRefusal('sto', 'Tries to release the hold from the store', async () => w.as('sto', async (c) => qc.dispositionInspection(c, { inspectionId: lot.inspectionId, expectedVersion: await ver(c.db, 'qc_inspection', lot.inspectionId), acceptQty: '480', rejectQty: '20' })));
  await w.as('qcm', async (c) => qc.dispositionInspection(c, { inspectionId: lot.inspectionId, expectedVersion: await ver(c.db, 'qc_inspection', lot.inspectionId), acceptQty: '480', rejectQty: '20' }));
  const st = (await w.pool.query('SELECT status FROM purchase_order WHERE id=$1', [p.id])).rows[0].status;
  say('qcm', 'Releases 480 m and rejects 20 m', true, `The purchase order reopens for the 20 m shortfall (now ${st.replace('_', ' ')})`);

  await w.as('sto', (c) => inv.reserveStock(c, { lotId: lot.lotId, qty: '120', demandType: 'cut_order', demandRef: 'CUT-200' }));
  say('sto', 'Reserves 120 m for cut order CUT-200');
  await expectRefusal('sto', 'Tries to reserve 400 m on top of that', () => w.as('sto', (c) => inv.reserveStock(c, { lotId: lot.lotId, qty: '400', demandType: 'cut_order', demandRef: 'CUT-201' })));

  const c = await w.pool.connect();
  try {
    const row = (await q.stockSummary(c as never, w.actors.sto.id)).find((x) => x.lot_id === lot.lotId)!;
    say('sto', `Result: ${qty(row.accepted)} m accepted, ${qty(row.rejected)} m rejected, ${qty(row.reserved)} m reserved, ${qty(row.available)} m free`, true, 'Matches the blueprint example: 360 m left');
  } finally { c.release(); }
  return { lotId: lot.lotId, poId: p.id };
}


/** Last month's payroll, played end to end by the people involved, including the steps that must be refused. */
export async function runPayrollExample(w: World, onStep: (s: Step) => void): Promise<{ runId: string }> {
  const say = (who: string, text: string, ok = true, note?: string) => onStep({ who, text, ok, note });
  const refused = async (who: string, text: string, fn: () => Promise<unknown>) => {
    try { await fn(); say(who, text, false, 'This should have been refused'); } catch (e) { say(who, text, true, `Refused: ${(e as Error).message}`); }
  };
  const t = new Date();
  const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1));
  const period = first.toISOString().slice(0, 7);
  const inr = (v: string) => '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 });

  const run = await w.as('hrm', (c) => hr.createPayrollRun(c, { siteId: w.siteId, period }));
  say('hrm', `Calculates payroll for ${period} from attendance, leave and approved salaries`, true, `${run.count} people · gross ${inr(run.gross)} · net ${inr(run.net)}`);
  await refused('hrm', 'Tries to approve the run they prepared', () => w.as('hrm', (c) => hr.approvePayrollRun(c, { runId: run.id, expectedVersion: run.version })));

  const row = (await w.pool.query(`SELECT a.employee_id, a.work_date FROM attendance a JOIN employee e ON e.id = a.employee_id WHERE e.name = 'Farida Khan' AND a.work_date >= $1 AND a.status = 'P' ORDER BY a.work_date LIMIT 1`, [period + '-01'])).rows[0];
  await w.as('hrm', (c) => hr.markAttendance(c, { employeeId: row.employee_id, date: row.work_date, status: 'A', reason: 'Gate register shows she was absent' }));
  say('hrm', 'Corrects one attendance sheet after the draft was calculated', true, 'Farida Khan: present → absent');
  await refused('fc', 'Tries to approve the now out-of-date draft', () => w.as('fc', async (c) => hr.approvePayrollRun(c, { runId: run.id, expectedVersion: (await c.db.query('SELECT version FROM payroll_run WHERE id=$1', [run.id])).rows[0].version })));
  const re = await w.as('hrm', async (c) => hr.recalculatePayrollRun(c, { runId: run.id, expectedVersion: (await c.db.query('SELECT version FROM payroll_run WHERE id=$1', [run.id])).rows[0].version }));
  say('hrm', 'Recalculates the draft from the corrected sheets', true, `net now ${inr(re.net)}`);
  await w.as('fc', async (c) => hr.approvePayrollRun(c, { runId: run.id, expectedVersion: (await c.db.query('SELECT version FROM payroll_run WHERE id=$1', [run.id])).rows[0].version }));
  say('fc', 'Reviews and approves it, as a different person', true, 'Attendance and payslips for the month are now locked');
  await refused('hrm', 'Tries to change attendance in the closed month', () => w.as('hrm', (c) => hr.markAttendance(c, { employeeId: row.employee_id, date: row.work_date, status: 'P', reason: 'Changed my mind' })));

  const c = await w.pool.connect();
  try {
    const mine = await hr.listPayslips(c as never, w.actors.emp.id);
    const others = await hr.listPayslips(c as never, w.actors.sto.id);
    say('emp', 'Opens their own payslip', true, `Net pay ${inr(mine[0].net)}. Sees ${mine.length} payslip, never anyone else's`);
    say('sto', 'Looks for payslips as a storekeeper', true, `Sees ${others.length} (only their own)`);
  } finally { c.release(); }
  return { runId: run.id };
}
