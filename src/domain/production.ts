// Work orders: the factory floor between buying and selling.
//   Finishing: grey fabric goes out (to your own unit or a job-work vendor) and finished fabric comes back, less the loss. It goes to quality control.
//   Shade lots: after quality control a roll can be split into lots of one shade, so each colour is cut from fabric that matches.
//   Cutting: fabric and trims are issued from stock by the BOM (more fabric than the pieces need, because cutting wastes some), and the pieces
//   that come out, per SKU, usually fall short of plan because sizes share fabric. They go to quality control, then into stock that can be sold.
import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan, visibleSites } from '../core/permissions.js';
import { audit } from '../core/audit.js';
import { nextNumber } from '../core/numbering.js';
import { badRequest, conflict, invalidState, notFound, staleVersion } from '../core/errors.js';
import { qAdd, qGt, qLt, qSub, toScaled, fromScaled } from '../core/qty.js';
import { availability, postMovement, type Leg } from './inventory.js';
import { applies, lineQty } from './bom.js';

const PAD = (s: string) => s.replace(/\.?0+$/, '') || '0';
const q4 = (n: number) => n.toFixed(4);

async function receivingLocation(ctx: Ctx, siteId: string) {
  const ls = (await ctx.db.query(`SELECT id FROM location WHERE site_id=$1 AND kind='RECEIVING'`, [siteId])).rows;
  if (ls.length !== 1) throw invalidState(ls.length ? 'Several receiving locations exist; choose one' : 'This site has no receiving location configured');
  return ls[0].id as string;
}
async function loadWo(db: Db, id: string, expectedVersion?: number) {
  const w = (await db.query('SELECT * FROM work_order WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!w) throw notFound('Work order');
  if (expectedVersion !== undefined && w.version !== expectedVersion) throw staleVersion(expectedVersion, w.version);
  return w;
}
const bump = (ctx: Ctx, id: string, set: string, args: unknown[] = []) => ctx.db.query(`UPDATE work_order SET ${set}, version=version+1 WHERE id=$1 RETURNING *`, [id, ...args]).then((r) => r.rows[0]);

/** Take quantity out of one lot's accepted stock, from whichever places hold it. */
async function legsOut(db: Db, lot: { id: string; site_id: string; item_id: string }, unit: string, want: string): Promise<Leg[]> {
  const buckets = (await db.query(`SELECT location_id, SUM(qty)::text AS q FROM stock_ledger WHERE lot_id=$1 AND status='ACCEPTED' GROUP BY location_id HAVING SUM(qty) > 0 ORDER BY SUM(qty) DESC`, [lot.id])).rows;
  const legs: Leg[] = []; let left = want;
  for (const b of buckets) {
    if (!qGt(left, '0')) break;
    const take = qGt(b.q, left) ? left : b.q;
    legs.push({ siteId: lot.site_id, lotId: lot.id, itemId: lot.item_id, locationId: b.location_id, status: 'ACCEPTED', qty: qSub('0', take), unit });
    left = qSub(left, take);
  }
  return legs;
}

// ───────────────────────── finishing ─────────────────────────
export async function createFinishOrder(ctx: Ctx, i: { lotId: string; qty: string; outItemId: string; processorId?: string | null; finishName: string; colour?: string; notes?: string }) {
  const lot = (await ctx.db.query('SELECT l.*, it.kind, it.stock_unit, it.code FROM lot l JOIN item it ON it.id=l.item_id WHERE l.id=$1', [i.lotId])).rows[0];
  if (!lot) throw notFound('Roll or lot');
  await assertCan(ctx.db, ctx.actor.id, 'production.create', { siteId: lot.site_id });
  if (!/^\d+(\.\d{1,4})?$/.test(i.qty) || !qGt(i.qty, '0')) throw badRequest('Quantity: a number above zero');
  if (!i.finishName?.trim()) throw badRequest('Say which finish this is (for example dyed navy, or peach finish)');
  if (lot.kind !== 'FABRIC') throw badRequest('Only fabric goes for finishing');
  const out = (await ctx.db.query('SELECT id, kind, status, stock_unit FROM item WHERE id=$1', [i.outItemId])).rows[0];
  if (!out) throw notFound('Finished fabric');
  if (out.kind !== 'FABRIC' || out.status !== 'active') throw badRequest('The finished fabric must be an approved fabric');
  if (out.id === lot.item_id) throw badRequest('The finished fabric must be a different item from the grey fabric');
  if (out.stock_unit !== lot.stock_unit) throw badRequest(`Grey fabric is counted in ${lot.stock_unit} but the finished fabric in ${out.stock_unit}`);
  if (i.processorId && !(await ctx.db.query(`SELECT 1 FROM partner WHERE id=$1 AND is_vendor AND status='active'`, [i.processorId])).rowCount) throw badRequest('Pick an approved vendor for the job work, or leave it empty for your own unit');
  const a = await availability(ctx.db, lot.id);
  const others = (await ctx.db.query(`SELECT COALESCE(sum(l.planned_qty),0)::text AS q FROM work_order_line l JOIN work_order w ON w.id=l.wo_id WHERE l.lot_id=$1 AND l.role='input' AND w.status='draft'`, [lot.id])).rows[0].q;
  if (qGt(i.qty, qSub(a.available, others))) throw conflict('INSUFFICIENT_AVAILABLE', `Only ${qSub(a.available, others)} ${lot.stock_unit} of this roll is free (not reserved or promised to another finishing order)`, { available: qSub(a.available, others) });
  const number = await nextNumber(ctx, lot.site_id, 'WO');
  const wo = (await ctx.db.query(`INSERT INTO work_order(site_id, number, kind, out_item_id, processor_id, finish_name, colour, notes, created_by) VALUES ($1,$2,'finish',$3,$4,$5,$6,$7,$8) RETURNING *`,
    [lot.site_id, number, i.outItemId, i.processorId || null, i.finishName.trim(), i.colour?.trim().toUpperCase() || null, i.notes?.trim() || null, ctx.actor.id])).rows[0];
  await ctx.db.query(`INSERT INTO work_order_line(wo_id, line_no, role, item_id, lot_id, planned_qty, unit) VALUES ($1,1,'input',$2,$3,$4,$5)`, [wo.id, lot.item_id, lot.id, i.qty, lot.stock_unit]);
  await audit(ctx, { action: 'wo.create', entityType: 'work_order', entityId: wo.id, after: { number, kind: 'finish', qty: i.qty, finish: i.finishName } });
  return wo;
}

/** Grey fabric leaves the store. From here it is work in progress until the finished fabric comes back. */
export async function issueFinish(ctx: Ctx, i: { woId: string; expectedVersion: number }) {
  const w = await loadWo(ctx.db, i.woId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'production.issue', { siteId: w.site_id });
  if (w.kind !== 'finish') throw invalidState('This is not a finishing order');
  if (w.status !== 'draft') throw invalidState(`This order is ${w.status}`);
  const ln = (await ctx.db.query(`SELECT * FROM work_order_line WHERE wo_id=$1 AND role='input'`, [w.id])).rows[0];
  const lot = (await ctx.db.query('SELECT * FROM lot WHERE id=$1', [ln.lot_id])).rows[0];
  const legs = await legsOut(ctx.db, lot, ln.unit, String(ln.planned_qty));
  if (legs.reduce((a, l) => qAdd(a, qSub('0', l.qty)), '0') !== q4(Number(ln.planned_qty))) throw conflict('INSUFFICIENT_STOCK', 'The roll no longer has that much accepted stock');
  await postMovement(ctx, { type: 'ISSUE_FINISH', sourceType: 'work_order', sourceId: w.id, legs });
  await ctx.db.query('INSERT INTO work_order_issue(wo_id, lot_id, item_id, qty) VALUES ($1,$2,$3,$4)', [w.id, lot.id, lot.item_id, ln.planned_qty]);
  const r = await bump(ctx, w.id, `status='issued', issued_by=$2, issued_at=now()`, [ctx.actor.id]);
  await audit(ctx, { action: 'wo.issue', entityType: 'work_order', entityId: w.id, after: { qty: ln.planned_qty } });
  return r;
}

/** The finished fabric comes back. It is held for quality control, and the loss is the difference. */
export async function receiveFinish(ctx: Ctx, i: { woId: string; expectedVersion: number; qty: string }) {
  const w = await loadWo(ctx.db, i.woId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'production.complete', { siteId: w.site_id });
  if (w.kind !== 'finish') throw invalidState('This is not a finishing order');
  if (w.status !== 'issued') throw invalidState(w.status === 'draft' ? 'Issue the grey fabric first' : `This order is ${w.status}`);
  if (!/^\d+(\.\d{1,4})?$/.test(i.qty) || !qGt(i.qty, '0')) throw badRequest('Quantity received: a number above zero');
  const inp = (await ctx.db.query(`SELECT * FROM work_order_line WHERE wo_id=$1 AND role='input'`, [w.id])).rows[0];
  if (qGt(i.qty, String(inp.planned_qty))) throw badRequest(`Finishing cannot return more than the ${PAD(String(inp.planned_qty))} ${inp.unit} that went out`);
  const grey = (await ctx.db.query('SELECT label, attributes FROM lot WHERE id=$1', [inp.lot_id])).rows[0];
  const out = (await ctx.db.query('SELECT id, stock_unit FROM item WHERE id=$1', [w.out_item_id])).rows[0];
  const label = `${w.number}/F`;
  const lot = (await ctx.db.query(`INSERT INTO lot(site_id, item_id, label, parent_lot_id, attributes) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [w.site_id, out.id, label, inp.lot_id, JSON.stringify({ ...(grey.attributes ?? {}), colour: w.colour ?? undefined, finish: w.finish_name, greyLot: grey.label })])).rows[0];
  const loc = await receivingLocation(ctx, w.site_id);
  await postMovement(ctx, { type: 'RECEIPT_FINISH', sourceType: 'work_order', sourceId: w.id, legs: [{ siteId: w.site_id, lotId: lot.id, itemId: out.id, locationId: loc, status: 'HOLD', qty: i.qty, unit: out.stock_unit }] });
  const insp = (await ctx.db.query(`INSERT INTO qc_inspection(site_id, lot_id, source_work_order_id, source_qty, source_item_id, source_unit) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [w.site_id, lot.id, w.id, i.qty, out.id, out.stock_unit])).rows[0];
  await ctx.db.query(`INSERT INTO work_order_line(wo_id, line_no, role, item_id, lot_id, planned_qty, actual_qty, unit) VALUES ($1,2,'output',$2,$3,$4,$5,$6)`, [w.id, out.id, lot.id, inp.planned_qty, i.qty, out.stock_unit]);
  const r = await bump(ctx, w.id, `status='completed', completed_by=$2, completed_at=now()`, [ctx.actor.id]);
  const loss = qSub(String(inp.planned_qty), i.qty);
  await audit(ctx, { action: 'wo.receive', entityType: 'work_order', entityId: w.id, after: { received: i.qty, loss, lot: label } });
  return { ...r, lotId: lot.id, lotLabel: label, inspectionId: insp.id, loss, lossPct: Math.round((Number(loss) / Number(inp.planned_qty)) * 10000) / 100 };
}

// ───────────────────────── shade lots ─────────────────────────
/** Split accepted fabric into lots of one shade each, so a colour is cut from fabric that matches. The parts need not use the whole roll. */
export async function splitLot(ctx: Ctx, i: { lotId: string; parts: { qty: string; shade: string; colour?: string }[] }) {
  const lot = (await ctx.db.query('SELECT l.*, it.stock_unit FROM lot l JOIN item it ON it.id=l.item_id WHERE l.id=$1 FOR UPDATE OF l', [i.lotId])).rows[0];
  if (!lot) throw notFound('Roll or lot');
  await assertCan(ctx.db, ctx.actor.id, 'production.complete', { siteId: lot.site_id });
  if (!i.parts?.length || i.parts.length > 12) throw badRequest('Split into 1 to 12 parts');
  let total = '0';
  for (const [n, p] of i.parts.entries()) {
    if (!p.shade?.trim()) throw badRequest(`Part ${n + 1}: name the shade, like A or LIGHT`);
    if (!/^\d+(\.\d{1,4})?$/.test(p.qty) || !qGt(p.qty, '0')) throw badRequest(`Part ${n + 1}: quantity above zero`);
    total = qAdd(total, p.qty);
  }
  const a = await availability(ctx.db, lot.id);
  if (qGt(total, a.available)) throw conflict('INSUFFICIENT_AVAILABLE', `Only ${a.available} ${lot.stock_unit} of this lot is free to split`, { available: a.available });
  const made: { lotId: string; label: string; qty: string; shade: string }[] = [];
  for (const [n, p] of i.parts.entries()) {
    const shade = p.shade.trim().toUpperCase();
    const label = `${lot.label}-${shade}${i.parts.filter((x, k) => k < n && x.shade.trim().toUpperCase() === shade).length ? n + 1 : ''}`;
    if ((await ctx.db.query('SELECT 1 FROM lot WHERE label=$1', [label])).rowCount) throw badRequest(`A lot called ${label} already exists. Use a different shade name`);
    const child = (await ctx.db.query(`INSERT INTO lot(site_id, item_id, label, parent_lot_id, attributes) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [lot.site_id, lot.item_id, label, lot.id, JSON.stringify({ ...(lot.attributes ?? {}), shade, colour: p.colour?.trim().toUpperCase() || lot.attributes?.colour })])).rows[0];
    const out = await legsOut(ctx.db, lot, lot.stock_unit, p.qty);
    const into: Leg[] = out.map((l) => ({ ...l, lotId: child.id, qty: qSub('0', l.qty) }));
    await postMovement(ctx, { type: 'SPLIT', sourceType: 'lot', sourceId: lot.id, legs: [...out, ...into] });
    made.push({ lotId: child.id, label, qty: p.qty, shade });
  }
  await audit(ctx, { action: 'lot.split', entityType: 'lot', entityId: lot.id, after: { parts: made.map((m) => `${m.label} ${m.qty}`) } });
  return { parent: lot.label, lots: made };
}

// ───────────────────────── cutting ─────────────────────────
export async function createCutOrder(ctx: Ctx, i: { siteId: string; styleId: string; lines: { skuId: string; qty: number }[]; notes?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'production.create', { siteId: i.siteId });
  const style = (await ctx.db.query('SELECT id, code FROM product_style WHERE id=$1', [i.styleId])).rows[0];
  if (!style) throw notFound('Style');
  if (!(await ctx.db.query(`SELECT 1 FROM bom WHERE style_id=$1 AND status='active'`, [style.id])).rowCount) throw invalidState(`${style.code} has no approved BOM yet`);
  const lines = (i.lines ?? []).filter((l) => l.qty > 0);
  if (!lines.length) throw badRequest('Enter how many pieces of at least one SKU');
  const seen = new Set<string>();
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty > 1_000_000) throw badRequest('Pieces: whole numbers');
    if (seen.has(l.skuId)) throw badRequest('A SKU is listed twice'); seen.add(l.skuId);
    if (!(await ctx.db.query('SELECT 1 FROM sku WHERE id=$1 AND style_id=$2', [l.skuId, style.id])).rowCount) throw badRequest('A SKU does not belong to this style');
  }
  const number = await nextNumber(ctx, i.siteId, 'WO');
  const wo = (await ctx.db.query(`INSERT INTO work_order(site_id, number, kind, style_id, notes, created_by) VALUES ($1,$2,'cut',$3,$4,$5) RETURNING *`, [i.siteId, number, style.id, i.notes?.trim() || null, ctx.actor.id])).rows[0];
  for (const [n, l] of lines.entries()) {
    const k = (await ctx.db.query('SELECT item_id FROM sku WHERE id=$1', [l.skuId])).rows[0];
    await ctx.db.query(`INSERT INTO work_order_line(wo_id, line_no, role, item_id, sku_id, planned_qty, unit) VALUES ($1,$2,'sku',$3,$4,$5,'PC')`, [wo.id, n + 1, k.item_id, l.skuId, l.qty]);
  }
  await audit(ctx, { action: 'wo.create', entityType: 'work_order', entityId: wo.id, after: { number, kind: 'cut', style: style.code, pieces: lines.reduce((a, l) => a + l.qty, 0) } });
  return wo;
}

type Need = { key: string; itemId: string; code: string; name: string; unit: string; colour: string | null; qty: number };
/** Materials a cutting order will take: the BOM per piece with wastage, fabric divided by the style's cutting yield. */
export async function cutNeeds(db: Db, woId: string): Promise<Need[]> {
  const w = (await db.query('SELECT * FROM work_order WHERE id=$1', [woId])).rows[0]; if (!w) throw notFound('Work order');
  const st = (await db.query('SELECT cutting_yield_pct::float AS y FROM product_style WHERE id=$1', [w.style_id])).rows[0];
  const lines = (await db.query(`SELECT l.*, k.size, k.colour_code FROM work_order_line l JOIN sku k ON k.id=l.sku_id WHERE l.wo_id=$1 AND l.role='sku' ORDER BY l.line_no`, [woId])).rows;
  const bomLines = (await db.query(`SELECT bl.*, i.code, i.name FROM bom_line bl JOIN bom b ON b.id=bl.bom_id JOIN item i ON i.id=bl.item_id WHERE b.style_id=$1 AND b.status='active'`, [w.style_id])).rows;
  const need = new Map<string, Need>();
  for (const l of lines) for (const b of bomLines) if (applies(b, l.size, l.colour_code)) {
    const g = lineQty(b, l.size).gross; const per = b.section === 'FABRIC' ? g / (st.y / 100) : g;
    const colour = b.section === 'FABRIC' ? (l.colour_code as string) : null; const key = `${b.item_id}|${colour ?? ''}`;
    const e = need.get(key) ?? { key, itemId: b.item_id, code: b.code, name: b.name, unit: b.unit, colour, qty: 0 }; e.qty += per * Number(l.planned_qty); need.set(key, e);
  }
  return [...need.values()].map((e) => ({ ...e, qty: Math.ceil(e.qty * 10000) / 10000 })).sort((a, b) => a.code.localeCompare(b.code));
}

/** Free accepted stock of one material, oldest first. Fabric prefers lots already given that colour, then lots with no colour set. */
async function pickLots(db: Db, siteId: string, itemId: string, colour: string | null) {
  const lots = (await db.query(`SELECT l.id, l.site_id, l.item_id, l.label, l.attributes->>'colour' AS colour FROM lot l WHERE l.item_id=$1 AND l.site_id=$2 ORDER BY l.created_at, l.label`, [itemId, siteId])).rows;
  const out: { lot: (typeof lots)[number]; free: string }[] = [];
  for (const l of lots) { const a = await availability(db, l.id); if (qGt(a.available, '0')) out.push({ lot: l, free: a.available }); }
  if (!colour) return out;
  const rank = (c: string | null) => (c === colour ? 0 : c ? 9 : 1);
  return out.filter((x) => rank(x.lot.colour) < 9).sort((a, b) => rank(a.lot.colour) - rank(b.lot.colour));
}

export async function issueCut(ctx: Ctx, i: { woId: string; expectedVersion: number }) {
  const w = await loadWo(ctx.db, i.woId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'production.issue', { siteId: w.site_id });
  if (w.kind !== 'cut') throw invalidState('This is not a cutting order');
  if (w.status !== 'draft') throw invalidState(`This order is ${w.status}`);
  const needs = await cutNeeds(ctx.db, w.id);
  const legs: Leg[] = []; const used: { lot: string; item: string; qty: string; colour: string | null }[] = []; const short: string[] = [];
  const taken = new Map<string, string>();
  for (const n of needs) {
    let left = q4(n.qty);
    for (const c of await pickLots(ctx.db, w.site_id, n.itemId, n.colour)) {
      if (!qGt(left, '0')) break;
      const free = qSub(c.free, taken.get(c.lot.id) ?? '0'); if (!qGt(free, '0')) continue;
      const take = qGt(free, left) ? left : free;
      legs.push(...(await legsOut(ctx.db, c.lot, n.unit, take)));
      taken.set(c.lot.id, qAdd(taken.get(c.lot.id) ?? '0', take)); used.push({ lot: c.lot.id, item: n.itemId, qty: take, colour: n.colour }); left = qSub(left, take);
    }
    if (qGt(left, '0')) short.push(`${n.code}${n.colour ? ' (' + n.colour + ')' : ''}: short by ${PAD(left)} ${n.unit}`);
  }
  if (short.length) throw conflict('INSUFFICIENT_STOCK', `Not enough accepted stock to cut this. ${short.join('; ')}`, { short });
  await postMovement(ctx, { type: 'ISSUE_CUT', sourceType: 'work_order', sourceId: w.id, legs });
  for (const u of used) await ctx.db.query('INSERT INTO work_order_issue(wo_id, lot_id, item_id, qty, colour) VALUES ($1,$2,$3,$4,$5)', [w.id, u.lot, u.item, u.qty, u.colour]);
  const r = await bump(ctx, w.id, `status='issued', issued_by=$2, issued_at=now()`, [ctx.actor.id]);
  await audit(ctx, { action: 'wo.issue', entityType: 'work_order', entityId: w.id, after: { materials: needs.length, lots: used.length } });
  return r;
}

/** Record what the cutters actually got. Each SKU's pieces go to quality control. What was planned but not cut comes back to the plan as a shortfall. */
export async function completeCut(ctx: Ctx, i: { woId: string; expectedVersion: number; actual: { skuId: string; qty: number }[] }) {
  const w = await loadWo(ctx.db, i.woId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'production.complete', { siteId: w.site_id });
  if (w.kind !== 'cut') throw invalidState('This is not a cutting order');
  if (w.status !== 'issued') throw invalidState(w.status === 'draft' ? 'Issue the materials first' : `This order is ${w.status}`);
  const lines = (await ctx.db.query(`SELECT l.*, k.code AS sku_code FROM work_order_line l JOIN sku k ON k.id=l.sku_id WHERE l.wo_id=$1 AND l.role='sku' ORDER BY l.line_no`, [w.id])).rows;
  const loc = await receivingLocation(ctx, w.site_id);
  const got = new Map(i.actual.map((a) => [a.skuId, a.qty]));
  for (const a of i.actual) if (!lines.some((l) => l.sku_id === a.skuId)) throw badRequest('A SKU is not on this order');
  const made: { sku: string; planned: number; actual: number; lotId?: string; inspectionId?: string }[] = [];
  for (const l of lines) {
    const act = got.get(l.sku_id) ?? 0; const planned = Number(l.planned_qty);
    if (!Number.isInteger(act) || act < 0) throw badRequest(`${l.sku_code}: pieces must be a whole number, zero or more`);
    if (act > planned) throw badRequest(`${l.sku_code}: ${act} is more than the ${planned} planned. The fabric was issued for ${planned}`);
    await ctx.db.query('UPDATE work_order_line SET actual_qty=$2 WHERE id=$1', [l.id, act]);
    if (act === 0) { made.push({ sku: l.sku_code, planned, actual: 0 }); continue; }
    const label = `${w.number}/${l.sku_code}`;
    const lot = (await ctx.db.query(`INSERT INTO lot(site_id, item_id, label, attributes) VALUES ($1,$2,$3,$4) RETURNING id`, [w.site_id, l.item_id, label, JSON.stringify({ cutOrder: w.number })])).rows[0];
    await postMovement(ctx, { type: 'RECEIPT_CUT', sourceType: 'work_order', sourceId: w.id, legs: [{ siteId: w.site_id, lotId: lot.id, itemId: l.item_id, locationId: loc, status: 'HOLD', qty: q4(act), unit: 'PC' }] });
    const insp = (await ctx.db.query(`INSERT INTO qc_inspection(site_id, lot_id, source_work_order_id, source_qty, source_item_id, source_unit) VALUES ($1,$2,$3,$4,$5,'PC') RETURNING id`, [w.site_id, lot.id, w.id, q4(act), l.item_id])).rows[0];
    made.push({ sku: l.sku_code, planned, actual: act, lotId: lot.id, inspectionId: insp.id });
  }
  const r = await bump(ctx, w.id, `status='completed', completed_by=$2, completed_at=now()`, [ctx.actor.id]);
  const planned = made.reduce((a, m) => a + m.planned, 0), actual = made.reduce((a, m) => a + m.actual, 0);
  await audit(ctx, { action: 'wo.complete', entityType: 'work_order', entityId: w.id, after: { planned, actual, yieldPct: Math.round((actual / planned) * 1000) / 10 } });
  return { ...r, made, planned, actual, shortfall: planned - actual, yieldPct: Math.round((actual / planned) * 1000) / 10 };
}

export async function cancelWorkOrder(ctx: Ctx, i: { woId: string; expectedVersion: number; reason: string }) {
  const w = await loadWo(ctx.db, i.woId, i.expectedVersion);
  await assertCan(ctx.db, ctx.actor.id, 'production.create', { siteId: w.site_id });
  if (!i.reason?.trim() || i.reason.trim().length < 3) throw badRequest('Say why it is cancelled');
  if (w.status !== 'draft') throw invalidState(w.status === 'issued' ? 'Material has already gone out. Complete the order with what came back' : `This order is ${w.status}`);
  const r = await bump(ctx, w.id, `status='cancelled', cancel_reason=$2`, [i.reason.trim()]);
  await audit(ctx, { action: 'wo.cancel', entityType: 'work_order', entityId: w.id, reason: i.reason.trim() });
  return r;
}

// ───────────────────────── reading ─────────────────────────
export async function listWorkOrders(db: Db, userId: string) {
  const sites = await visibleSites(db, userId, 'production.view');
  if (sites && !sites.length) return [];
  return (await db.query(
    `SELECT w.id, w.number, w.kind, w.status, w.version, w.finish_name, w.colour, w.notes, w.created_at, w.completed_at, w.cancel_reason, s.code AS style, s.name AS style_name, pr.name AS processor, oi.code AS out_code, u.display_name AS creator,
            COALESCE((SELECT json_agg(json_build_object('id', l.id, 'role', l.role, 'code', COALESCE(k.code, i.code), 'name', i.name, 'lot', lt.label, 'planned', l.planned_qty::float, 'actual', l.actual_qty::float, 'unit', l.unit, 'sku_id', l.sku_id) ORDER BY l.line_no)
                      FROM work_order_line l JOIN item i ON i.id=l.item_id LEFT JOIN sku k ON k.id=l.sku_id LEFT JOIN lot lt ON lt.id=l.lot_id WHERE l.wo_id=w.id), '[]') AS lines
       FROM work_order w LEFT JOIN product_style s ON s.id=w.style_id LEFT JOIN partner pr ON pr.id=w.processor_id LEFT JOIN item oi ON oi.id=w.out_item_id LEFT JOIN app_user u ON u.id=w.created_by
      WHERE ($1::uuid[] IS NULL OR w.site_id = ANY($1::uuid[])) ORDER BY (w.status IN ('draft','issued')) DESC, w.created_at DESC LIMIT 200`, [sites])).rows;
}

/** Accepted fabric that is free to send for finishing or to split into shade lots. */
export async function freeFabricLots(db: Db, userId: string) {
  const sites = await visibleSites(db, userId, 'production.view');
  if (sites && !sites.length) return [];
  const lots = (await db.query(`SELECT l.id, l.label, l.attributes, i.id AS item_id, i.code, i.name, i.stock_unit AS unit FROM lot l JOIN item i ON i.id=l.item_id WHERE i.kind='FABRIC' AND ($1::uuid[] IS NULL OR l.site_id = ANY($1::uuid[])) ORDER BY l.created_at DESC`, [sites])).rows;
  const out = [];
  for (const l of lots) {
    const a = await availability(db, l.id);
    const promised = (await db.query(`SELECT COALESCE(sum(l2.planned_qty),0)::text AS q FROM work_order_line l2 JOIN work_order w ON w.id=l2.wo_id WHERE l2.lot_id=$1 AND l2.role='input' AND w.status='draft'`, [l.id])).rows[0].q;
    const free = qSub(a.available, promised);
    if (qGt(free, '0')) out.push({ ...l, free: Number(free) });
  }
  return out;
}
void toScaled; void fromScaled; void qLt;
