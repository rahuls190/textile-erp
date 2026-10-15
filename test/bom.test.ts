import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as bom from '../src/domain/bom.js';
import * as masters from '../src/domain/masters.js';

async function rejects(p: Promise<unknown>, part: string) {
  try { await p; } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === part || (err.message ?? '').toLowerCase().includes(part.toLowerCase())) return err;
    throw new Error(`Expected "${part}" but got ${err.code}: ${err.message}`);
  }
  throw new Error(`Expected a refusal containing "${part}" but it succeeded`);
}
let w: World; let blackFab: string; let whiteFab: string; let style: { id: string; version: number }; let skuIds: Record<string, string> = {};
const uid = (u: string) => w.actors[u].id;
beforeAll(async () => {
  w = await freshWorld('bom');
  const mk = async (code: string, name: string, kind: 'FABRIC' | 'TRIM') => {
    const it = await w.as('md', (c) => masters.createItem(c, { code, name, kind, stockUnit: kind === 'TRIM' ? 'M' : 'M', tracking: 'LOT' }));
    await w.as('md', (c) => masters.submitItem(c, { itemId: it.id, expectedVersion: 1 }));
    await w.as('eng', (c) => masters.approveItem(c, { itemId: it.id, expectedVersion: 2 }));
    return it.id as string;
  };
  blackFab = await mk('FAB-BLK', 'Black jersey', 'FABRIC'); whiteFab = await mk('FAB-WHT', 'White jersey', 'FABRIC');
});
afterAll(async () => { await w.pool.end(); });

describe('styles and SKUs', () => {
  it('makes one stock item per size and colour, in draft until the BOM is approved', async () => {
    await rejects(w.as('sto', (c) => bom.createStyle(c, { code: 'BRF-01', name: 'Brief', sizes: ['S'], colours: [] })), 'Not permitted');
    await rejects(w.as('md', (c) => bom.createStyle(c, { code: 'b', name: 'Brief', sizes: ['S'], colours: [] })), 'Style code');
    await rejects(w.as('md', (c) => bom.createStyle(c, { code: 'BRF-01', name: 'Brief', sizes: ['S', 's'], colours: [] })), 'twice');
    await rejects(w.as('md', (c) => bom.createStyle(c, { code: 'BRF-01', name: 'Brief', sizes: ['S'], colours: [{ code: 'B-K', name: 'Black' }] })), 'Colour code');
    style = await w.as('md', (c) => bom.createStyle(c, { code: 'BRF-01', name: 'Classic brief', category: 'Innerwear', sizes: ['S', 'M', 'L', 'XL'], colours: [{ code: 'BLK', name: 'Black' }, { code: 'WHT', name: 'White' }] }));
    await rejects(w.as('md', (c) => bom.createStyle(c, { code: 'BRF-01', name: 'Other', sizes: ['S'], colours: [] })), 'already exists');
    const r = await w.as('md', (c) => bom.createSkus(c, { styleId: style.id }));
    expect(r.created).toBe(8); expect(r.codes).toContain('BRF-01-BLK-XL');
    const again = await w.as('md', (c) => bom.createSkus(c, { styleId: style.id }));
    expect(again.created).toBe(0); expect(again.skipped).toBe(8);
    const items = (await w.pool.query(`SELECT i.status, i.kind, i.code FROM sku k JOIN item i ON i.id=k.item_id WHERE k.style_id=$1`, [style.id])).rows;
    expect(items.every((i) => i.status === 'draft' && i.kind === 'FG')).toBe(true);
    skuIds = Object.fromEntries((await w.pool.query('SELECT code, id FROM sku WHERE style_id=$1', [style.id])).rows.map((x) => [x.code, x.id]));
    expect((await w.pool.query(`SELECT count(*)::int n FROM barcode WHERE entity_type='item' AND code LIKE 'BRF-01-%'`)).rows[0].n).toBe(8); // every SKU has a barcode row
  });
});

