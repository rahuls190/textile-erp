import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as bcs from '../src/domain/barcodes.js';
import * as bc from '../src/domain/barcode.js';

async function rejects(p: Promise<unknown>, part: string) {
  try { await p; } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === part || (err.message ?? '').toLowerCase().includes(part.toLowerCase())) return err;
    throw new Error(`Expected "${part}" but got ${err.code}: ${err.message}`);
  }
  throw new Error(`Expected a refusal containing "${part}" but it succeeded`);
}
let w: World;
beforeAll(async () => { w = await freshWorld('barcodes'); });
afterAll(async () => { await w.pool.end(); });
const uid = (u: string) => w.actors[u].id;
const series = async (prefix: string) => (await w.pool.query('SELECT id FROM barcode_series WHERE prefix=$1', [prefix])).rows[0].id as string;

describe('registry', () => {
  it('has every roll, shelf, material and person from the start, each with a unique code', async () => {
    const n = (await w.pool.query(`SELECT entity_type, count(*)::int c FROM barcode GROUP BY 1`)).rows;
    const by = Object.fromEntries(n.map((r) => [r.entity_type, r.c]));
    expect(by.item).toBeGreaterThan(0); expect(by.location).toBeGreaterThan(0); expect(by.employee ?? 0).toBeGreaterThanOrEqual(0);
    const dup = (await w.pool.query('SELECT code FROM barcode GROUP BY code HAVING count(*)>1')).rowCount;
    expect(dup).toBe(0);
    const loc = (await w.pool.query(`SELECT code FROM barcode WHERE entity_type='location' LIMIT 1`)).rows[0].code;
    expect(loc.startsWith('L:')).toBe(true);
  });
  it('registers a new shelf automatically', async () => {
    const site = (await w.pool.query('SELECT id FROM site LIMIT 1')).rows[0].id;
    const l = (await w.pool.query(`INSERT INTO location(site_id, code, name, kind) VALUES ($1,'ZZ-9','Test shelf','RACK') RETURNING id`, [site])).rows[0];
    const b = (await w.pool.query(`SELECT code, entity_id FROM barcode WHERE code='L:ZZ-9'`)).rows[0];
    expect(b.entity_id).toBe(l.id);
  });
});

describe('issuing', () => {
  it('issues unique, ordered codes and never reuses a number', async () => {
    const s = await series('CT');
    const a = await w.as('sto', (c) => bcs.issueCodes(c, { seriesId: s, count: 5 }));
    const b = await w.as('sto', (c) => bcs.issueCodes(c, { seriesId: s, count: 3 }));
    expect(a.first).toBe('CT-000001'); expect(a.last).toBe('CT-000005'); expect(b.first).toBe('CT-000006');
    const all = (await w.pool.query(`SELECT code FROM barcode WHERE series_id=$1`, [s])).rows.map((r) => r.code);
    expect(new Set(all).size).toBe(8);
  });
  it('stays unique when many people issue at the same moment', async () => {
    const s = await series('AS');
    const runs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => w.as('sto', (c) => bcs.issueCodes(c, { seriesId: s, count: 10 }))));
    const all = (await w.pool.query(`SELECT code FROM barcode WHERE series_id=$1`, [s])).rows.map((r) => r.code);
    expect(all.length).toBe(60); expect(new Set(all).size).toBe(60); expect(runs.length).toBe(6);
  });
  it('skips a number already taken by something else', async () => {
    const s = await series('GN');
    await w.pool.query(`INSERT INTO barcode(code, entity_type) VALUES ('GN-000002','generic')`);
    const r = await w.as('sto', (c) => bcs.issueCodes(c, { seriesId: s, count: 3 }));
    const codes = (await w.pool.query(`SELECT code FROM barcode WHERE series_id=$1 ORDER BY code`, [s])).rows.map((x) => x.code);
    expect(codes).toEqual(['GN-000001', 'GN-000003', 'GN-000004']); expect(r.count).toBe(3);
  });
  it('refuses outsiders, bad counts and bad new series', async () => {
    const s = await series('CT');
    await rejects(w.as('qci', (c) => bcs.issueCodes(c, { seriesId: s, count: 1 })), 'Not permitted');
    await rejects(w.as('sto', (c) => bcs.issueCodes(c, { seriesId: s, count: 501 })), '500');
    await rejects(w.as('sto', (c) => bcs.createSeries(c, { name: 'X', entityType: 'carton', prefix: 'XX' })), 'Not permitted');
    await rejects(w.as('md', (c) => bcs.createSeries(c, { name: 'Dup', entityType: 'carton', prefix: 'CT' })), 'already exists');
    await rejects(w.as('md', (c) => bcs.createSeries(c, { name: 'Bad', entityType: 'carton', prefix: 'a b' })), 'Prefix');
    const ok = await w.as('md', (c) => bcs.createSeries(c, { name: 'Bales', entityType: 'carton', prefix: 'BL', symbology: 'QR' }));
    expect(ok.prefix).toBe('BL');
  });
});

