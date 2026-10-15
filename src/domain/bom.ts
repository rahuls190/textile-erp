// Products and bills of materials.
// A style is a design with sizes and colours. Each size and colour that is made is a SKU (a finished-goods stock item).
// A BOM lists what one piece needs; a line can apply to every size and colour, or only some, and can change its quantity by size.
// BOMs are versioned: one is edited at a time, a different person approves it, and approving it replaces the active one.
import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan, assertIndependent, visibleSites } from '../core/permissions.js';
import { audit } from '../core/audit.js';
import { badRequest, forbidden, invalidState, notFound, staleVersion } from '../core/errors.js';

const ANY = { anySite: true } as const;
export const SECTIONS = ['FABRIC', 'TRIM', 'CUP', 'PACKING', 'PROCESS', 'WIP'] as const;
export type Section = (typeof SECTIONS)[number];
export type Colour = { code: string; name: string };
export type LineInput = { section: Section; itemId: string; qty: string; wastagePct?: string; sizes?: string[] | null; colours?: string[] | null; qtyBySize?: Record<string, string>; note?: string };

const NUM = /^\d+(\.\d{1,4})?$/;
const num = (v: unknown) => Number(v);
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const skuCode = (style: string, colour: string, size: string) => `${style}-${colour}-${clean(size)}`;

// ───────────────────────── styles ─────────────────────────
function checkSizesColours(sizes: string[], colours: Colour[]) {
  if (!Array.isArray(sizes) || !sizes.length || sizes.length > 24) throw badRequest('List 1 to 24 sizes');
  const seen = new Set<string>();
  for (const s of sizes) { if (!s.trim() || s.length > 8) throw badRequest(`Size "${s}" is empty or longer than 8 characters`); if (seen.has(clean(s))) throw badRequest(`Size "${s}" is listed twice`); seen.add(clean(s)); }
  const cs = new Set<string>();
  for (const c of colours) {
    if (!/^[A-Z0-9]{2,5}$/.test(c.code)) throw badRequest(`Colour code "${c.code}": 2 to 5 capital letters or digits, like BLK`);
    if (!c.name?.trim()) throw badRequest(`Colour ${c.code} needs a name`);
    if (cs.has(c.code)) throw badRequest(`Colour code ${c.code} is used twice`); cs.add(c.code);
  }
  if (colours.length > 40) throw badRequest('Up to 40 colours');
}

