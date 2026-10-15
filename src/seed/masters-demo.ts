import type { World } from './demo.js';
import * as masters from '../domain/masters.js';
import * as md from '../domain/master-data.js';
import * as bom from '../domain/bom.js';

const A = md.parseAttrs;
export const TYPES: { code: string; name: string; kind: string; unit: string; tracking: string; prefix: string; attrs: string }[] = [
  { code: 'KNIT', name: 'Knit fabric', kind: 'FABRIC', unit: 'M', tracking: 'ROLL', prefix: 'FAB', attrs: 'Width|number|cm|required\nGSM|number||required\nComposition|text' },
  { code: 'WOVEN', name: 'Woven fabric', kind: 'FABRIC', unit: 'M', tracking: 'ROLL', prefix: 'WVN', attrs: 'Width|number|cm|required\nGSM|number\nWeave|text' },
  { code: 'ELASTIC', name: 'Elastic and tapes', kind: 'TRIM', unit: 'M', tracking: 'LOT', prefix: 'TRM', attrs: 'Width|number|mm|required\nColour|text' },
  { code: 'THREAD', name: 'Thread', kind: 'TRIM', unit: 'KG', tracking: 'LOT', prefix: 'THR', attrs: 'Count|text|required\nColour|text' },
  { code: 'HARDWARE', name: 'Hooks, zips and buttons', kind: 'TRIM', unit: 'PC', tracking: 'LOT', prefix: 'HWR', attrs: 'Size|text\nFinish|text' },
  { code: 'CUP', name: 'Bra cups and foam', kind: 'CUP', unit: 'PC', tracking: 'LOT', prefix: 'CUP', attrs: 'Cup size|text|required\nMoulding|text' },
  { code: 'LABEL', name: 'Labels and tags', kind: 'PACKING', unit: 'PC', tracking: 'NONE', prefix: 'LBL', attrs: 'Printed text|text' },
  { code: 'CARTON', name: 'Cartons and poly bags', kind: 'PACKING', unit: 'PC', tracking: 'NONE', prefix: 'PKG', attrs: 'Size|text|required' },
  { code: 'GARMENT', name: 'Finished garments', kind: 'FG', unit: 'PC', tracking: 'LOT', prefix: 'FG', attrs: 'Size|text|required\nColour|text' },
];

