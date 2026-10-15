// Production planning, six months ahead.
// Sales per SKU (the average of the last months, or a figure the planner types) sets how many pieces to make each month so that
// finished stock never drops below its minimum. Each piece needs materials from the BOM, more when cutting loses some of the
// fabric. Materials are projected month by month against stock and open orders; whatever would run below its minimum becomes a
// purchase request line, dated by when it is needed and when it has to be ordered (needed date minus the vendor's lead time).
import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan, visibleSites } from '../core/permissions.js';
import { audit } from '../core/audit.js';
import { nextNumber } from '../core/numbering.js';
import { badRequest, invalidState, notFound, staleVersion } from '../core/errors.js';
import { applies, lineQty } from './bom.js';
import * as po from './po.js';

const ANY = { anySite: true } as const;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const n = (v: unknown) => Number(v ?? 0);

const monthStart = (d: string) => d.slice(0, 7) + '-01';
const addMonths = (d: string, k: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + k, 1); return x.toISOString().slice(0, 10); };
const addDays = (d: string, k: number) => new Date(+new Date(d + 'T00:00:00Z') + k * 86400000).toISOString().slice(0, 10);

type Settings = { sales_months: number; cover_days: number; lead_days: number; horizon_months: number };
export type PlanRow = { month: string; demand: number; opening: number; production: number; closing: number };
export type MatRow = { month: string; need: number; opening: number; receipts: number; buy: number; closing: number };
export type BuyLine = { item_id: string; code: string; name: string; unit: string; month: string; qty: number; needed_by: string; order_by: string; late: boolean; vendor_id: string | null; vendor: string | null; rate: number | null; est_cost: number | null };