export async function createStyle(ctx: Ctx, i: { code: string; name: string; category?: string; description?: string; hsnCode?: string; gstRate?: string; sizes: string[]; colours: Colour[] }) {
  await assertCan(ctx.db, ctx.actor.id, 'bom.create', ANY);
  const code = (i.code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,15}$/.test(code)) throw badRequest('Style code: 2 to 16 capital letters, digits or dashes, like BRF-01');
  if (!i.name?.trim()) throw badRequest('Give the style a name');
  const sizes = i.sizes.map((s) => s.trim()); const colours = i.colours.map((c) => ({ code: c.code.trim().toUpperCase(), name: c.name.trim() }));
  checkSizesColours(sizes, colours);
  if (i.gstRate && !(num(i.gstRate) >= 0 && num(i.gstRate) <= 40)) throw badRequest('GST rate: 0 to 40');
  if ((await ctx.db.query('SELECT 1 FROM product_style WHERE code=$1 OR lower(name)=lower($2)', [code, i.name.trim()])).rowCount) throw badRequest('A style with this code or name already exists');
  const r = (await ctx.db.query(`INSERT INTO product_style(code,name,category,description,hsn_code,gst_rate,sizes,colours,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [code, i.name.trim(), i.category?.trim() || null, i.description?.trim() || null, i.hsnCode?.trim() || null, i.gstRate || null, sizes, JSON.stringify(colours), ctx.actor.id])).rows[0];
  await audit(ctx, { action: 'style.create', entityType: 'product_style', entityId: r.id, after: { code, name: r.name, sizes, colours } });
  return r;
}

/** Change the name or the lists of sizes and colours. A size or colour can only be dropped when no SKU and no BOM line uses it. */
export async function updateStyle(ctx: Ctx, i: { styleId: string; expectedVersion: number; name?: string; category?: string; description?: string; sizes?: string[]; colours?: Colour[] }) {
  await assertCan(ctx.db, ctx.actor.id, 'bom.create', ANY);
  const s = (await ctx.db.query('SELECT * FROM product_style WHERE id=$1 FOR UPDATE', [i.styleId])).rows[0];
  if (!s) throw notFound('Style');
  if (s.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, s.version);
  const sizes = i.sizes ? i.sizes.map((x) => x.trim()) : s.sizes as string[];
  const colours = i.colours ? i.colours.map((c) => ({ code: c.code.trim().toUpperCase(), name: c.name.trim() })) : s.colours as Colour[];
  checkSizesColours(sizes, colours);
  for (const gone of (s.sizes as string[]).filter((x) => !sizes.includes(x))) {
    if ((await ctx.db.query('SELECT 1 FROM sku WHERE style_id=$1 AND size=$2', [s.id, gone])).rowCount) throw invalidState(`Size ${gone} already has SKUs and cannot be removed`);
    if ((await ctx.db.query('SELECT 1 FROM bom_line l JOIN bom b ON b.id=l.bom_id WHERE b.style_id=$1 AND ($2 = ANY(l.sizes) OR l.qty_by_size ? $2)', [s.id, gone])).rowCount) throw invalidState(`Size ${gone} is used in a BOM and cannot be removed`);
  }
  for (const gone of (s.colours as Colour[]).filter((x) => !colours.some((c) => c.code === x.code))) {
    if ((await ctx.db.query('SELECT 1 FROM sku WHERE style_id=$1 AND colour_code=$2', [s.id, gone.code])).rowCount) throw invalidState(`Colour ${gone.code} already has SKUs and cannot be removed`);
    if ((await ctx.db.query('SELECT 1 FROM bom_line l JOIN bom b ON b.id=l.bom_id WHERE b.style_id=$1 AND $2 = ANY(l.colours)', [s.id, gone.code])).rowCount) throw invalidState(`Colour ${gone.code} is used in a BOM and cannot be removed`);
  }
  const r = (await ctx.db.query(`UPDATE product_style SET name=$2, category=$3, description=$4, sizes=$5, colours=$6, version=version+1 WHERE id=$1 RETURNING *`,
    [s.id, i.name?.trim() || s.name, i.category ?? s.category, i.description ?? s.description, sizes, JSON.stringify(colours)])).rows[0];
  await audit(ctx, { action: 'style.update', entityType: 'product_style', entityId: s.id, before: { name: s.name, sizes: s.sizes, colours: s.colours }, after: { name: r.name, sizes, colours } });
  return r;
}

/** Make the SKUs: one per chosen size and colour. Existing ones are left alone. */
export async function createSkus(ctx: Ctx, i: { styleId: string; combos?: { size: string; colour: string }[] }) {
  await assertCan(ctx.db, ctx.actor.id, 'bom.create', ANY);
  const s = (await ctx.db.query('SELECT * FROM product_style WHERE id=$1 FOR UPDATE', [i.styleId])).rows[0];
  if (!s) throw notFound('Style');
  const colours = s.colours as Colour[];
  if (!colours.length) throw badRequest('Add at least one colour to the style first');
  const combos = i.combos ?? (s.sizes as string[]).flatMap((size) => colours.map((c) => ({ size, colour: c.code })));
  if (!combos.length) throw badRequest('Pick at least one size and colour');
  if (combos.length > 400) throw badRequest('Up to 400 SKUs at a time');
  const active = (await ctx.db.query(`SELECT approved_by FROM bom WHERE style_id=$1 AND status='active'`, [s.id])).rows[0];
  const type = (await ctx.db.query(`SELECT id FROM material_type WHERE kind='FG' AND status='active' ORDER BY code LIMIT 1`)).rows[0];
  const made: { id: string; code: string }[] = [];
  for (const c of combos) {
    if (!(s.sizes as string[]).includes(c.size)) throw badRequest(`Size ${c.size} is not in this style`);
    const col = colours.find((x) => x.code === c.colour); if (!col) throw badRequest(`Colour ${c.colour} is not in this style`);
    if ((await ctx.db.query('SELECT 1 FROM sku WHERE style_id=$1 AND size=$2 AND colour_code=$3', [s.id, c.size, c.colour])).rowCount) continue;
    const code = skuCode(s.code, col.code, c.size);
    if (code.length > 40) throw badRequest(`SKU code ${code} is too long`);
    if ((await ctx.db.query('SELECT 1 FROM item WHERE code=$1', [code])).rowCount) throw badRequest(`The code ${code} is already used by another item`);
    const it = (await ctx.db.query(
      `INSERT INTO item(code,name,kind,stock_unit,tracking,status,attributes,created_by,approved_by,material_type_id,hsn_code,gst_rate,description)
       VALUES ($1,$2,'FG','PC','LOT',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [code, `${s.name} · ${col.name} · ${c.size}`, active ? 'active' : 'draft', JSON.stringify({ style: s.code, size: c.size, colour: col.name, colourCode: col.code }), ctx.actor.id, active?.approved_by ?? null, type?.id ?? null, s.hsn_code, s.gst_rate, s.description])).rows[0];
    const k = (await ctx.db.query(`INSERT INTO sku(style_id,item_id,code,size,colour_code,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [s.id, it.id, code, c.size, c.colour, ctx.actor.id])).rows[0];
    made.push({ id: k.id, code });
  }
  await audit(ctx, { action: 'style.skus', entityType: 'product_style', entityId: s.id, after: { created: made.map((m) => m.code) } });
  return { created: made.length, skipped: combos.length - made.length, codes: made.map((m) => m.code) };
}

// ───────────────────────── reading ─────────────────────────
export async function listStyles(db: Db, userId: string) {
  await assertCan(db, userId, 'bom.view', ANY);
  return (await db.query(
    `SELECT s.id, s.code, s.name, s.category, s.status, cardinality(s.sizes) AS n_sizes, jsonb_array_length(s.colours) AS n_colours,
            (SELECT count(*) FROM sku k WHERE k.style_id=s.id)::int AS n_skus,
            (SELECT b.version FROM bom b WHERE b.style_id=s.id AND b.status='active') AS active_version,
            (SELECT b.status FROM bom b WHERE b.style_id=s.id AND b.status IN ('draft','submitted')) AS open_status
       FROM product_style s ORDER BY s.code`)).rows;
}

export async function getStyle(db: Db, userId: string, id: string) {
  await assertCan(db, userId, 'bom.view', ANY);
  const style = (await db.query('SELECT s.*, u.display_name AS creator FROM product_style s LEFT JOIN app_user u ON u.id=s.created_by WHERE s.id=$1', [id])).rows[0];
  if (!style) throw notFound('Style');
  const skus = (await db.query(`SELECT k.id, k.code, k.size, k.colour_code, i.id AS item_id, i.status FROM sku k JOIN item i ON i.id=k.item_id WHERE k.style_id=$1 ORDER BY k.colour_code, k.code`, [id])).rows;
  const boms = (await db.query(
    `SELECT b.id, b.version, b.status, b.created_at, b.approved_at, b.effective_from, b.return_reason, cu.display_name AS creator, au.display_name AS approver,
            (SELECT count(*) FROM bom_line l WHERE l.bom_id=b.id)::int AS n_lines
       FROM bom b LEFT JOIN app_user cu ON cu.id=b.created_by LEFT JOIN app_user au ON au.id=b.approved_by WHERE b.style_id=$1 ORDER BY b.version DESC`, [id])).rows;
  return { style, skus, boms };
}

export async function getBom(db: Db, userId: string, id: string) {
  await assertCan(db, userId, 'bom.view', ANY);
  const bom = (await db.query(
    `SELECT b.*, cu.display_name AS creator, au.display_name AS approver, su.display_name AS submitter FROM bom b LEFT JOIN app_user cu ON cu.id=b.created_by LEFT JOIN app_user au ON au.id=b.approved_by LEFT JOIN app_user su ON su.id=b.submitted_by WHERE b.id=$1`, [id])).rows[0];
  if (!bom) throw notFound('BOM');
  const lines = (await db.query(
    `SELECT l.*, qty::text AS qty_t, i.code AS item_code, i.name AS item_name, i.kind AS item_kind FROM bom_line l JOIN item i ON i.id=l.item_id WHERE l.bom_id=$1 ORDER BY l.line_no`, [id])).rows;
  const history = (await db.query(`SELECT a.at, a.action, a.reason, u.display_name AS who FROM audit_log a LEFT JOIN app_user u ON u.id=a.actor_id WHERE a.entity_type='bom' AND a.entity_id=$1 ORDER BY a.id DESC LIMIT 15`, [id])).rows;
  return { bom, lines, history };
}

type BomLineRow = { id: string; line_no: number; section: string; item_id: string; qty: string; unit: string; wastage_pct: string; sizes: string[] | null; colours: string[] | null; qty_by_size: Record<string, string>; note: string | null };
export const applies = (l: Pick<BomLineRow, 'sizes' | 'colours'>, size: string, colour: string) => (!l.sizes?.length || l.sizes.includes(size)) && (!l.colours?.length || l.colours.includes(colour));
export const lineQty = (l: Pick<BomLineRow, 'qty' | 'qty_by_size' | 'wastage_pct'>, size: string) => {
  const base = l.qty_by_size && l.qty_by_size[size] != null ? num(l.qty_by_size[size]) : num(l.qty);
  return { net: r4(base), gross: r4(base * (1 + num(l.wastage_pct) / 100)) };
};

/** The cheapest approved price that is in force today for each material. */
async function bestRates(db: Db, itemIds: string[]) {
  if (!itemIds.length) return new Map<string, number>();
  const r = await db.query(`SELECT item_id, min(rate)::text AS rate FROM rate WHERE item_id = ANY($1::uuid[]) AND status IN ('approved','superseded') AND effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE) GROUP BY item_id`, [itemIds]);
  return new Map<string, number>(r.rows.map((x) => [x.item_id as string, num(x.rate)]));
}

/** What one piece of one SKU needs, with the cost of the materials that have an approved price. */
export async function skuBom(db: Db, userId: string, i: { bomId: string; skuId: string }) {
  await assertCan(db, userId, 'bom.view', ANY);
  const b = (await db.query('SELECT * FROM bom WHERE id=$1', [i.bomId])).rows[0]; if (!b) throw notFound('BOM');
  const k = (await db.query('SELECT * FROM sku WHERE id=$1 AND style_id=$2', [i.skuId, b.style_id])).rows[0]; if (!k) throw notFound('SKU');
  const lines = (await db.query(`SELECT l.*, i.code AS item_code, i.name AS item_name FROM bom_line l JOIN item i ON i.id=l.item_id WHERE l.bom_id=$1 ORDER BY l.line_no`, [i.bomId])).rows as (BomLineRow & { item_code: string; item_name: string })[];
  const rates = await bestRates(db, lines.map((l) => l.item_id));
  const out = lines.filter((l) => applies(l, k.size, k.colour_code)).map((l) => {
    const q = lineQty(l, k.size); const rate = rates.get(l.item_id) ?? null;
    return { line_no: l.line_no, section: l.section, item_id: l.item_id, item_code: l.item_code, item_name: l.item_name, unit: l.unit, net: q.net, wastage_pct: num(l.wastage_pct), gross: q.gross, rate, cost: rate == null ? null : r2(q.gross * rate), size_specific: l.qty_by_size?.[k.size] != null, note: l.note };
  });
  return { sku: k, lines: out, cost: r2(out.reduce((a, l) => a + (l.cost ?? 0), 0)), unpriced: out.filter((l) => l.cost == null).length };
}

/** Every SKU at a glance: how many materials and what they cost per piece. Also flags SKUs the BOM does not cover. */
export async function bomOverview(db: Db, userId: string, bomId: string) {
  await assertCan(db, userId, 'bom.view', ANY);
  const b = (await db.query('SELECT * FROM bom WHERE id=$1', [bomId])).rows[0]; if (!b) throw notFound('BOM');
  const skus = (await db.query('SELECT * FROM sku WHERE style_id=$1 ORDER BY colour_code, code', [b.style_id])).rows;
  const lines = (await db.query('SELECT * FROM bom_line WHERE bom_id=$1', [bomId])).rows as BomLineRow[];
  const rates = await bestRates(db, lines.map((l) => l.item_id));
  return skus.map((k) => {
    const mine = lines.filter((l) => applies(l, k.size, k.colour_code));
    const cost = mine.reduce((a, l) => a + (rates.has(l.item_id) ? lineQty(l, k.size).gross * rates.get(l.item_id)! : 0), 0);
    return { id: k.id, code: k.code, size: k.size, colour: k.colour_code, lines: mine.length, cost: r2(cost), unpriced: mine.filter((l) => !rates.has(l.item_id)).length };
  });
}

/** Total materials for a production plan (pieces per SKU) against what is in stock and already on order. */
export async function requirements(db: Db, userId: string, i: { bomId: string; plan: { skuId: string; qty: number }[] }) {
  await assertCan(db, userId, 'bom.view', ANY);
  const b = (await db.query('SELECT * FROM bom WHERE id=$1', [i.bomId])).rows[0]; if (!b) throw notFound('BOM');
  const plan = i.plan.filter((p) => p.qty > 0);
  if (!plan.length) throw badRequest('Enter how many pieces of at least one SKU');
  if (plan.some((p) => !Number.isFinite(p.qty) || p.qty > 10_000_000)) throw badRequest('Pieces: a positive number');
  const skus = (await db.query('SELECT * FROM sku WHERE style_id=$1', [b.style_id])).rows;
  const lines = (await db.query(`SELECT l.*, i.code AS item_code, i.name AS item_name FROM bom_line l JOIN item i ON i.id=l.item_id WHERE l.bom_id=$1`, [i.bomId])).rows as (BomLineRow & { item_code: string; item_name: string })[];
  const need = new Map<string, { item_id: string; code: string; name: string; unit: string; section: string; required: number; skus: Set<string> }>();
  let pieces = 0;
  for (const p of plan) {
    const k = skus.find((x) => x.id === p.skuId); if (!k) throw notFound('SKU');
    pieces += p.qty;
    for (const l of lines.filter((x) => applies(x, k.size, k.colour_code))) {
      const e = need.get(l.item_id) ?? { item_id: l.item_id, code: l.item_code, name: l.item_name, unit: l.unit, section: l.section, required: 0, skus: new Set<string>() };
      e.required += lineQty(l, k.size).gross * p.qty; e.skus.add(k.code); need.set(l.item_id, e);
    }
  }
  const ids = [...need.keys()];
  const sites = await visibleSites(db, userId, 'inventory.view');
  const stock = new Map<string, number>((await db.query(
    `SELECT lot.item_id, sum(sl.qty)::text AS q FROM stock_ledger sl JOIN lot ON lot.id=sl.lot_id WHERE sl.status='ACCEPTED' AND lot.item_id = ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR lot.site_id = ANY($2::uuid[])) GROUP BY 1`, [ids, sites])).rows.map((r) => [r.item_id as string, num(r.q)]));
  const onOrder = new Map<string, number>((await db.query(
    `SELECT pl.item_id, sum(pl.qty - pl.received_qty)::text AS q FROM po_line pl JOIN purchase_order p ON p.id=pl.po_id WHERE p.status IN ('approved','released','acknowledged','partial_receipt') AND pl.item_id = ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR p.site_id = ANY($2::uuid[])) GROUP BY 1`, [ids, sites])).rows.map((r) => [r.item_id as string, num(r.q)]));
  const rates = await bestRates(db, ids);
  const rows = [...need.values()].map((e) => {
    const required = r4(e.required), have = r4(stock.get(e.item_id) ?? 0), ordered = r4(onOrder.get(e.item_id) ?? 0);
    const short = Math.max(0, r4(required - have - ordered)); const rate = rates.get(e.item_id) ?? null;
    return { item_id: e.item_id, code: e.code, name: e.name, unit: e.unit, section: e.section, required, in_stock: have, on_order: ordered, short, rate, buy_cost: rate == null ? null : r2(short * rate), used_by: e.skus.size };
  }).sort((a, b) => SECTIONS.indexOf(a.section as Section) - SECTIONS.indexOf(b.section as Section) || a.code.localeCompare(b.code));
  return { pieces, rows, short_items: rows.filter((r) => r.short > 0).length, buy_cost: r2(rows.reduce((a, r) => a + (r.buy_cost ?? 0), 0)) };
}

// ───────────────────────── BOM versions ─────────────────────────
async function loadBom(db: Db, id: string, rev?: number) {
  const b = (await db.query('SELECT * FROM bom WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!b) throw notFound('BOM');
  if (rev !== undefined && b.rev !== rev) throw staleVersion(rev, b.rev);
  return b;
}

/** Start a new version (a copy of the active one, or of another version). Only one version is edited at a time. */
export async function startBom(ctx: Ctx, i: { styleId: string; copyFromBomId?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'bom.create', ANY);
  const s = (await ctx.db.query('SELECT * FROM product_style WHERE id=$1 FOR UPDATE', [i.styleId])).rows[0];
  if (!s) throw notFound('Style');
  const open = (await ctx.db.query(`SELECT version FROM bom WHERE style_id=$1 AND status IN ('draft','submitted')`, [s.id])).rows[0];
  if (open) throw invalidState(`Version ${open.version} is already being worked on. Finish or discard it first`);
  const from = i.copyFromBomId ? (await ctx.db.query('SELECT * FROM bom WHERE id=$1 AND style_id=$2', [i.copyFromBomId, s.id])).rows[0]
    : (await ctx.db.query(`SELECT * FROM bom WHERE style_id=$1 ORDER BY (status='active') DESC, version DESC LIMIT 1`, [s.id])).rows[0];
  if (i.copyFromBomId && !from) throw notFound('BOM to copy');
  const version = ((await ctx.db.query('SELECT max(version) AS v FROM bom WHERE style_id=$1', [s.id])).rows[0].v ?? 0) + 1;
  const b = (await ctx.db.query(`INSERT INTO bom(style_id, version, created_by, notes) VALUES ($1,$2,$3,$4) RETURNING *`, [s.id, version, ctx.actor.id, from ? `Copy of version ${from.version}` : null])).rows[0];
  if (from) await ctx.db.query(`INSERT INTO bom_line(bom_id,line_no,section,item_id,qty,unit,wastage_pct,sizes,colours,qty_by_size,note) SELECT $1,line_no,section,item_id,qty,unit,wastage_pct,sizes,colours,qty_by_size,note FROM bom_line WHERE bom_id=$2`, [b.id, from.id]);
  await audit(ctx, { action: 'bom.start', entityType: 'bom', entityId: b.id, after: { style: s.code, version, copiedFrom: from?.version ?? null } });
  return b;
}

/** Replace the lines of a draft. Checks every size, colour and material, and refuses the same material twice for the same size and colour. */
export async function saveBomLines(ctx: Ctx, i: { bomId: string; expectedRev: number; lines: LineInput[]; notes?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'bom.create', ANY);
  const b = await loadBom(ctx.db, i.bomId, i.expectedRev);
  if (b.status !== 'draft') throw invalidState(`This version is ${b.status}. Start a new version to change the materials`);
  if (b.created_by !== ctx.actor.id) throw forbidden('Only the person who started this version can change it');
  const s = (await ctx.db.query('SELECT * FROM product_style WHERE id=$1', [b.style_id])).rows[0];
  const sizes = s.sizes as string[]; const colourCodes = (s.colours as Colour[]).map((c) => c.code);
  if (i.lines.length > 100) throw badRequest('A BOM can hold up to 100 lines');
  const own = new Set((await ctx.db.query('SELECT item_id FROM sku WHERE style_id=$1', [s.id])).rows.map((r) => r.item_id as string));
  const rows: { l: LineInput; unit: string; sizes: string[] | null; colours: string[] | null; qbs: Record<string, string> }[] = [];
  for (const [n, l] of i.lines.entries()) {
    const at = `Line ${n + 1}`;
    if (!SECTIONS.includes(l.section)) throw badRequest(`${at}: pick a section`);
    const it = (await ctx.db.query('SELECT id, code, kind, status, stock_unit FROM item WHERE id=$1', [l.itemId])).rows[0];
    if (!it) throw notFound(`${at}: material`);
    if (it.status !== 'active') throw invalidState(`${at}: ${it.code} is ${it.status}; only approved materials can go in a BOM`);
    if (it.kind === 'FG' || own.has(it.id)) throw badRequest(`${at}: ${it.code} is a finished garment, not a material`);
    if (!NUM.test(String(l.qty ?? '').trim()) || num(l.qty) <= 0) throw badRequest(`${at}: quantity per piece must be a positive number`);
    if (l.wastagePct && (!NUM.test(l.wastagePct) || num(l.wastagePct) > 100)) throw badRequest(`${at}: wastage is 0 to 100 %`);
    const sz = l.sizes?.length ? l.sizes : null, co = l.colours?.length ? l.colours : null;
    if (sz && sz.some((x) => !sizes.includes(x))) throw badRequest(`${at}: a size is not in this style`);
    if (co && co.some((x) => !colourCodes.includes(x))) throw badRequest(`${at}: a colour is not in this style`);
    const qbs: Record<string, string> = {};
    for (const [k, v] of Object.entries(l.qtyBySize ?? {})) {
      if (v === '' || v == null) continue;
      if (!sizes.includes(k) || (sz && !sz.includes(k))) throw badRequest(`${at}: quantity given for size ${k}, which this line does not cover`);
      if (!NUM.test(String(v)) || num(v) <= 0) throw badRequest(`${at}: quantity for size ${k} must be a positive number`);
      qbs[k] = String(v);
    }
    rows.push({ l, unit: it.stock_unit, sizes: sz, colours: co, qbs });
  }
  // the same material may not be counted twice for one size and colour
  for (const size of sizes) for (const col of colourCodes.length ? colourCodes : ['']) {
    const seen = new Map<string, number>();
    rows.forEach((r, n) => { if (!applies({ sizes: r.sizes, colours: r.colours }, size, col)) return; if (seen.has(r.l.itemId)) throw badRequest(`Lines ${seen.get(r.l.itemId)! + 1} and ${n + 1} use the same material for size ${size}${col ? ' in ' + col : ''}. Split them by size or colour, or merge them`); seen.set(r.l.itemId, n); });
  }
  await ctx.db.query('DELETE FROM bom_line WHERE bom_id=$1', [b.id]);
  for (const [n, r] of rows.entries())
    await ctx.db.query(`INSERT INTO bom_line(bom_id,line_no,section,item_id,qty,unit,wastage_pct,sizes,colours,qty_by_size,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [b.id, n + 1, r.l.section, r.l.itemId, String(r.l.qty).trim(), r.unit, r.l.wastagePct || '0', r.sizes, r.colours, JSON.stringify(r.qbs), r.l.note?.trim().slice(0, 200) || null]);
  const u = (await ctx.db.query('UPDATE bom SET rev=rev+1, notes=COALESCE($2, notes), return_reason=NULL WHERE id=$1 RETURNING *', [b.id, i.notes ?? null])).rows[0];
  await audit(ctx, { action: 'bom.save', entityType: 'bom', entityId: b.id, after: { lines: rows.length } });
  return u;
}