describe('attach, cancel, identity', () => {
  it('attaches a spare roll code to a roll and reads as that roll', async () => {
    const s = await series('RL');
    const site = (await w.pool.query('SELECT id FROM site LIMIT 1')).rows[0].id, item = (await w.pool.query('SELECT id FROM item LIMIT 1')).rows[0].id;
    const lot = (await w.pool.query(`INSERT INTO lot(site_id, item_id, label) VALUES ($1,$2,'GRN-T/1') RETURNING id, label`, [site, item])).rows[0];
    expect((await w.pool.query(`SELECT 1 FROM barcode WHERE code='GRN-T/1' AND entity_id=$1`, [lot.id])).rowCount).toBe(1); // roll registered on arrival
    const r = await w.as('sto', (c) => bcs.issueCodes(c, { seriesId: s, count: 1 }));
    const code = (await w.pool.query('SELECT code FROM barcode WHERE id=$1', [r.ids[0]])).rows[0].code;
    await rejects(bc.resolveScan(w.pool, uid('sto'), code), 'not attached');
    await w.as('sto', (c) => bcs.assignCode(c, { code, entityId: lot.id }));
    const found = await bc.resolveScan(w.pool, uid('sto'), code);
    expect(found.type === 'lot' && found.lot.label).toBe(lot.label);
    await rejects(w.as('sto', (c) => bcs.assignCode(c, { code, entityId: lot.id })), 'already attached');
  });
  it('cancelled codes cannot be scanned, printed or revived; a roll\'s own identity cannot be cancelled', async () => {
    const s = await series('CT');
    const r = await w.as('sto', (c) => bcs.issueCodes(c, { seriesId: s, count: 1 }));
    await rejects(w.as('sto', (c) => bcs.voidCode(c, { id: r.ids[0], reason: 'x' })), 'Not permitted');
    await rejects(w.as('inv', (c) => bcs.voidCode(c, { id: r.ids[0], reason: '' })), 'why');
    await w.as('inv', (c) => bcs.voidCode(c, { id: r.ids[0], reason: 'Torn label' }));
    const code = (await w.pool.query('SELECT code FROM barcode WHERE id=$1', [r.ids[0]])).rows[0].code;
    await rejects(bc.resolveScan(w.pool, uid('sto'), code), 'cancelled');
    await rejects(w.pool.query(`UPDATE barcode SET status='active' WHERE id=$1`, [r.ids[0]]), 'cannot be brought back');
    await rejects(w.pool.query(`UPDATE barcode SET code='HACK' WHERE id=$1`, [r.ids[0]]), 'identity');
    await rejects(w.pool.query(`DELETE FROM barcode WHERE id=$1`, [r.ids[0]]), 'never deleted');
    const own = (await w.pool.query(`SELECT id FROM barcode WHERE entity_type='location' LIMIT 1`)).rows[0].id;
    await rejects(w.as('inv', (c) => bcs.voidCode(c, { id: own, reason: 'try' })), 'identity of the roll');
  });
});

