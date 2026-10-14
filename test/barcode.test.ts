import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld, rejects } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as bc from '../src/domain/barcode.js';
import * as inv from '../src/domain/inventory.js';
import { seedOwnerRecent } from '../src/seed/owner-demo.js';

let w: World;
beforeAll(async () => { w = await freshWorld('barcode'); await seedOwnerRecent(w); });
afterAll(async () => { await w.pool.end(); });

const lots = async () => (await bc.labelData(w.pool, w.actors.sto.id)).lots;
const where = async (code: string) => { const r = await bc.resolveScan(w.pool, w.actors.sto.id, code); return r.type === 'lot' ? r.where : []; };

describe('barcodes', () => {
  it('gives every lot a printable label and every location a prefixed code', async () => {
    const d = await bc.labelData(w.pool, w.actors.sto.id);
    expect(d.lots.length).toBeGreaterThan(1);
    expect(d.lots.every((l) => l.printable)).toBe(true);
    expect(d.locations.find((l) => l.code === 'RCV')!.barcode).toBe('L:RCV');
    expect(bc.printable('Rolls ₹')).toBe(false);
  });

  it('reads a roll and a location, and treats unknown codes as not found', async () => {
    const lot = (await lots()).find((l) => Number(l.qty) > 0)!;
    const r = await bc.resolveScan(w.pool, w.actors.sto.id, lot.label);
    expect(r.type).toBe('lot');
    const l = await bc.resolveScan(w.pool, w.actors.sto.id, 'L:RCV');
    expect(l.type).toBe('location');
    await rejects(bc.resolveScan(w.pool, w.actors.sto.id, 'NOPE-123'), 'NOT_FOUND');
    await rejects(bc.resolveScan(w.pool, w.actors.sto.id, '  '), 'BAD_REQUEST');
    await rejects(bc.resolveScan(w.pool, w.actors.hrm.id, lot.label), 'NOT_FOUND');      // no stock rights: indistinguishable from unknown
  });

  it('moves released stock forward, and only forward', async () => {
    // a roll that quality has released and that sits in receiving
    const target = (await lots()).find(async () => true)!;
    let lotCode = '';
    for (const l of await lots()) { const wh = await where(l.label); if (wh.some((x) => x.status === 'ACCEPTED' && x.kind === 'RECEIVING' && Number(x.qty) > 0)) { lotCode = l.label; break; } }
    expect(lotCode, 'a released roll in receiving exists').not.toBe('');
    void target;
    const before = (await where(lotCode)).find((x) => x.status === 'ACCEPTED' && x.kind === 'RECEIVING')!;
    const part = '100';
    const r = await w.as('sto', (c) => bc.moveForward(c, { lotCode, toLocationCode: 'L:STORE-A', qty: part }));
    expect(r.moved[0].qty).toBe('100');
    const mid = await where(lotCode);
    expect(Number(mid.find((x) => x.code === 'STORE-A')!.qty)).toBe(100);
    expect(Number(mid.find((x) => x.code === 'RCV' && x.status === 'ACCEPTED')!.qty)).toBe(Number(before.qty) - 100);
    // rest goes straight to the rack in one scan (pulls from receiving and store)
    await w.as('sto', (c) => bc.moveForward(c, { lotCode, toLocationCode: 'RACK-A1' }));
    const end = await where(lotCode);
    expect(end.filter((x) => x.status === 'ACCEPTED').every((x) => x.code === 'RACK-A1')).toBe(true);
    // backwards or sideways is refused
    await rejects(w.as('sto', (c) => bc.moveForward(c, { lotCode, toLocationCode: 'STORE-A' })), 'NOT_FORWARD');
    await rejects(w.as('sto', (c) => bc.moveForward(c, { lotCode, toLocationCode: 'RACK-A1' })), 'NOT_FORWARD');
    await rejects(w.as('sto', (c) => bc.moveForward(c, { lotCode, toLocationCode: 'TRN' })), 'NOT_ON_ROUTE');
    await rejects(w.as('sto', (c) => bc.moveForward(c, { lotCode, toLocationCode: 'NOWHERE' })), 'NOT_FOUND');
  });

  it('never moves held stock, and respects who may move stock', async () => {
    let held = '';
    for (const l of await lots()) { const wh = await where(l.label); if (wh.some((x) => x.status === 'HOLD') && !wh.some((x) => x.status === 'ACCEPTED' && Number(x.qty) > 0)) { held = l.label; break; } }
    expect(held).not.toBe('');
    await rejects(w.as('sto', (c) => bc.moveForward(c, { lotCode: held, toLocationCode: 'STORE-A' })), 'NOT_RELEASED');
    let ok = '';
    for (const l of await lots()) { const wh = await where(l.label); if (wh.some((x) => x.status === 'ACCEPTED' && x.kind === 'RECEIVING' && Number(x.qty) > 0)) { ok = l.label; break; } }
    if (ok) await rejects(w.as('aud', (c) => bc.moveForward(c, { lotCode: ok, toLocationCode: 'STORE-A' })), 'FORBIDDEN');
    const a = (await w.pool.query(`SELECT count(*)::int n FROM audit_log WHERE action='barcode.move_forward'`)).rows[0].n;
    expect(a).toBeGreaterThan(0);
    void inv;
  });
});