/** Problems that stop a BOM going for approval. */
export async function checkBom(db: Db, bomId: string) {
  const b = (await db.query('SELECT * FROM bom WHERE id=$1', [bomId])).rows[0]; if (!b) throw notFound('BOM');
  const skus = (await db.query('SELECT * FROM sku WHERE style_id=$1 ORDER BY code', [b.style_id])).rows;
  const lines = (await db.query('SELECT * FROM bom_line WHERE bom_id=$1', [bomId])).rows as BomLineRow[];
  const problems: string[] = [];
  if (!skus.length) problems.push('The style has no SKUs yet. Create the sizes and colours first');
  if (!lines.length) problems.push('The BOM has no materials');
  const bare = skus.filter((k) => !lines.some((l) => applies(l, k.size, k.colour_code)));
  if (lines.length && bare.length) problems.push(`${bare.length} SKU${bare.length === 1 ? '' : 's'} would get no materials: ${bare.slice(0, 4).map((k) => k.code).join(', ')}${bare.length > 4 ? '…' : ''}`);
  const noFabric = skus.filter((k) => lines.length && !lines.some((l) => l.section === 'FABRIC' && applies(l, k.size, k.colour_code)));
  const warnings = noFabric.length ? [`${noFabric.length} SKU${noFabric.length === 1 ? ' has' : 's have'} no fabric line (${noFabric.slice(0, 3).map((k) => k.code).join(', ')}${noFabric.length > 3 ? '…' : ''}). Fine for accessories, check it is intended`] : [];
  return { problems, warnings };
}