// ───────────────────────── the plan ─────────────────────────
export async function computePlan(db: Db, userId: string) {
  await assertCan(db, userId, 'plan.view', ANY);
  const set = (await db.query('SELECT * FROM plan_setting')).rows[0] as Settings;
  const today = (await db.query('SELECT CURRENT_DATE::text AS d')).rows[0].d as string;
  const months = Array.from({ length: set.horizon_months }, (_, i) => addMonths(monthStart(today), i));
  const mIdx = (date: string) => Math.min(months.length - 1, Math.max(0, months.findIndex((m, i) => date < (months[i + 1] ?? '9999-12-31'))));
  const sites = await visibleSites(db, userId, 'inventory.view');

  const ips = new Map<string, Record<string, unknown>>((await db.query('SELECT * FROM item_plan')).rows.map((r) => [r.item_id as string, r]));
  const salesAvg = new Map<string, number>((await db.query(
    `SELECT l.item_id, sum(l.qty)::text AS q FROM so_line l JOIN sales_order s ON s.id=l.so_id
      WHERE s.status IN ('confirmed','part_dispatched','dispatched') AND s.created_at >= now() - make_interval(months => $1) GROUP BY 1`, [set.sales_months])).rows.map((r) => [r.item_id as string, n(r.q) / set.sales_months]));
  const demandOverride = new Map<string, number>((await db.query('SELECT item_id, month::text AS month, qty::text AS qty FROM plan_demand')).rows.map((r) => [`${r.item_id}|${r.month}`, n(r.qty)]));
  const onHand = new Map<string, number>((await db.query(
    `SELECT sl.item_id, sum(sl.qty)::text AS q FROM stock_ledger sl WHERE sl.status='ACCEPTED' AND ($1::uuid[] IS NULL OR sl.site_id = ANY($1::uuid[])) GROUP BY 1`, [sites])).rows.map((r) => [r.item_id as string, n(r.q)]));

  // ── finished pieces: how many to make each month ──
  const skuRows = (await db.query(
    `SELECT k.id AS sku_id, k.code, k.size, k.colour_code, k.style_id, s.code AS style, s.cutting_yield_pct::float AS yield, i.id AS item_id, b.version AS bom_version
       FROM sku k JOIN product_style s ON s.id=k.style_id JOIN item i ON i.id=k.item_id JOIN bom b ON b.style_id=s.id AND b.status='active' ORDER BY k.code`)).rows;
  const bomLines = (await db.query(`SELECT l.*, b.style_id FROM bom_line l JOIN bom b ON b.id=l.bom_id WHERE b.status='active'`)).rows;
  const byStyle = new Map<string, typeof bomLines>(); for (const l of bomLines) byStyle.set(l.style_id, [...(byStyle.get(l.style_id) ?? []), l]);
  const need = new Map<string, number[]>(); const addNeed = (id: string, m: number, q: number) => { const a = need.get(id) ?? Array(months.length).fill(0); a[m] += q; need.set(id, a); };

  const skus = skuRows.map((k) => {
    const ip = ips.get(k.item_id) ?? {};
    const avg = ip.monthly_demand != null ? n(ip.monthly_demand) : (salesAvg.get(k.item_id) ?? 0);
    const cover = (ip.cover_days as number | null) ?? set.cover_days;
    const min = r4(Math.max(n(ip.manual_min), (avg * cover) / 30));
    let open = onHand.get(k.item_id) ?? 0; const hand = open;
    const rows: PlanRow[] = months.map((m, mi) => {
      const demand = demandOverride.get(`${k.item_id}|${m}`) ?? avg;
      const production = Math.ceil(Math.max(0, demand + min - open) - 1e-9);
      const closing = open + production - demand;
      const row = { month: m, demand: r4(demand), opening: r4(open), production, closing: r4(closing) }; open = closing;
      if (production > 0) for (const l of byStyle.get(k.style_id) ?? []) if (applies(l, k.size, k.colour_code)) {
        const g = lineQty(l, k.size).gross; addNeed(l.item_id, mi, (l.section === 'FABRIC' ? g / (k.yield / 100) : g) * production);
      }
      return row;
    });
    const idle = avg === 0 && min === 0 && !rows.some((r) => r.demand > 0);
    return { sku_id: k.sku_id as string, item_id: k.item_id as string, code: k.code as string, style: k.style as string, size: k.size as string, colour: k.colour_code as string, bom_version: k.bom_version as number, on_hand: r4(hand), avg_demand: r4(avg), cover_days: cover, min, manual_min: ip.manual_min != null ? n(ip.manual_min) : null, monthly_demand: ip.monthly_demand != null ? n(ip.monthly_demand) : null, idle, rows, pieces: rows.reduce((a, r) => a + r.production, 0) };
  });

  // ── supply already on the way: open purchase orders and open purchase requests ──
  const arriving = new Map<string, number[]>(); const addArr = (id: string, m: number, q: number) => { const a = arriving.get(id) ?? Array(months.length).fill(0); a[m] += q; arriving.set(id, a); };
  for (const r of (await db.query(
    `SELECT pl.item_id, COALESCE(pl.due_date, CURRENT_DATE)::text AS due, (pl.qty - pl.received_qty)::text AS rem FROM po_line pl JOIN purchase_order p ON p.id=pl.po_id
      WHERE p.status IN ('approved','released','acknowledged','partial_receipt') AND pl.qty > pl.received_qty AND ($1::uuid[] IS NULL OR p.site_id = ANY($1::uuid[]))`, [sites])).rows) addArr(r.item_id, mIdx(r.due), n(r.rem));
  const prQty = new Map<string, number>();
  for (const r of (await db.query(`SELECT l.item_id, l.needed_by::text AS nb, l.qty::text AS qty FROM purchase_request_line l JOIN purchase_request p ON p.id=l.pr_id WHERE p.status='open'`)).rows) { addArr(r.item_id, mIdx(r.nb), n(r.qty)); prQty.set(r.item_id, (prQty.get(r.item_id) ?? 0) + n(r.qty)); }

  // ── materials, finished fabrics first (they turn into grey fabric need), then everything else ──
  const itemInfo = async (ids: string[]) => new Map<string, { id: string; code: string; name: string; unit: string; kind: string; status: string }>((await db.query(`SELECT id, code, name, stock_unit AS unit, kind, status FROM item WHERE id = ANY($1::uuid[])`, [ids])).rows.map((r) => [r.id, r]));
  const greyOf = (id: string) => ips.get(id)?.grey_item_id as string | undefined;
  const ids = new Set<string>([...need.keys(), ...[...need.keys()].map(greyOf).filter(Boolean) as string[]]);
  const info = await itemInfo([...ids]);
  const rates = new Map<string, { partner_id: string; vendor: string; rate: number }>((await db.query(
    `SELECT DISTINCT ON (r.item_id) r.item_id, r.partner_id, p.name AS vendor, r.rate::float AS rate FROM rate r JOIN partner p ON p.id=r.partner_id
      WHERE r.status IN ('approved','superseded') AND r.effective_from <= CURRENT_DATE AND (r.effective_to IS NULL OR r.effective_to >= CURRENT_DATE) AND p.status='active' ORDER BY r.item_id, r.rate`)).rows.map((r) => [r.item_id, r]));
  const vendorNames = new Map<string, string>((await db.query(`SELECT id, name FROM partner WHERE is_vendor`)).rows.map((r) => [r.id, r.name]));

  const materials: Array<{ item_id: string; code: string; name: string; unit: string; kind: string; make: boolean; grey_item_id: string | null; finish_loss_pct: number; on_hand: number; on_order: number; avg_use: number; min: number; manual_min: number | null; cover_days: number; lead_days: number; vendor_id: string | null; vendor: string | null; rate: number | null; rows: MatRow[]; buy_total: number }> = [];
  const buys: BuyLine[] = [];
  const done = new Set<string>();
  const order = [...ids].sort((a, b) => Number(!!greyOf(b)) - Number(!!greyOf(a)));
  for (const id of order) {
    if (done.has(id)) continue; done.add(id);
    const it = info.get(id); if (!it) continue;
    const ip = ips.get(id) ?? {}; const nd = need.get(id) ?? Array(months.length).fill(0);
    const cover = (ip.cover_days as number | null) ?? set.cover_days; const lead = (ip.lead_days as number | null) ?? set.lead_days;
    const avgUse = nd.reduce((a: number, b: number) => a + b, 0) / months.length;
    const min = r4(Math.max(n(ip.manual_min), (avgUse * cover) / 30));
    const grey = greyOf(id); const loss = n(ip.finish_loss_pct);
    const vendorId = (ip.preferred_vendor_id as string | undefined) ?? rates.get(id)?.partner_id ?? null;
    const rate = vendorId && rates.get(id)?.partner_id === vendorId ? rates.get(id)!.rate : (rates.get(id)?.rate ?? null);
    let open = onHand.get(id) ?? 0; const hand = open; const arr = arriving.get(id) ?? Array(months.length).fill(0);
    let buyTotal = 0;
    const rows: MatRow[] = months.map((m, mi) => {
      const receipts = arr[mi]; const have = open + receipts;
      const buy = Math.max(0, r4(min + nd[mi] - have));
      const closing = have + buy - nd[mi];
      const row = { month: m, need: r4(nd[mi]), opening: r4(open), receipts: r4(receipts), buy, closing: r4(closing) }; open = closing; buyTotal += buy;
      if (buy > 0) {
        if (grey) addNeed(grey, mi, buy / (1 - loss / 100)); // a finished fabric is made from grey fabric, so the grey is what gets bought
        else { const nb = mi === 0 ? today : m; const ob = addDays(nb, -lead); buys.push({ item_id: id, code: it.code, name: it.name, unit: it.unit, month: m, qty: buy, needed_by: nb, order_by: ob, late: ob < today, vendor_id: vendorId, vendor: vendorId ? vendorNames.get(vendorId) ?? null : null, rate, est_cost: rate == null ? null : r2(buy * rate) }); }
      }
      return row;
    });
    materials.push({ item_id: id, code: it.code, name: it.name, unit: it.unit, kind: it.kind, make: !!grey, grey_item_id: grey ?? null, finish_loss_pct: loss, on_hand: r4(hand), on_order: r4(arr.reduce((a: number, b: number) => a + b, 0)), avg_use: r4(avgUse), min, manual_min: ip.manual_min != null ? n(ip.manual_min) : null, cover_days: cover, lead_days: lead, vendor_id: vendorId, vendor: vendorId ? vendorNames.get(vendorId) ?? null : null, rate, rows, buy_total: r4(buyTotal) });
    if (grey && !ids.has(grey)) { ids.add(grey); const gi = await itemInfo([grey]); for (const [k, v] of gi) info.set(k, v); order.push(grey); }
  }
  materials.sort((a, b) => a.code.localeCompare(b.code));
  const warnings: string[] = [];
  for (const m of materials) if (m.buy_total > 0 && !m.make && !m.vendor_id) warnings.push(`${m.code} ${m.name} has no vendor price. Set a preferred vendor or ask for a price.`);
  for (const k of skus) if (!k.idle && k.pieces === 0 && k.min === 0) warnings.push(`${k.code} has sales but no pieces to make`);
  const noBom = (await db.query(`SELECT count(*)::int c FROM sku k WHERE NOT EXISTS (SELECT 1 FROM bom b WHERE b.style_id=k.style_id AND b.status='active')`)).rows[0].c as number;
  if (noBom) warnings.push(`${noBom} SKU${noBom > 1 ? 's are' : ' is'} left out because the style has no approved BOM`);
  buys.sort((a, b) => a.order_by.localeCompare(b.order_by) || a.code.localeCompare(b.code));
  return {
    asOf: today, months, settings: set, skus, materials, buys, warnings,
    totals: { pieces: skus.reduce((a, k) => a + k.pieces, 0), buy_lines: buys.length, buy_cost: r2(buys.reduce((a, b) => a + (b.est_cost ?? 0), 0)), late: buys.filter((b) => b.late).length },
  };
}

