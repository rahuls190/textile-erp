// Export every master list as CSV in the same columns the importers read, so a file can be edited and loaded back.
import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan } from '../core/permissions.js';
import { badRequest } from '../core/errors.js';
import * as md from './master-data.js';
import * as bom from './bom.js';

const ANY = { anySite: true } as const;
const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCsv = (head: string[], rows: unknown[][]) => [head.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n') + '\n';

export const SKU_CSV = 'style,size,colour_code,colour_name';
export const HEADS = {
  vendors: { header: 'code,name,gstin,pan,city,state,phone,email,payment_days,contact_name,contact_phone', sample: ',Om Trims,24AAACO1111F1Z4,AAACO1111F,Surat,Gujarat,9824011122,orders@omtrims.example,30,Raju,9824011122' },
  distributors: { header: 'code,name,gstin,pan,city,state,phone,email,payment_days,contact_name,contact_phone', sample: ',Metro Distributors,29AAACM5566E1Z9,AAACM5566E,Bengaluru,Karnataka,9900112233,anil@metro.example,45,Anil Kumar,9900112233' },
  retailers: { header: 'code,name,gstin,pan,city,state,phone,email,payment_days,contact_name,contact_phone', sample: ',Style Corner,,,Pune,Maharashtra,9890011223,shop@stylecorner.example,15,Neha,9890011223' },
  materials: { header: 'code,type,name,description,hsn,gst,reorder_level,unit', sample: ',KNIT,Single jersey 180 GSM white,,6006,5,500,M' },
  finished: { header: 'code,type,name,description,hsn,gst,reorder_level,unit', sample: ',GARMENT,Basic tee white M,,6109,5,,PC' },
  skus: { header: SKU_CSV, sample: 'BRF-01,XXL,BLK,Black' },
} as const;
export type Head = keyof typeof HEADS;

export async function exportCsv(db: Db, userId: string, head: Head): Promise<{ csv: string; rows: number; file: string }> {
  if (head === 'vendors' || head === 'distributors' || head === 'retailers') {
    const list = await md.listParties(db, userId, head === 'vendors' ? { role: 'vendor' } : { role: 'customer', customerType: head === 'distributors' ? 'distributor' : 'retailer' });
    if (!list) throw badRequest('Your role cannot see this list');
    const ids = list.map((p) => p.id);
    const full = (await db.query('SELECT id, pan FROM partner WHERE id = ANY($1::uuid[])', [ids])).rows; const pan = new Map(full.map((r) => [r.id, r.pan]));
    const ph = (await db.query(`SELECT DISTINCT ON (partner_id) partner_id, name, phone FROM partner_contact WHERE partner_id = ANY($1::uuid[]) ORDER BY partner_id, is_primary DESC, created_at`, [ids])).rows; const ct = new Map(ph.map((r) => [r.partner_id, r]));
    return { rows: list.length, file: `${head}.csv`, csv: toCsv(HEADS[head].header.split(','), list.map((p) => [p.code, p.name, p.gstin, pan.get(p.id), p.city, p.state, p.phone, p.email, p.payment_days, ct.get(p.id)?.name, ct.get(p.id)?.phone])) };
  }
  if (head === 'materials' || head === 'finished') {
    const made = new Set((await db.query('SELECT item_id FROM sku UNION SELECT item_id FROM sku_pack')).rows.map((r) => r.item_id as string)); // style SKUs and packs are kept on the Products screen
    const list = (await md.listMaterials(db, userId)).filter((m) => (m.kind === 'FG') === (head === 'finished') && !made.has(m.id));
    const desc = new Map((await db.query('SELECT id, description FROM item')).rows.map((r) => [r.id, r.description]));
    const keys = [...new Set(list.flatMap((m) => Object.keys(m.attributes ?? {})))].sort();
    const snake = (k: string) => 'attr_' + k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
    return { rows: list.length, file: `${head === 'finished' ? 'finished-goods' : 'materials'}.csv`, csv: toCsv([...HEADS[head].header.split(','), ...keys.map(snake)], list.map((m) => [m.code, m.type_code, m.name, desc.get(m.id), m.hsn_code, m.gst_rate, m.reorder_level, m.stock_unit, ...keys.map((k) => (m.attributes ?? {})[k]).map((v) => v ?? '')])) };
  }
  await assertCan(db, userId, 'bom.view', ANY);
  const r = (await db.query(`SELECT s.code AS style, k.size, k.colour_code, c->>'name' AS colour_name FROM sku k JOIN product_style s ON s.id=k.style_id LEFT JOIN LATERAL jsonb_array_elements(s.colours) c ON c->>'code' = k.colour_code ORDER BY k.code`)).rows;
  return { rows: r.length, file: 'skus.csv', csv: toCsv(SKU_CSV.split(','), r.map((x) => [x.style, x.size, x.colour_code, x.colour_name])) };
}

/** Add SKUs from rows of style, size, colour. A size or colour the style does not list yet is added to the style first. */
export async function importSkus(ctx: Ctx, csv: string, dryRun = false): Promise<md.ImportResult & { skipped: number }> {
  await assertCan(ctx.db, ctx.actor.id, 'bom.create', ANY);
  const { head, rows } = md.parseCsv(csv);
  for (const need of ['style', 'size', 'colour_code']) if (!head.includes(need)) throw badRequest(`Header must include "${need}". Expected: ${SKU_CSV}`);
  const errors: md.ImportResult['errors'] = []; let created = 0, skipped = 0;
  await ctx.db.query('SAVEPOINT imp_all');
  for (let n = 0; n < rows.length; n++) {
    const g = (k: string) => rows[n][head.indexOf(k)] ?? '';
    try {
      await ctx.db.query('SAVEPOINT imp');
      const style = (await ctx.db.query('SELECT * FROM product_style WHERE code=$1', [g('style').toUpperCase()])).rows[0];
      if (!style) throw badRequest(`No style with code "${g('style')}". Make the style first on the Products screen`);
      const size = g('size').trim(), colour = g('colour_code').trim().toUpperCase();
      if (!size || !colour) throw badRequest('Size and colour_code are both needed');
      const sizes = style.sizes as string[]; const colours = style.colours as { code: string; name: string }[];
      const sizeKnown = sizes.find((x) => x.toUpperCase() === size.toUpperCase());
      const colourKnown = colours.some((x) => x.code === colour);
      if (!sizeKnown || !colourKnown) await bom.updateStyle(ctx, { styleId: style.id, expectedVersion: style.version, sizes: sizeKnown ? undefined : [...sizes, size], colours: colourKnown ? undefined : [...colours, { code: colour, name: g('colour_name') || colour }] });
      const r = await bom.createSkus(ctx, { styleId: style.id, combos: [{ size: sizeKnown ?? size, colour }] });
      created += r.created; skipped += r.skipped;
      await ctx.db.query(dryRun ? 'ROLLBACK TO SAVEPOINT imp' : 'RELEASE SAVEPOINT imp');
    } catch (e) { await ctx.db.query('ROLLBACK TO SAVEPOINT imp').catch(() => {}); errors.push({ row: n + 2, message: (e as Error).message }); }
  }
  if (errors.length || dryRun) await ctx.db.query('ROLLBACK TO SAVEPOINT imp_all');
  return { created: errors.length ? 0 : created, skipped, errors, dryRun };
}