export async function submitBom(ctx: Ctx, i: { bomId: string; expectedRev: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'bom.create', ANY);
  const b = await loadBom(ctx.db, i.bomId, i.expectedRev);
  if (b.status !== 'draft') throw invalidState(`This version is ${b.status}`);
  if (b.created_by !== ctx.actor.id) throw forbidden('Only the person who started this version can send it');
  const c = await checkBom(ctx.db, b.id);
  if (c.problems.length) throw badRequest(c.problems[0]);
  const u = (await ctx.db.query(`UPDATE bom SET status='submitted', submitted_by=$2, rev=rev+1 WHERE id=$1 RETURNING *`, [b.id, ctx.actor.id])).rows[0];
  await audit(ctx, { action: 'bom.submit', entityType: 'bom', entityId: b.id });
  return u;
}

export async function returnBom(ctx: Ctx, i: { bomId: string; expectedRev: number; reason: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'bom.approve', ANY);
  if (!i.reason?.trim()) throw badRequest('Say what needs changing');
  const b = await loadBom(ctx.db, i.bomId, i.expectedRev);
  if (b.status !== 'submitted') throw invalidState('Only a version waiting for approval can be sent back');
  const u = (await ctx.db.query(`UPDATE bom SET status='draft', return_reason=$2, rev=rev+1 WHERE id=$1 RETURNING *`, [b.id, i.reason.trim()])).rows[0];
  await audit(ctx, { action: 'bom.return', entityType: 'bom', entityId: b.id, reason: i.reason.trim() });
  return u;
}