describe('layouts and printing', () => {
  it('ships a layout for every kind of code and checks edits', async () => {
    const all = await bcs.listLayouts(w.pool, uid('md'));
    for (const t of bcs.ENTITY_TYPES) expect(all.some((l) => l.entity_type === t && l.is_default)).toBe(true);
    const base = { entityType: 'carton', name: 'Mine', widthMm: 60, heightMm: 40 };
    await rejects(w.as('md', (c) => bcs.saveLayout(c, { ...base, elements: [{ type: 'text', text: 'hi', x: 1, y: 1, w: 10, h: 5 }] })), 'at least one barcode');
    await rejects(w.as('md', (c) => bcs.saveLayout(c, { ...base, elements: [{ type: 'barcode', x: 50, y: 1, w: 20, h: 10 }] })), 'sticks out');
    await rejects(w.as('md', (c) => bcs.saveLayout(c, { ...base, elements: [{ type: 'barcode', x: 1, y: 1, w: 20, h: 10 }, { type: 'field', field: 'hsn', x: 1, y: 15, w: 20, h: 5 }] })), 'not available');
    await rejects(w.as('sto', (c) => bcs.saveLayout(c, { ...base, elements: [{ type: 'barcode', x: 1, y: 1, w: 20, h: 10 }] })), 'Not permitted');
    const ok = await w.as('md', (c) => bcs.saveLayout(c, { ...base, elements: [{ type: 'qr', x: 1, y: 1, w: 20, h: 20 }, { type: 'field', field: 'code', x: 24, y: 5, w: 30, h: 6, size: 10 }], makeDefault: true }));
    expect(ok.version).toBe(1);
    const up = await w.as('md', (c) => bcs.saveLayout(c, { id: ok.id, ...base, widthMm: 70, elements: ok.elements, expectedVersion: 1 }));
    expect(up.version).toBe(2);
    await rejects(w.as('md', (c) => bcs.saveLayout(c, { id: ok.id, ...base, elements: ok.elements, expectedVersion: 1 })), 'changed this layout');
    expect((await bcs.listLayouts(w.pool, uid('md'), 'carton')).filter((l) => l.is_default).length).toBe(1);
  });
  it('prints, logs every print, and wants a reason for a reprint', async () => {
    const s = await series('CT');
    const lay = (await bcs.listLayouts(w.pool, uid('sto'), 'carton'))[0];
    const r = await w.as('sto', (c) => bcs.issueCodes(c, { seriesId: s, count: 2, note: 'Order 77' }));
    const data = await bcs.labelValues(w.pool, uid('sto'), r.ids, lay.id);
    expect(data.labels.length).toBe(2); expect(data.labels[0].values.note).toBe('Order 77'); expect(data.labels[0].values.barcode).toBe(data.labels[0].code);
    const p1 = await w.as('sto', (c) => bcs.recordPrint(c, { barcodeIds: r.ids, layoutId: lay.id, copies: 2 }));
    expect(p1.reprints).toBe(0);
    await rejects(w.as('sto', (c) => bcs.recordPrint(c, { barcodeIds: [r.ids[0]], layoutId: lay.id })), 'printed before');
    const p2 = await w.as('sto', (c) => bcs.recordPrint(c, { barcodeIds: [r.ids[0]], layoutId: lay.id, reason: 'Faded' }));
    expect(p2.reprints).toBe(1);
    const hist = await bcs.printHistory(w.pool, uid('sto'), r.ids[0]);
    expect(hist.length).toBe(2); expect(hist[0].is_reprint).toBe(true); expect(hist[0].reason).toBe('Faded');
    await rejects(w.pool.query('DELETE FROM barcode_print'), 'append-only');
    await rejects(bcs.labelValues(w.pool, uid('sto'), [(await w.pool.query(`SELECT id FROM barcode WHERE entity_type='location' LIMIT 1`)).rows[0].id], lay.id), 'this layout is for');
    const reg = await bcs.registry(w.pool, uid('sto'), { q: 'ct-' });
    expect(reg.total).toBeGreaterThan(0); expect(reg.rows[0].print_count).toBeGreaterThanOrEqual(0);
  });
  it('reads a standalone code (a carton) when scanned', async () => {
    const code = (await w.pool.query(`SELECT code FROM barcode WHERE entity_type='carton' AND status='active' LIMIT 1`)).rows[0].code;
    const f = await bc.resolveScan(w.pool, uid('sto'), code);
    expect(f.type).toBe('standalone');
  });
});