// ───────────────────────── settings ─────────────────────────
export async function updateSettings(ctx: Ctx, i: { salesMonths?: number; coverDays?: number; leadDays?: number; horizonMonths?: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'plan.manage', ANY);
  const chk = (v: number | undefined, lo: number, hi: number, label: string) => { if (v !== undefined && !(Number.isInteger(v) && v >= lo && v <= hi)) throw badRequest(`${label}: a whole number from ${lo} to ${hi}`); };
  chk(i.salesMonths, 1, 24, 'Months of sales to average'); chk(i.coverDays, 0, 365, 'Days of cover'); chk(i.leadDays, 0, 365, 'Lead time'); chk(i.horizonMonths, 1, 12, 'Months to plan');
  const r = (await ctx.db.query(`UPDATE plan_setting SET sales_months=COALESCE($1,sales_months), cover_days=COALESCE($2,cover_days), lead_days=COALESCE($3,lead_days), horizon_months=COALESCE($4,horizon_months), updated_by=$5, updated_at=now() RETURNING *`,
    [i.salesMonths ?? null, i.coverDays ?? null, i.leadDays ?? null, i.horizonMonths ?? null, ctx.actor.id])).rows[0];
  await audit(ctx, { action: 'plan.settings', entityType: 'plan_setting', entityId: null, after: r });
  return r;
}