/** Material types, a fuller materials list, vendors and clients with contacts, addresses and rate cards. */
export async function seedMastersDemo(w: World, withSales: boolean) {
  const t: Record<string, string> = {};
  for (const x of TYPES) t[x.code] = (await w.as('md', (c) => md.createMaterialType(c, { code: x.code, name: x.name, kind: x.kind, defaultUnit: x.unit, tracking: x.tracking, prefix: x.prefix, attrs: A(x.attrs) }))).id;

  // The two original items get a type.
  for (const [id, code] of [[w.items.fabric, 'KNIT'], [w.items.trim, 'ELASTIC']] as const) {
    const v = (await w.pool.query('SELECT version FROM item WHERE id=$1', [id])).rows[0].version;
    await w.as('md', (c) => md.updateMaterial(c, { itemId: id, expectedVersion: v, typeId: t[code], hsnCode: code === 'KNIT' ? '6006' : '5806', gstRate: code === 'KNIT' ? '5' : '12', reorderLevel: code === 'KNIT' ? '500' : '1000',
      attributes: code === 'KNIT' ? { width: 160, gsm: 180, composition: '95% cotton, 5% lycra' } : { width: 12, colour: 'White' } }));
  }

  const mat = async (type: string, name: string, extra: Partial<md.NewMaterial> = {}, approve = true) => {
    const it = await w.as('md', (c) => md.createMaterial(c, { typeId: t[type], name, ...extra }));
    if (approve) {
      await w.as('md', (c) => masters.submitItem(c, { itemId: it.id, expectedVersion: 1 }));
      await w.as('eng', (c) => masters.approveItem(c, { itemId: it.id, expectedVersion: 2 }));
    }
    return it.id as string;
  };
  const wv = await mat('WOVEN', 'Poplin 120 GSM, white', { hsnCode: '5208', gstRate: '5', reorderLevel: '300', attributes: { width: 112, gsm: 120, weave: 'Plain' } });
  const rib = await mat('KNIT', 'Rib knit 220 GSM, black', { hsnCode: '6006', gstRate: '5', reorderLevel: '400', attributes: { width: 150, gsm: 220, composition: '96% cotton, 4% lycra' } });
  const picot = await mat('ELASTIC', 'Picot elastic 8mm, skin', { hsnCode: '5806', gstRate: '12', reorderLevel: '800', attributes: { width: 8, colour: 'Skin' } });
  const thr = await mat('THREAD', 'Polyester thread 40/2, white', { hsnCode: '5401', gstRate: '12', reorderLevel: '20', attributes: { count: '40/2', colour: 'White' } });
  await mat('HARDWARE', 'Bra hook and eye, 3 row', { hsnCode: '9606', gstRate: '12', reorderLevel: '5000', attributes: { size: '3x2', finish: 'Nickel free' } });
  const cup = await mat('CUP', 'Moulded cup B', { hsnCode: '6212', gstRate: '12', reorderLevel: '2000', attributes: { cupSize: 'B', moulding: 'Seamless' } });
  const lbl = await mat('LABEL', 'Woven brand label', { hsnCode: '5807', gstRate: '12', reorderLevel: '10000' });
  const ctn = await mat('CARTON', 'Export carton 60x40x40', { hsnCode: '4819', gstRate: '12', reorderLevel: '200', attributes: { size: '60x40x40 cm' } });
  await mat('GARMENT', 'Basic tee, white, M', { hsnCode: '6109', gstRate: '5', attributes: { size: 'M', colour: 'White' } });
  await mat('KNIT', 'Single jersey 150 GSM, navy', { hsnCode: '6006', gstRate: '5', attributes: { width: 160, gsm: 150 } }, false); // still a draft

  const wbox = await mat('CARTON', 'Retail box 3-pack', { hsnCode: '4819', gstRate: '12', reorderLevel: '300', attributes: { size: '22x16x6 cm' } });

  // Vendors: created by the buyer, bank verified by finance, approved by commercial
  const vend = async (name: string, gstin: string, o: md.PartnerProfile & { contact: { name: string; phone: string; role: string }; line: string; pin: string }, ready = true) => {
    const p = await w.as('buy', (c) => md.createParty(c, { name, role: 'vendor', gstin, pan: gstin.slice(2, 12), city: o.city, state: o.state, phone: o.phone, email: o.email, paymentDays: o.paymentDays, bankAccount: ready ? String(500100000000 + gstin.charCodeAt(5) * 7919 + gstin.charCodeAt(9) * 104729) : undefined, contact: o.contact }));
    await w.as('buy', (c) => md.addAddress(c, { partnerId: p.id, kind: 'works', line1: o.line, city: o.city, state: o.state, pincode: o.pin }));
    await w.as('buy', (c) => masters.submitPartner(c, { partnerId: p.id, expectedVersion: 1 }));
    if (ready) {
      await w.as('fc', (c) => masters.verifyPartnerBank(c, { partnerId: p.id, expectedVersion: 2 }));
      await w.as('com', (c) => masters.approvePartner(c, { partnerId: p.id, expectedVersion: 3 }));
    }
    return p.id as string;
  };
  // Sunrise Textiles (V-001) already exists; fill in its profile.
  const v1 = w.vendorId; const v1v = (await w.pool.query('SELECT version FROM partner WHERE id=$1', [v1])).rows[0].version;
  await w.as('buy', (c) => md.updateParty(c, { partnerId: v1, expectedVersion: v1v, pan: 'ABCDE1234F', city: 'Bengaluru', state: 'Karnataka', phone: '9845011122', email: 'sales@sunrisetextiles.example', paymentDays: 45 }));
  await w.as('buy', (c) => md.addContact(c, { partnerId: v1, name: 'S. Gowda', role: 'Sales head', phone: '9845011122', email: 'gowda@sunrisetextiles.example', primary: true }));
  await w.as('buy', (c) => md.addAddress(c, { partnerId: v1, kind: 'works', line1: '14, Peenya Industrial Area', city: 'Bengaluru', state: 'Karnataka', pincode: '560058' }));
  const v2 = await vend('Anand Elastics', '24AAACA4321B1Z7', { city: 'Surat', state: 'Gujarat', phone: '9824055501', email: 'orders@anandelastics.example', paymentDays: 30, contact: { name: 'Mahesh Anand', phone: '9824055501', role: 'Owner' }, line: 'Plot 22, Sachin GIDC', pin: '394230' });
  const v3 = await vend('Galaxy Foam and Cups', '27AAACG9876C1Z3', { city: 'Mumbai', state: 'Maharashtra', phone: '9820099912', email: 'sales@galaxyfoam.example', paymentDays: 60, contact: { name: 'Pooja Shah', phone: '9820099912', role: 'Accounts' }, line: 'Unit 5, Andheri MIDC', pin: '400093' });
  await vend('Shree Packaging', '24AAACS7788D1Z1', { city: 'Ahmedabad', state: 'Gujarat', phone: '9879012300', email: 'info@shreepack.example', paymentDays: 15, contact: { name: 'Kiran Patel', phone: '9879012300', role: 'Sales' }, line: 'Naroda GIDC, Phase 2', pin: '382330' }, false); // awaiting bank verification
  const rate = async (vendor: string, itemId: string, r: string) => {
    const x = await w.as('buy', (c) => masters.proposeRate(c, { partnerId: vendor, itemId, rate: r, effectiveFrom: '2026-04-01' }));
    await w.as('com', (c) => masters.approveRate(c, { rateId: x.id }));
  };
  await rate(v1, wv, '118.0000');
  await rate(v2, w.items.trim, '4.2000');
  await rate(v3, cup, '9.5000');

  // Clients. C-001 and C-002 exist when the sales demo ran.
  if (withSales) {
    for (const [code, contact, phone, city, state, line, pin] of [
      ['C-001', 'Lakshmi Narayan', '9886012001', 'Tiruppur', 'Tamil Nadu', '8, Kangeyam Road', '641604'],
      ['C-002', 'Farhan Qazi', '9820123456', 'Mumbai', 'Maharashtra', '3rd floor, Lower Parel', '400013'],
    ] as const) {
      const row = (await w.pool.query('SELECT id, version FROM partner WHERE code=$1', [code])).rows[0];
      await w.as('sal', (c) => md.updateParty(c, { partnerId: row.id, expectedVersion: row.version, city, state, phone, email: contact.split(' ')[0].toLowerCase() + '@' + (code === 'C-001' ? 'lakshmigarments' : 'urbanwear') + '.example', paymentDays: 45 }));
      await w.as('sal', (c) => md.addContact(c, { partnerId: row.id, name: contact, role: 'Purchase', phone, primary: true }));
      await w.as('sal', (c) => md.addAddress(c, { partnerId: row.id, kind: 'billing', label: 'Head office', line1: line, city, state, pincode: pin, phone }));
      await w.as('sal', (c) => md.addAddress(c, { partnerId: row.id, kind: 'shipping', label: code === 'C-001' ? 'Godown' : 'Warehouse', line1: code === 'C-001' ? 'Plot 22, SIDCO Industrial Estate' : 'Gala 7, Bhiwandi Logistics Park', line2: 'Gate 2, deliveries 9 to 5', city: code === 'C-001' ? city : 'Bhiwandi', state: code === 'C-001' ? state : 'Maharashtra', pincode: code === 'C-001' ? '641606' : '421302', contactName: contact, phone }));
    }
    const m = await w.as('sal', (c) => md.createParty(c, { name: 'Metro Innerwear', role: 'customer', gstin: '29AAACM5566E1Z9', pan: 'AAACM5566E', city: 'Bengaluru', state: 'Karnataka', phone: '9900112233', email: 'anil@metroinnerwear.example', contact: { name: 'Anil Kumar', phone: '9900112233', role: 'Owner' }, billing: { label: 'Office', line1: '45, Brigade Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' }, shippingSameAsBilling: true }));
    await w.as('sal', (c) => masters.submitPartner(c, { partnerId: m.id, expectedVersion: 1 })); // waiting for commercial approval
  }
  // A style with sizes and colours, its SKUs, an approved BOM and a 3-pack box.
  const st = await w.as('md', (c) => bom.createStyle(c, { code: 'BRF-01', name: 'Classic brief', category: 'Innerwear', hsnCode: '6107', gstRate: '5', sizes: ['S', 'M', 'L', 'XL'], colours: [{ code: 'BLK', name: 'Black' }, { code: 'WHT', name: 'White' }, { code: 'NVY', name: 'Navy' }] }));
  await w.as('md', (c) => bom.createSkus(c, { styleId: st.id }));
  const b = await w.as('md', (c) => bom.startBom(c, { styleId: st.id }));
  const saved = await w.as('md', (c) => bom.saveBomLines(c, { bomId: b.id, expectedRev: b.rev, notes: 'First costed BOM', lines: [
    { section: 'FABRIC', itemId: rib, qty: '0.2200', wastagePct: '6', qtyBySize: { S: '0.1900', M: '0.2100', L: '0.2400', XL: '0.2700' }, note: 'Body, cut width 150 cm' },
    { section: 'TRIM', itemId: picot, qty: '0.8000', wastagePct: '3', qtyBySize: { S: '0.7000', M: '0.7600', L: '0.8400', XL: '0.9000' }, note: 'Waist and leg' },
    { section: 'TRIM', itemId: thr, qty: '0.0030', wastagePct: '5' },
    { section: 'PACKING', itemId: lbl, qty: '1', note: 'Brand label' },
  ] }));
  await w.as('md', (c) => bom.submitBom(c, { bomId: b.id, expectedRev: saved.rev }));
  const sub = (await w.pool.query('SELECT rev FROM bom WHERE id=$1', [b.id])).rows[0].rev;
  await w.as('eng', (c) => bom.approveBom(c, { bomId: b.id, expectedRev: sub }));
  const sk = Object.fromEntries((await w.pool.query('SELECT code, id FROM sku WHERE style_id=$1', [st.id])).rows.map((x) => [x.code, x.id]));
  await w.as('md', (c) => bom.createPack(c, { code: 'BRF-01-3PK-M', name: 'Classic brief 3-pack, size M (black, white, navy)', skus: [{ skuId: sk['BRF-01-BLK-M'], qty: 1 }, { skuId: sk['BRF-01-WHT-M'], qty: 1 }, { skuId: sk['BRF-01-NVY-M'], qty: 1 }], materials: [{ itemId: wbox, qty: '1' }] }));

}
