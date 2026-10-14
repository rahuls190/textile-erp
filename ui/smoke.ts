import { LitePool } from './lite-pool.js';
import { buildWorld } from '../src/seed/demo.js';
import * as po from '../src/domain/po.js';
import * as rcv from '../src/domain/receipt.js';
import * as qc from '../src/domain/qc.js';
import * as inv from '../src/domain/inventory.js';
import * as q from '../src/domain/queries.js';

const t0 = Date.now();
const pool = await LitePool.create();
const w = await buildWorld(pool as any);
console.log('world built in', Date.now() - t0, 'ms');
const p = await w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '500' }] }));
const s = await w.as('buy', (c) => po.submitPO(c, { poId: p.id, expectedVersion: p.version }));
const a = await w.as('com', (c) => po.approvePO(c, { poId: p.id, expectedVersion: s.version }));
await w.as('com', (c) => po.releasePO(c, { poId: p.id, expectedVersion: a.version }));
const line = (await pool.query('SELECT id FROM po_line WHERE po_id=$1', [p.id])).rows[0];
const rec = await w.as('sto', (c) => rcv.postReceipt(c, { siteId: w.siteId, partnerId: w.vendorId, poId: p.id, challanNo: 'X1', lines: [{ poLineId: line.id, itemId: w.items.fabric, qty: '500' }] }));
const insp = rec.lines[0].inspectionId;
await w.as('qci', (c) => qc.startInspection(c, { inspectionId: insp }));
await w.as('qci', (c) => qc.submitInspection(c, { inspectionId: insp, expectedVersion: 2, inspectedQty: '20', recommendAccept: '480', recommendReject: '20' }));
await w.as('qcm', (c) => qc.dispositionInspection(c, { inspectionId: insp, expectedVersion: 3, acceptQty: '480', rejectQty: '20' }));
await w.as('sto', (c) => inv.reserveStock(c, { lotId: rec.lines[0].lotId, qty: '120', demandType: 'cut_order', demandRef: 'CUT-1' }));
const cl = await pool.connect();
console.log((await q.stockSummary(cl as any, w.actors.sto.id)).map((x: any) => [x.label, x.held, x.accepted, x.rejected, x.reserved, x.available]));
cl.release();
try { await w.as('sto', (c) => inv.reserveStock(c, { lotId: rec.lines[0].lotId, qty: '400', demandType: 'x', demandRef: 'y' })); } catch (e: any) { console.log('expected refusal:', e.code, e.message); }
try { await pool.query(`UPDATE stock_ledger SET qty=1`); } catch (e: any) { console.log('ledger immutable:', e.message.slice(0, 60)); }
console.log('total ms', Date.now() - t0);