export type ItemPlanInput = { itemId: string; manualMin?: string | null; coverDays?: number | null; leadDays?: number | null; monthlyDemand?: string | null; preferredVendorId?: string | null; greyItemId?: string | null; finishLossPct?: string | null };
/** Set the planning figures for one item. A blank value goes back to the company setting. */
export async function setItemPlan(ctx: Ctx, i: ItemPlanInput) {
  await assertCan(ctx.db, ctx.actor.id, 'plan.manage', ANY);
  const it = (await ctx.db.query('SELECT id, code, kind FROM item WHERE id=$1', [i.itemId])).rows[0]; if (!it) throw notFound('Item');
  const num = (v: string | null | undefined, label: string, max = 1e9) => { if (v == null || v === '') return null; if (!/^\d+(\.\d{1,4})?$/.test(v) || Number(v) > max) throw badRequest(`${label}: a number of zero or more`); return v; };
  const int = (v: number | null | undefined, label: string) => { if (v == null) return null; if (!Number.isInteger(v) || v < 0 || v > 365) throw badRequest(`${label}: whole days, 0 to 365`); return v; };
  if (i.greyItemId) {
    if (i.greyItemId === i.itemId) throw badRequest('A fabric cannot be made from itself');
    const g = (await ctx.db.query('SELECT kind FROM item WHERE id=$1', [i.greyItemId])).rows[0]; if (!g) throw notFound('Grey fabric');
    if (it.kind !== 'FABRIC' || g.kind !== 'FABRIC') throw badRequest('Both the finished fabric and its grey fabric must be fabrics');
    if ((await ctx.db.query('SELECT 1 FROM item_plan WHERE item_id=$1 AND grey_item_id IS NOT NULL', [i.greyItemId])).rowCount) throw badRequest('That grey fabric is itself made from another fabric. Pick the original grey');
  }
  if (i.preferredVendorId && !(await ctx.db.query('SELECT 1 FROM partner WHERE id=$1 AND is_vendor AND status=\'active\'', [i.preferredVendorId])).rowCount) throw badRequest('Pick an approved vendor');
  const loss = num(i.finishLossPct, 'Loss in finishing', 60) ?? '0';
  const r = (await ctx.db.query(
    `INSERT INTO item_plan(item_id, manual_min, cover_days, lead_days, monthly_demand, preferred_vendor_id, grey_item_id, finish_loss_pct, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (item_id) DO UPDATE SET manual_min=EXCLUDED.manual_min, cover_days=EXCLUDED.cover_days, lead_days=EXCLUDED.lead_days, monthly_demand=EXCLUDED.monthly_demand, preferred_vendor_id=EXCLUDED.preferred_vendor_id, grey_item_id=EXCLUDED.grey_item_id, finish_loss_pct=EXCLUDED.finish_loss_pct, updated_by=EXCLUDED.updated_by, updated_at=now() RETURNING *`,
    [i.itemId, num(i.manualMin, 'Minimum stock'), int(i.coverDays, 'Days of cover'), int(i.leadDays, 'Lead time'), num(i.monthlyDemand, 'Monthly sales'), i.preferredVendorId || null, i.greyItemId || null, loss, ctx.actor.id])).rows[0];
  await audit(ctx, { action: 'plan.item', entityType: 'item', entityId: i.itemId, after: r });
  return r;
}

