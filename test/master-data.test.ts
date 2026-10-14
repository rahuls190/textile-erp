import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as md from '../src/domain/master-data.js';
import * as masters from '../src/domain/masters.js';
import * as po from '../src/domain/po.js';
import { seedSalesBase } from '../src/seed/sales-demo.js';
import { seedMastersDemo } from '../src/seed/masters-demo.js';

/** Expect a refusal whose code or message contains the given text. */
async function rejects(p: Promise<unknown>, part: string) {
  try { await p; } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === part || (err.message ?? '').toLowerCase().includes(part.toLowerCase())) return err;
    throw new Error(`Expected "${part}" but got ${err.code}: ${err.message}`);
  }
  throw new Error(`Expected a refusal containing "${part}" but it succeeded`);
}
let w: World; let t: Record<string, string>;
beforeAll(async () => {
  w = await freshWorld('masters');
  await seedSalesBase(w); await seedMastersDemo(w, true);
  t = Object.fromEntries((await w.pool.query('SELECT code, id FROM material_type')).rows.map((r) => [r.code, r.id]));
});
afterAll(async () => { await w.pool.end(); });
const uid = (u: string) => w.actors[u].id;

describe('material types', () => {
  it('lists types with counts and refuses duplicates and outsiders', async () => {
    const list = await md.listMaterialTypes(w.pool, uid('md'));
    expect(list.find((x) => x.code === 'KNIT')!.items).toBeGreaterThanOrEqual(3);
    await rejects(w.as('md', (c) => md.createMaterialType(c, { code: 'knit', name: 'Another', kind: 'FABRIC', defaultUnit: 'M' })), 'already exists');
    await rejects(w.as('buy', (c) => md.createMaterialType(c, { code: 'NEW', name: 'New', kind: 'TRIM', defaultUnit: 'M' })), 'FORBIDDEN');
  });
  it('parses attribute lines both ways', () => {
    const a = md.parseAttrs('Width|number|cm|required\nColour|text');
    expect(a[0]).toMatchObject({ key: 'width', type: 'number', unit: 'cm', required: true });
    expect(md.parseAttrs(md.attrsToText(a))).toEqual(a);
    expect(() => md.parseAttrs('Width|decimal')).toThrow();
  });
});

describe('materials', () => {
  it('numbers codes by type prefix and checks required attributes', async () => {
    const it = await w.as('md', (c) => md.createMaterial(c, { typeId: t.KNIT, name: 'Interlock 200 GSM', attributes: { width: 170, gsm: 200 } }));
    expect(it.code).toMatch(/^FAB-\d{3}$/);
    expect(it.kind).toBe('FABRIC'); expect(it.status).toBe('draft'); expect(it.tracking).toBe('ROLL');
    await rejects(w.as('md', (c) => md.createMaterial(c, { typeId: t.KNIT, name: 'No width', attributes: { gsm: 100 } })), 'Width is required');
    await rejects(w.as('md', (c) => md.createMaterial(c, { typeId: t.KNIT, name: 'interlock 200 gsm', attributes: { width: 1, gsm: 1 } })), 'already exists');
    await rejects(w.as('md', (c) => md.createMaterial(c, { typeId: t.KNIT, name: 'Bad hsn', hsnCode: '12', attributes: { width: 1, gsm: 1 } })), 'HSN');
  });
  it('edits with versioning; a stale edit is refused; audit keeps before/after', async () => {
    const it = (await w.pool.query(`SELECT * FROM item WHERE name='Interlock 200 GSM'`)).rows[0];
    const u = await w.as('md', (c) => md.updateMaterial(c, { itemId: it.id, expectedVersion: it.version, reorderLevel: '300', gstRate: '5' }));
    expect(u.version).toBe(it.version + 1);
    await rejects(w.as('md', (c) => md.updateMaterial(c, { itemId: it.id, expectedVersion: it.version, name: 'x' })), 'STALE_VERSION');
    expect((await w.pool.query(`SELECT 1 FROM audit_log WHERE action='item.update' AND entity_id=$1 AND before IS NOT NULL`, [it.id])).rowCount).toBe(1);
  });
  it('lists with search, type filter and stock', async () => {
    const all = await md.listMaterials(w.pool, uid('buy'));
    expect(all.length).toBeGreaterThan(10);
    expect((await md.listMaterials(w.pool, uid('buy'), { q: 'elastic' })).length).toBeGreaterThanOrEqual(2);
    expect((await md.listMaterials(w.pool, uid('buy'), { typeId: t.CUP })).every((x) => x.type_code === 'CUP')).toBe(true);
    expect(await md.listMaterials(w.pool, uid('hrm'))).toEqual([]);
  });
  it('will not switch off a material that is in stock or on open orders; separate right needed', async () => {
    const fab = (await w.pool.query('SELECT * FROM item WHERE id=$1', [w.items.fabric])).rows[0];
    await rejects(w.as('md', (c) => md.setMaterialActive(c, { itemId: fab.id, expectedVersion: fab.version, active: false, reason: 'x' })), 'FORBIDDEN');
    await rejects(w.as('eng', (c) => md.setMaterialActive(c, { itemId: fab.id, expectedVersion: fab.version, active: false })), 'why');
    // a material nothing uses can be switched off and back on, and then cannot be bought
    const hw = (await w.pool.query(`SELECT * FROM item WHERE name LIKE 'Bra hook%'`)).rows[0];
    const off = await w.as('eng', (c) => md.setMaterialActive(c, { itemId: hw.id, expectedVersion: hw.version, active: false, reason: 'Discontinued' }));
    expect(off.status).toBe('inactive');
    await rejects(w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: hw.id, qty: '10', rate: '1' }] } as never)), 'released items');
    const on = await w.as('eng', (c) => md.setMaterialActive(c, { itemId: hw.id, expectedVersion: off.version, active: true }));
    expect(on.status).toBe('active');
  });
});