/** A different person approves. The new version becomes the active one and the SKUs become usable items. */
export async function approveBom(ctx: Ctx, i: { bomId: string; expectedRev: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'bom.approve', ANY);
  const b = await loadBom(ctx.db, i.bomId, i.expectedRev);
  if (b.status !== 'submitted') throw invalidState(`This version is ${b.status}, not waiting for approval`);
  assertIndependent(ctx.actor.id, b.created_by, 'BOM');
  assertIndependent(ctx.actor.id, b.submitted_by, 'BOM');
  const c = await checkBom(ctx.db, b.id);
  if (c.problems.length) throw badRequest(c.problems[0]);
  await ctx.db.query(`UPDATE bom SET status='superseded' WHERE style_id=$1 AND status='active'`, [b.style_id]);
  const u = (await ctx.db.query(`UPDATE bom SET status='active', approved_by=$2, approved_at=now(), effective_from=CURRENT_DATE, rev=rev+1 WHERE id=$1 RETURNING *`, [b.id, ctx.actor.id])).rows[0];
  const act = await ctx.db.query(`UPDATE item SET status='active', approved_by=$2, version=version+1 WHERE status='draft' AND id IN (SELECT item_id FROM sku WHERE style_id=$1) RETURNING id`, [b.style_id, ctx.actor.id]);
  await audit(ctx, { action: 'bom.approve', entityType: 'bom', entityId: b.id, after: { version: b.version, skusActivated: act.rowCount } });
  return u;
}