/** One month's planned sales for a SKU. A blank quantity removes the override. */
export async function setDemand(ctx: Ctx, i: { itemId: string; month: string; qty: string | null; note?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'plan.manage', ANY);
  if (!/^\d{4}-\d{2}-01$/.test(i.month)) throw badRequest('Month must be the first of a month, like 2026-12-01');
  if (!(await ctx.db.query('SELECT 1 FROM item WHERE id=$1', [i.itemId])).rowCount) throw notFound('Item');
  if (i.qty == null || i.qty === '') { await ctx.db.query('DELETE FROM plan_demand WHERE item_id=$1 AND month=$2', [i.itemId, i.month]); await audit(ctx, { action: 'plan.demand.clear', entityType: 'item', entityId: i.itemId, after: { month: i.month } }); return { cleared: true }; }
  if (!/^\d+(\.\d{1,4})?$/.test(i.qty)) throw badRequest('Planned sales: a number of zero or more');
  const r = (await ctx.db.query(`INSERT INTO plan_demand(item_id, month, qty, note, updated_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (item_id, month) DO UPDATE SET qty=EXCLUDED.qty, note=EXCLUDED.note, updated_by=EXCLUDED.updated_by RETURNING *`, [i.itemId, i.month, i.qty, i.note ?? null, ctx.actor.id])).rows[0];
  await audit(ctx, { action: 'plan.demand', entityType: 'item', entityId: i.itemId, after: { month: i.month, qty: i.qty } });
  return r;
}

/** How much of the fabric is left after cutting. Different sizes in one style leave offcuts, so this is below 100. */
export async function setCuttingYield(ctx: Ctx, i: { styleId: string; yieldPct: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'plan.manage', ANY);
  if (!(i.yieldPct >= 50 && i.yieldPct <= 100)) throw badRequest('Cutting yield: 50 to 100 percent');
  const r = (await ctx.db.query('UPDATE product_style SET cutting_yield_pct=$2 WHERE id=$1 RETURNING id, code, cutting_yield_pct', [i.styleId, i.yieldPct])).rows[0];
  if (!r) throw notFound('Style');
  await audit(ctx, { action: 'plan.yield', entityType: 'product_style', entityId: r.id, after: { yield: i.yieldPct } });
  return r;
}

// ───────────────────────── purchase requests ─────────────────────────
/**
 * Turn the shortages that have to be ordered soon into purchase requests, one per vendor.
 * Lines already covered by an open request are not asked for again, so this is safe to run every day.
 */
