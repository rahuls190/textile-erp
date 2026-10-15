import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as md from '../src/domain/master-data.js';
import * as bulk from '../src/domain/bulk.js';
import { seedSalesBase } from '../src/seed/sales-demo.js';
import { seedMastersDemo } from '../src/seed/masters-demo.js';

async function rejects(p: Promise<unknown>, part: string) {
  try { await p; } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === part || (err.message ?? '').toLowerCase().includes(part.toLowerCase())) return err;
    throw new Error(`Expected "${part}" but got ${err.code}: ${err.message}`);
  }
  throw new Error(`Expected a refusal containing "${part}" but it succeeded`);
}
let w: World;
beforeAll(async () => { w = await freshWorld('bulk'); await seedSalesBase(w); await seedMastersDemo(w, true); });
afterAll(async () => { await w.pool.end(); });
const uid = (u: string) => w.actors[u].id;

describe('distributors and retailers', () => {
  it('splits customers by type and keeps old customers as retailers', async () => {
    const d = await md.listParties(w.pool, uid('sal'), { role: 'customer', customerType: 'distributor' });
    const r = await md.listParties(w.pool, uid('sal'), { role: 'customer', customerType: 'retailer' });
    expect(d!.map((x) => x.name)).toEqual(expect.arrayContaining(['Metro Innerwear']));
    expect(r!.some((x) => x.code === 'C-001')).toBe(true);
    expect(d!.some((x) => x.code === 'C-001')).toBe(false);
    const p = await w.as('sal', (c) => md.createParty(c, { name: 'Tiny Shop', role: 'customer' }));
    expect(p.customer_type).toBe('retailer');
    await rejects(w.as('sal', (c) => md.createParty(c, { name: 'Odd Shop', role: 'customer', customerType: 'wholesaler' as never })), 'distributor or retailer');
  });
});

describe('import and export', () => {
  it('importing the export of a list changes nothing and creates nothing', async () => {
    for (const head of ['vendors', 'distributors', 'retailers', 'materials', 'finished'] as const) {
      const { csv, rows } = await bulk.exportCsv(w.pool, uid('md'), head).catch(() => bulk.exportCsv(w.pool, uid('sal'), head));
      expect(rows, head).toBeGreaterThan(0);
      const scope = head === 'vendors' ? 'vendor' : head === 'distributors' ? 'distributor' : head === 'retailers' ? 'retailer' : undefined;
      const act = head === 'vendors' || head === 'distributors' || head === 'retailers' ? 'buy' : 'md';
      const who = head === 'distributors' || head === 'retailers' ? 'sal' : act;
      const r = await w.as(who, (c) => (scope ? md.importParties(c, csv, true, scope) : md.importMaterials(c, csv, true, head === 'finished' ? 'fg' : 'materials')));
      expect(r.errors, head).toEqual([]);
      expect(r.created, head).toBe(0);
      expect(r.updated, head).toBe(rows);
    }
  });
  it('adds new rows and changes rows that carry a code, all or nothing', async () => {
    const csv = 'code,name,gstin,pan,city,state,phone,email,payment_days,contact_name,contact_phone\n,Om Trims,24AAACO1111F1Z4,AAACO1111F,Surat,Gujarat,9824011122,o@om.example,30,Raju,9824011122\nV-001,Sunrise Textiles,,,Mysuru,,,,,,\n';
    const r = await w.as('buy', (c) => md.importParties(c, csv, false, 'vendor'));
    expect(r).toMatchObject({ created: 1, updated: 1, errors: [] });
    expect((await w.pool.query(`SELECT city FROM partner WHERE code='V-001'`)).rows[0].city).toBe('Mysuru');
    const bad = csv.replace('Om Trims', 'Om Trims Two').replace('24AAACO1111F1Z4', '24AAACO2222F1Z4').replace('AAACO1111F', 'AAACO2222F') + ',Bad Row,,,,Atlantis,,,,,\n';
    const r2 = await w.as('buy', (c) => md.importParties(c, bad, false, 'vendor'));
    expect(r2.errors.length).toBeGreaterThan(0);
    expect((await w.pool.query(`SELECT 1 FROM partner WHERE name='Om Trims Two'`)).rowCount).toBe(0);
  });
  it('keeps distributors, retailers and vendors in their own lists', async () => {
    const wrong = await w.as('sal', (c) => md.importParties(c, 'name,role\nX Co,vendor\n', true, 'retailer'));
    expect(wrong.errors[0].message).toContain('retailers only');
    const ok = await w.as('sal', (c) => md.importParties(c, 'name,role\nBig Dist,distributor\nLittle Shop,retailer\n', false, undefined));
    expect(ok.created).toBe(2);
    expect((await md.listParties(w.pool, uid('sal'), { role: 'customer', customerType: 'distributor' }))!.some((x) => x.name === 'Big Dist')).toBe(true);
  });
  it('finished goods list takes finished-goods types only, materials list refuses them', async () => {
    const fg = await w.as('md', (c) => md.importMaterials(c, 'type,name,hsn,gst,unit,attr_size,attr_colour\nGARMENT,Basic tee black M,6109,5,PC,M,Black\n', false, 'fg'));
    expect(fg.created).toBe(1);
    const r = await w.as('md', (c) => md.importMaterials(c, 'type,name\nGARMENT,Another tee\n', true, 'materials'));
    expect(r.errors[0].message).toContain('finished-goods type');
    const r2 = await w.as('md', (c) => md.importMaterials(c, 'type,name\nKNIT,Another knit\n', true, 'fg'));
    expect(r2.errors[0].message).toContain('not a finished-goods type');
  });
  it('adds SKUs from rows and grows the style when a size or colour is new', async () => {
    const before = (await w.pool.query(`SELECT count(*)::int n FROM sku`)).rows[0].n;
    const csv = 'style,size,colour_code,colour_name\nBRF-01,XXL,BLK,Black\nBRF-01,S,RED,Red\nBRF-01,S,BLK,Black\n';
    const dry = await w.as('md', (c) => bulk.importSkus(c, csv, true));
    expect(dry).toMatchObject({ created: 2, skipped: 1, errors: [] });
    expect((await w.pool.query(`SELECT count(*)::int n FROM sku`)).rows[0].n).toBe(before);
    const r = await w.as('md', (c) => bulk.importSkus(c, csv, false));
    expect(r.created).toBe(2);
    expect((await w.pool.query(`SELECT 1 FROM sku WHERE code IN ('BRF-01-BLK-XXL','BRF-01-RED-S')`)).rowCount).toBe(2);
    const bad = await w.as('md', (c) => bulk.importSkus(c, 'style,size,colour_code\nNOPE-1,S,BLK\n', false));
    expect(bad.errors[0].message).toContain('No style');
    await rejects(w.as('sto', (c) => bulk.importSkus(c, csv, true)), 'Not permitted');
  });
  it('exports SKUs and quotes values with commas', async () => {
    const e = await bulk.exportCsv(w.pool, uid('md'), 'skus');
    expect(e.csv.split('\n')[0]).toBe('style,size,colour_code,colour_name');
    expect(e.rows).toBeGreaterThan(12);
    expect(bulk.toCsv(['a'], [['x, "y"']])).toBe('a\n"x, ""y"""\n');
  });
});