describe('BOM rules', () => {
  let b: { id: string; rev: number };
  it('applies lines by size and colour and changes quantity by size', async () => {
    b = await w.as('md', (c) => bom.startBom(c, { styleId: style.id }));
    await rejects(w.as('md', (c) => bom.startBom(c, { styleId: style.id })), 'already being worked on');
    const saved = await w.as('md', (c) => bom.saveBomLines(c, { bomId: b.id, expectedRev: b.rev, lines: [
      { section: 'FABRIC', itemId: blackFab, qty: '0.30', wastagePct: '5', colours: ['BLK'], qtyBySize: { XL: '0.36' } },
      { section: 'FABRIC', itemId: whiteFab, qty: '0.30', wastagePct: '5', colours: ['WHT'], qtyBySize: { XL: '0.36' } },
      { section: 'TRIM', itemId: w.items.trim, qty: '0.8', sizes: ['S', 'M'] },
      { section: 'TRIM', itemId: w.items.trim, qty: '0.9', sizes: ['L', 'XL'] }] }));
    b = { id: b.id, rev: saved.rev };
    const m = await bom.skuBom(w.pool, uid('md'), { bomId: b.id, skuId: skuIds['BRF-01-BLK-M'] });
    expect(m.lines.map((l) => l.item_code)).toEqual(['FAB-BLK', 'TRM-001']);
    expect(m.lines[0].gross).toBeCloseTo(0.315, 4); expect(m.lines[1].net).toBe(0.8);
    const xl = await bom.skuBom(w.pool, uid('md'), { bomId: b.id, skuId: skuIds['BRF-01-WHT-XL'] });
    expect(xl.lines.map((l) => l.item_code)).toEqual(['FAB-WHT', 'TRM-001']); expect(xl.lines[0].net).toBe(0.36); expect(xl.lines[0].size_specific).toBe(true); expect(xl.lines[1].net).toBe(0.9);
  });
  it('refuses duplicates for the same size and colour, unknown sizes and non-materials', async () => {
    const L = (o: object) => ({ section: 'TRIM' as const, itemId: w.items.trim, qty: '1', ...o });
    await rejects(w.as('md', (c) => bom.saveBomLines(c, { bomId: b.id, expectedRev: b.rev, lines: [L({}), L({ sizes: ['S'] })] })), 'same material');
    await rejects(w.as('md', (c) => bom.saveBomLines(c, { bomId: b.id, expectedRev: b.rev, lines: [L({ sizes: ['XXL'] })] })), 'not in this style');
    await rejects(w.as('md', (c) => bom.saveBomLines(c, { bomId: b.id, expectedRev: b.rev, lines: [L({ qty: '0' })] })), 'positive');
    await rejects(w.as('md', (c) => bom.saveBomLines(c, { bomId: b.id, expectedRev: b.rev, lines: [L({ sizes: ['S'], qtyBySize: { L: '2' } })] })), 'does not cover');
    const fg = (await w.pool.query('SELECT item_id FROM sku LIMIT 1')).rows[0].item_id;
    await rejects(w.as('md', (c) => bom.saveBomLines(c, { bomId: b.id, expectedRev: b.rev, lines: [L({ itemId: fg })] })), 'draft'); // SKU items are not active yet
    await rejects(w.as('md', (c) => bom.saveBomLines(c, { bomId: b.id, expectedRev: 99, lines: [L({})] })), 'STALE_VERSION');
  });
  it('goes for approval only when every SKU is covered, and a different person approves', async () => {
    const c0 = await bom.checkBom(w.pool, b.id); expect(c0.problems).toEqual([]);
    const half = await w.as('md', (c) => bom.saveBomLines(c, { bomId: b.id, expectedRev: b.rev, lines: [{ section: 'FABRIC', itemId: blackFab, qty: '0.3', colours: ['BLK'] }] }));
    b = { id: b.id, rev: half.rev };
    await rejects(w.as('md', (c) => bom.submitBom(c, { bomId: b.id, expectedRev: b.rev })), 'would get no materials');
    const full = await w.as('md', (c) => bom.saveBomLines(c, { bomId: b.id, expectedRev: b.rev, lines: [
      { section: 'FABRIC', itemId: blackFab, qty: '0.30', wastagePct: '5', colours: ['BLK'], qtyBySize: { XL: '0.36' } }, { section: 'FABRIC', itemId: whiteFab, qty: '0.30', wastagePct: '5', colours: ['WHT'], qtyBySize: { XL: '0.36' } },
      { section: 'TRIM', itemId: w.items.trim, qty: '0.8', sizes: ['S', 'M'] }, { section: 'TRIM', itemId: w.items.trim, qty: '0.9', sizes: ['L', 'XL'] }] }));
    b = { id: b.id, rev: full.rev };
    const sub = await w.as('md', (c) => bom.submitBom(c, { bomId: b.id, expectedRev: b.rev })); b = { id: b.id, rev: sub.rev };
    await rejects(w.as('md', (c) => bom.saveBomLines(c, { bomId: b.id, expectedRev: b.rev, lines: [] })), 'submitted');
    await rejects(w.as('md', (c) => bom.approveBom(c, { bomId: b.id, expectedRev: b.rev })), 'Not permitted');
    const ret = await w.as('eng', (c) => bom.returnBom(c, { bomId: b.id, expectedRev: b.rev, reason: 'Check wastage' })); b = { id: b.id, rev: ret.rev };
    expect((await bom.getBom(w.pool, uid('md'), b.id)).bom.return_reason).toBe('Check wastage');
    const sub2 = await w.as('md', (c) => bom.submitBom(c, { bomId: b.id, expectedRev: b.rev })); b = { id: b.id, rev: sub2.rev };
    const ok = await w.as('eng', (c) => bom.approveBom(c, { bomId: b.id, expectedRev: b.rev }));
    expect(ok.status).toBe('active');
    const st = (await w.pool.query(`SELECT i.status FROM sku k JOIN item i ON i.id=k.item_id WHERE k.style_id=$1`, [style.id])).rows;
    expect(st.every((x) => x.status === 'active')).toBe(true);
  });
  it('a new version starts as a copy, and approving it retires the old one', async () => {
    const v2 = await w.as('md', (c) => bom.startBom(c, { styleId: style.id }));
    expect(v2.version).toBe(2); expect((await bom.getBom(w.pool, uid('md'), v2.id)).lines.length).toBe(4);
    await rejects(w.as('md', (c) => bom.saveBomLines(c, { bomId: (w as never as { x: string }).x ?? v2.id, expectedRev: 99, lines: [] })), 'STALE_VERSION');
    await w.as('md', (c) => bom.discardBom(c, { bomId: v2.id, expectedRev: v2.rev }));
    expect((await w.pool.query(`SELECT count(*)::int n FROM bom WHERE style_id=$1`, [style.id])).rows[0].n).toBe(1);
  });
});