describe('vendors and clients', () => {
  it('validates GSTIN / PAN and catches duplicates', async () => {
    await rejects(w.as('buy', (c) => md.createParty(c, { name: 'Bad GST', role: 'vendor', gstin: '123' })), 'GSTIN');
    await rejects(w.as('buy', (c) => md.createParty(c, { name: 'Mismatch', role: 'vendor', gstin: '24AAACA4321B1Z7', pan: 'ZZZZZ9999Z' })), 'PAN does not match');
    await rejects(w.as('buy', (c) => md.createParty(c, { name: 'Other name', role: 'vendor', gstin: '24AAACA4321B1Z7' })), 'duplicate');
    await rejects(w.as('buy', (c) => md.createParty(c, { name: 'anand elastics', role: 'vendor' })), 'duplicate');
    const p = await w.as('buy', (c) => md.createParty(c, { name: 'Fresh Vendor', role: 'vendor', paymentDays: 30, contact: { name: 'Ravi', phone: '9800000000' } }));
    expect(p.code).toMatch(/^V-\d{3}$/); expect(p.status).toBe('draft');
  });
  it('a bank or GSTIN change on an approved vendor goes back to verification and masks the audit', async () => {
    const v = (await w.pool.query(`SELECT * FROM partner WHERE name='Anand Elastics'`)).rows[0];
    expect(v.status).toBe('active');
    const r = await w.as('buy', (c) => md.updateParty(c, { partnerId: v.id, expectedVersion: v.version, bankAccount: '999988887777' }));
    expect(r.sentBack).toBe(true); expect(r.status).toBe('verification'); expect(r.bank_verified_by).toBeNull();
    await rejects(w.as('buy', (c) => po.createPO(c, { siteId: w.siteId, partnerId: v.id, lines: [{ itemId: w.items.trim, qty: '10', rate: '4' }] } as never)), 'not an active vendor');
    const a = (await w.pool.query(`SELECT after FROM audit_log WHERE action='partner.update' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [v.id])).rows[0].after;
    expect(JSON.stringify(a)).not.toContain('999988887777');
    await w.as('fc', (c) => masters.verifyPartnerBank(c, { partnerId: v.id, expectedVersion: r.version }));
    await w.as('com', (c) => masters.approvePartner(c, { partnerId: v.id, expectedVersion: r.version + 1 }));
  });
  it('contacts and addresses: first contact is primary, deleting it promotes another', async () => {
    const v = (await w.pool.query(`SELECT id FROM partner WHERE name='Galaxy Foam and Cups'`)).rows[0];
    const c2 = await w.as('buy', (c) => md.addContact(c, { partnerId: v.id, name: 'Second', phone: '9811111111' }));
    expect(c2.is_primary).toBe(false);
    const full = await md.getParty(w.pool, uid('buy'), v.id);
    const prim = full!.contacts.find((x: { is_primary: boolean }) => x.is_primary);
    await w.as('buy', (c) => md.removeContact(c, { contactId: prim.id }));
    expect((await md.getParty(w.pool, uid('buy'), v.id))!.contacts[0].is_primary).toBe(true);
    await rejects(w.as('buy', (c) => md.addAddress(c, { partnerId: v.id, kind: 'billing', line1: 'x', pincode: '12' })), 'Pincode');
    await rejects(w.as('buy', (c) => md.addContact(c, { partnerId: v.id, name: 'X', email: 'nope' })), 'Email');
  });
  it('suspend needs commercial; a suspended customer cannot be sold to; reactivation restores', async () => {
    const c1 = (await w.pool.query(`SELECT * FROM partner WHERE code='C-002'`)).rows[0];
    await rejects(w.as('buy', (c) => md.suspendParty(c, { partnerId: c1.id, expectedVersion: c1.version, reason: 'x' })), 'FORBIDDEN');
    const s = await w.as('com', (c) => md.suspendParty(c, { partnerId: c1.id, expectedVersion: c1.version, reason: 'Cheque bounced' }));
    expect(s.status).toBe('suspended');
    const sales = await import('../src/domain/sales.js');
    await rejects(w.as('sal', (c) => sales.createOrder(c, { siteId: w.siteId, customerId: c1.id, lines: [{ itemId: w.items.fabric, qty: '10', rate: '300' }] })), 'must be approved');
    expect((await w.as('com', (c) => md.reactivateParty(c, { partnerId: c1.id, expectedVersion: s.version }))).status).toBe('active');
  });
  it('lists by role with totals, search and a client waiting for approval; bank is masked for non-finance', async () => {
    const vs = await md.listParties(w.pool, uid('buy'), { role: 'vendor' });
    expect(vs!.length).toBeGreaterThanOrEqual(4);
    expect(vs!.find((x) => x.code === 'V-001')!.pos).toBeGreaterThanOrEqual(0);
    const cs = await md.listParties(w.pool, uid('sal'), { role: 'customer', q: 'metro' });
    expect(cs![0]).toMatchObject({ name: 'Metro Innerwear', status: 'verification' });
    expect(await md.listParties(w.pool, uid('hrm'), { role: 'vendor' })).toBeNull();
    const v = (await w.pool.query(`SELECT id FROM partner WHERE code='V-001'`)).rows[0];
    expect((await md.getParty(w.pool, uid('buy'), v.id))!.p.bank_account).toMatch(/^••••/);
    expect((await md.getParty(w.pool, uid('fc'), v.id))!.p.bank_account).toMatch(/^\d+$/);
  });
});

describe('bulk add', () => {
  it('materials: all-or-nothing with row numbers; dry run saves nothing', async () => {
    const bad = `type,name,hsn,gst,attr_width,attr_gsm,attr_count\nKNIT,Bulk A,6006,5,150,160,\nNOPE,Bulk B,,,,,\nTHREAD,Bulk C,5401,12,,,40/2`;
    const r = await w.as('md', (c) => md.importMaterials(c, bad));
    expect(r.created).toBe(0); expect(r.errors[0]).toMatchObject({ row: 3 });
    expect((await w.pool.query(`SELECT 1 FROM item WHERE name LIKE 'Bulk %'`)).rowCount).toBe(0);
    const good = `type,name,hsn,gst,attr_width,attr_gsm\nKNIT,Bulk A,6006,5,150,160\nKNIT,Bulk B,6006,5,150,170`;
    const dry = await w.as('md', (c) => md.importMaterials(c, good, true));
    expect(dry.created).toBe(2); expect((await w.pool.query(`SELECT 1 FROM item WHERE name LIKE 'Bulk %'`)).rowCount).toBe(0);
    const ok = await w.as('md', (c) => md.importMaterials(c, good));
    expect(ok.created).toBe(2);
    const codes = (await w.pool.query(`SELECT code FROM item WHERE name LIKE 'Bulk %' ORDER BY code`)).rows.map((x) => x.code);
    expect(new Set(codes).size).toBe(2);
  });
  it('parties: finds bad GSTIN, duplicate inside the paste, and loads good rows', async () => {
    const bad = `role,name,gstin,city\nvendor,Paste One,,Pune\nclient,Paste Two,BADGST,Pune\nvendor,Paste One,,Pune`;
    const r = await w.as('buy', (c) => md.importParties(c, bad));
    expect(r.created).toBe(0); expect(r.errors.map((e) => e.row)).toEqual([3, 4]);
    const ok = await w.as('buy', (c) => md.importParties(c, `role,name,city,contact_name\nvendor,Paste One,Pune,Ram\ncustomer,Paste Two,Pune,Sita`));
    expect(ok.created).toBe(2);
    expect((await w.pool.query(`SELECT 1 FROM partner WHERE name LIKE 'Paste %' AND is_customer`)).rowCount).toBe(1);
  });
});