export async function generateRequests(ctx: Ctx, i: { withinDays?: number } = {}) {
  await assertCan(ctx.db, ctx.actor.id, 'plan.manage', ANY);
  const within = i.withinDays ?? 30;
  if (!Number.isInteger(within) || within < 0 || within > 365) throw badRequest('Look ahead: 0 to 365 days');
  const plan = await computePlan(ctx.db, ctx.actor.id);
  const sites = await visibleSites(ctx.db, ctx.actor.id, 'po.create');
  const siteId = sites?.[0] ?? (await ctx.db.query('SELECT id FROM site ORDER BY code LIMIT 1')).rows[0]?.id;
  if (!siteId) throw invalidState('There is no site to raise requests for');
  const limit = addDays(plan.asOf, within);
  const due = plan.buys.filter((b) => b.order_by <= limit);
  const groups = new Map<string, BuyLine[]>(); for (const b of due) groups.set(b.vendor_id ?? '', [...(groups.get(b.vendor_id ?? '') ?? []), b]);
  const made: { id: string; number: string; vendor: string | null; lines: number }[] = [];
  for (const [vendorId, lines] of groups) {
    const number = await nextNumber(ctx, siteId, 'PR');
    const pr = (await ctx.db.query(`INSERT INTO purchase_request(site_id, number, partner_id, source, note, created_by) VALUES ($1,$2,$3,'plan',$4,$5) RETURNING id`, [siteId, number, vendorId || null, vendorId ? null : 'No vendor price on file. Choose a vendor before ordering', ctx.actor.id])).rows[0];
    for (const [k, l] of lines.entries()) await ctx.db.query(`INSERT INTO purchase_request_line(pr_id, line_no, item_id, qty, unit, needed_by, order_by, est_rate, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [pr.id, k + 1, l.item_id, l.qty, l.unit, l.needed_by, l.order_by, l.rate, `Plan ${plan.asOf}: stock would fall below the minimum in ${l.month.slice(0, 7)}${l.late ? '. Lead time is longer than the time left' : ''}`]);
    made.push({ id: pr.id, number, vendor: lines[0].vendor, lines: lines.length });
    await audit(ctx, { action: 'request.create', entityType: 'purchase_request', entityId: pr.id, after: { number, vendor: lines[0].vendor, lines: lines.length } });
  }
  return { requests: made, lines: due.length, later: plan.buys.length - due.length };
}

export async function listRequests(db: Db, userId: string) {
  await assertCan(db, userId, 'plan.view', ANY);
  return (await db.query(
    `SELECT p.id, p.number, p.status, p.note, p.version, p.created_at, p.partner_id, v.name AS vendor, o.number AS po_number, u.display_name AS creator,
            COALESCE((SELECT json_agg(json_build_object('item_id', l.item_id, 'code', i.code, 'name', i.name, 'qty', l.qty::float, 'unit', l.unit, 'needed_by', l.needed_by::text, 'order_by', l.order_by::text, 'est_rate', l.est_rate::float, 'reason', l.reason) ORDER BY l.line_no)
                      FROM purchase_request_line l JOIN item i ON i.id=l.item_id WHERE l.pr_id=p.id), '[]') AS lines
       FROM purchase_request p LEFT JOIN partner v ON v.id=p.partner_id LEFT JOIN purchase_order o ON o.id=p.po_id LEFT JOIN app_user u ON u.id=p.created_by
      ORDER BY (p.status='open') DESC, p.created_at DESC LIMIT 100`)).rows;
}

/** The buyer turns a request into a draft purchase order. It still has to be submitted and approved like any other. */
export async function convertRequest(ctx: Ctx, i: { requestId: string; expectedVersion: number; partnerId?: string }) {
  const p = (await ctx.db.query('SELECT * FROM purchase_request WHERE id=$1 FOR UPDATE', [i.requestId])).rows[0];
  if (!p) throw notFound('Request');
  await assertCan(ctx.db, ctx.actor.id, 'po.create', { siteId: p.site_id });
  if (p.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, p.version);
  if (p.status !== 'open') throw invalidState(`This request is already ${p.status}`);
  const vendor = i.partnerId ?? p.partner_id; if (!vendor) throw badRequest('Choose a vendor for this request first');
  const lines = (await ctx.db.query('SELECT * FROM purchase_request_line WHERE pr_id=$1 ORDER BY line_no', [p.id])).rows;
  const order = await po.createPO(ctx, { siteId: p.site_id, partnerId: vendor, lines: lines.map((l) => ({ itemId: l.item_id, qty: String(l.qty), dueDate: l.needed_by })) });
  await ctx.db.query(`UPDATE purchase_request SET status='converted', po_id=$2, partner_id=$3, version=version+1 WHERE id=$1`, [p.id, order.id, vendor]);
  await audit(ctx, { action: 'request.convert', entityType: 'purchase_request', entityId: p.id, after: { po: order.number } });
  return { requestId: p.id, poId: order.id, poNumber: order.number };
}

export async function cancelRequest(ctx: Ctx, i: { requestId: string; expectedVersion: number; reason: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'plan.manage', ANY);
  if (!i.reason?.trim() || i.reason.trim().length < 3) throw badRequest('Say why the request is cancelled');
  const p = (await ctx.db.query('SELECT * FROM purchase_request WHERE id=$1 FOR UPDATE', [i.requestId])).rows[0];
  if (!p) throw notFound('Request');
  if (p.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, p.version);
  if (p.status !== 'open') throw invalidState(`This request is already ${p.status}`);
  await ctx.db.query(`UPDATE purchase_request SET status='cancelled', version=version+1 WHERE id=$1`, [p.id]);
  await audit(ctx, { action: 'request.cancel', entityType: 'purchase_request', entityId: p.id, reason: i.reason.trim() });
  return { ok: true };
}