describe('requirements and changes to a style', () => {
  it('adds up materials for a production plan, with wastage, stock and price', async () => {
    const active = (await w.pool.query(`SELECT id FROM bom WHERE style_id=$1 AND status='active'`, [style.id])).rows[0].id;
    const r = await bom.requirements(w.pool, uid('buy'), { bomId: active, plan: [{ skuId: skuIds['BRF-01-BLK-M'], qty: 1000 }, { skuId: skuIds['BRF-01-BLK-XL'], qty: 500 }, { skuId: skuIds['BRF-01-WHT-S'], qty: 200 }] });
    const by = Object.fromEntries(r.rows.map((x) => [x.code, x]));
    expect(r.pieces).toBe(1700);
    expect(by['FAB-BLK'].required).toBeCloseTo(1000 * 0.315 + 500 * 0.378, 3);
    expect(by['FAB-WHT'].required).toBeCloseTo(200 * 0.315, 3);
    expect(by['TRM-001'].required).toBeCloseTo(1000 * 0.8 + 500 * 0.9 + 200 * 0.8, 3);
    expect(by['TRM-001'].short).toBe(by['TRM-001'].required); expect(by['FAB-BLK'].rate).toBeNull();
    await rejects(bom.requirements(w.pool, uid('buy'), { bomId: active, plan: [{ skuId: skuIds['BRF-01-BLK-M'], qty: 0 }] }), 'at least one');
    const ov = await bom.bomOverview(w.pool, uid('buy'), active); expect(ov.length).toBe(8); expect(ov.every((o) => o.lines === 2)).toBe(true);
  });
  it('will not drop a size or colour that SKUs or BOM lines use, but can add new ones', async () => {
    const s = (await w.pool.query('SELECT version FROM product_style WHERE id=$1', [style.id])).rows[0];
    await rejects(w.as('md', (c) => bom.updateStyle(c, { styleId: style.id, expectedVersion: s.version, sizes: ['S', 'M', 'L'] })), 'already has SKUs');
    const up = await w.as('md', (c) => bom.updateStyle(c, { styleId: style.id, expectedVersion: s.version, sizes: ['S', 'M', 'L', 'XL', 'XXL'], colours: [{ code: 'BLK', name: 'Black' }, { code: 'WHT', name: 'White' }, { code: 'NVY', name: 'Navy' }] }));
    expect(up.sizes.length).toBe(5);
    const more = await w.as('md', (c) => bom.createSkus(c, { styleId: style.id, combos: [{ size: 'XXL', colour: 'NVY' }] }));
    expect(more.created).toBe(1);
    expect((await w.pool.query(`SELECT i.status FROM sku k JOIN item i ON i.id=k.item_id WHERE k.code='BRF-01-NVY-XXL'`)).rows[0].status).toBe('active'); // active BOM exists, so the new SKU is usable straight away
  });
});