export async function discardBom(ctx: Ctx, i: { bomId: string; expectedRev: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'bom.create', ANY);
  const b = await loadBom(ctx.db, i.bomId, i.expectedRev);
  if (b.status !== 'draft') throw invalidState('Only a draft can be discarded');
  if (b.created_by !== ctx.actor.id) throw forbidden('Only the person who started this version can discard it');
  await ctx.db.query('DELETE FROM bom_line WHERE bom_id=$1', [b.id]);
  await ctx.db.query('DELETE FROM bom WHERE id=$1', [b.id]);
  await audit(ctx, { action: 'bom.discard', entityType: 'bom', entityId: b.id, before: { version: b.version } });
}

// ───────────────────────── packs (the final box) ─────────────────────────
export type PackInput = { code: string; name: string; notes?: string; skus: { skuId: string; qty: number }[]; materials?: { itemId: string; qty: string }[] };

/** Make a pack: one sellable box item holding several SKUs, with its packing materials. */
export async function createPack(ctx: Ctx, i: PackInput) {
  await assertCan(ctx.db, ctx.actor.id, 'bom.create', ANY);
  const code = (i.code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(code)) throw badRequest('Pack code: 2 to 32 capital letters, digits or dashes, like BRF-01-3PK');
  if (!i.name?.trim()) throw badRequest('Give the pack a name');
  if (!i.skus?.length) throw badRequest('Add at least one SKU to the pack');
  if (i.skus.length > 60) throw badRequest('Up to 60 SKUs in one pack');
  const seen = new Set<string>();
  for (const [n, l] of i.skus.entries()) {
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 1000) throw badRequest(`SKU line ${n + 1}: quantity must be a whole number from 1 to 1000`);
    if (seen.has(l.skuId)) throw badRequest(`SKU line ${n + 1}: the same SKU is listed twice. Raise its quantity instead`); seen.add(l.skuId);
    if (!(await ctx.db.query('SELECT 1 FROM sku WHERE id=$1', [l.skuId])).rowCount) throw notFound(`SKU on line ${n + 1}`);
  }
  const mats = i.materials ?? []; const ms = new Set<string>();
  for (const [n, m] of mats.entries()) {
    if (!NUM.test(m.qty) || num(m.qty) <= 0) throw badRequest(`Material ${n + 1}: enter a quantity above zero`);
    if (ms.has(m.itemId)) throw badRequest(`Material ${n + 1} is listed twice`); ms.add(m.itemId);
    const it = (await ctx.db.query('SELECT kind, status FROM item WHERE id=$1', [m.itemId])).rows[0];
    if (!it) throw notFound(`Material ${n + 1}`);
    if (it.kind !== 'PACKING') throw badRequest(`Material ${n + 1}: only packing materials go into a pack`);
    if (it.status !== 'active') throw badRequest(`Material ${n + 1} is not approved yet`);
  }
  if ((await ctx.db.query('SELECT 1 FROM sku_pack WHERE code=$1', [code])).rowCount || (await ctx.db.query('SELECT 1 FROM item WHERE code=$1', [code])).rowCount) throw badRequest(`The code ${code} is already used`);
  const first = (await ctx.db.query('SELECT s.style_id, st.hsn_code, st.gst_rate FROM sku s JOIN product_style st ON st.id=s.style_id WHERE s.id=$1', [i.skus[0].skuId])).rows[0];
  const type = (await ctx.db.query(`SELECT id FROM material_type WHERE kind='FG' AND status='active' ORDER BY code LIMIT 1`)).rows[0];
  const pieces = i.skus.reduce((a, l) => a + l.qty, 0);
  const item = (await ctx.db.query(
    `INSERT INTO item(code,name,kind,stock_unit,tracking,status,attributes,created_by,approved_by,material_type_id,hsn_code,gst_rate)
     VALUES ($1,$2,'FG','PC','LOT','active',$3,$4,$4,$5,$6,$7) RETURNING id`,
    [code, i.name.trim(), JSON.stringify({ pack: true, pieces }), ctx.actor.id, type?.id ?? null, first.hsn_code, first.gst_rate])).rows[0];
  const p = (await ctx.db.query(`INSERT INTO sku_pack(code,name,item_id,notes,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [code, i.name.trim(), item.id, i.notes?.trim() || null, ctx.actor.id])).rows[0];
  for (const l of i.skus) await ctx.db.query(`INSERT INTO sku_pack_line(pack_id,kind,sku_id,qty) VALUES ($1,'SKU',$2,$3)`, [p.id, l.skuId, l.qty]);
  for (const m of mats) await ctx.db.query(`INSERT INTO sku_pack_line(pack_id,kind,item_id,qty) VALUES ($1,'MATERIAL',$2,$3)`, [p.id, m.itemId, m.qty]);
  await audit(ctx, { action: 'pack.create', entityType: 'sku_pack', entityId: p.id, after: { code, pieces, skus: i.skus.length, materials: mats.length } });
  return { ...p, pieces };
}

export async function listPacks(db: Db, userId: string) {
  await assertCan(db, userId, 'bom.view', ANY);
  return (await db.query(
    `SELECT p.id, p.code, p.name, p.notes, p.status,
            COALESCE((SELECT sum(qty) FROM sku_pack_line WHERE pack_id=p.id AND kind='SKU'),0)::int AS pieces,
            (SELECT count(*) FROM sku_pack_line WHERE pack_id=p.id AND kind='SKU')::int AS sku_lines,
            COALESCE((SELECT json_agg(json_build_object('kind',l.kind,'code',COALESCE(s.code,i.code),'name',COALESCE(si.name,i.name),'qty',l.qty) ORDER BY l.kind DESC, COALESCE(s.code,i.code))
                      FROM sku_pack_line l LEFT JOIN sku s ON s.id=l.sku_id LEFT JOIN item si ON si.id=s.item_id LEFT JOIN item i ON i.id=l.item_id WHERE l.pack_id=p.id),'[]') AS lines
       FROM sku_pack p ORDER BY p.code`)).rows;
}

export async function setPackStatus(ctx: Ctx, i: { packId: string; status: 'active' | 'inactive' }) {
  await assertCan(ctx.db, ctx.actor.id, 'bom.create', ANY);
  const r = (await ctx.db.query('UPDATE sku_pack SET status=$2 WHERE id=$1 RETURNING id, code', [i.packId, i.status])).rows[0];
  if (!r) throw notFound('Pack');
  await ctx.db.query('UPDATE item SET status=$2 WHERE id=(SELECT item_id FROM sku_pack WHERE id=$1)', [i.packId, i.status === 'active' ? 'active' : 'inactive']);
  await audit(ctx, { action: 'pack.status', entityType: 'sku_pack', entityId: r.id, after: { status: i.status } });
  return r;
}