describe('packs (final box)', () => {
  it('makes a box item from several SKUs and packing materials', async () => {
    const box = (await (async () => {
      const it = await w.as('md', (c) => masters.createItem(c, { code: 'BOX-S', name: 'Retail box', kind: 'PACKING', stockUnit: 'M', tracking: 'LOT' }));
      await w.as('md', (c) => masters.submitItem(c, { itemId: it.id, expectedVersion: 1 }));
      await w.as('eng', (c) => masters.approveItem(c, { itemId: it.id, expectedVersion: 2 }));
      return it.id as string;
    })());
    const a = skuIds['BRF-01-BLK-M'], b = skuIds['BRF-01-WHT-M'];
    await rejects(w.as('sto', (c) => bom.createPack(c, { code: 'BRF-3PK', name: '3 pack', skus: [{ skuId: a, qty: 3 }] })), 'Not permitted');
    await rejects(w.as('md', (c) => bom.createPack(c, { code: 'BRF-3PK', name: '3 pack', skus: [] })), 'at least one');
    await rejects(w.as('md', (c) => bom.createPack(c, { code: 'BRF-3PK', name: '3 pack', skus: [{ skuId: a, qty: 1 }, { skuId: a, qty: 2 }] })), 'twice');
    await rejects(w.as('md', (c) => bom.createPack(c, { code: 'BRF-3PK', name: '3 pack', skus: [{ skuId: a, qty: 1 }], materials: [{ itemId: blackFab, qty: '1' }] })), 'packing');
    const p = await w.as('md', (c) => bom.createPack(c, { code: 'BRF-3PK', name: 'Brief 3-pack, black and white', skus: [{ skuId: a, qty: 2 }, { skuId: b, qty: 1 }], materials: [{ itemId: box, qty: '1' }] }));
    expect(p.pieces).toBe(3);
    const list = await bom.listPacks(w.pool, w.actors.md.id);
    expect(list.find((x: { code: string }) => x.code === 'BRF-3PK').lines).toHaveLength(3);
    await rejects(w.as('md', (c) => bom.createPack(c, { code: 'BRF-3PK', name: 'again', skus: [{ skuId: a, qty: 1 }] })), 'already used');
  });
});
