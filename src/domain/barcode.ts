import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { visibleSites } from '../core/permissions.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import { norm, qAdd, qGt } from '../core/qty.js';
import * as inv from './inventory.js';
import { audit } from '../core/audit.js';

/**
 * Barcodes for stock. A roll's barcode is its lot label (the identity that is never regenerated on reprint).
 * A location's barcode is "L:" + its code, so a scanner can tell a roll from a shelf. Labels use Code 128, which every scanner reads.
 *
 * "Move forward" is the warehouse routine: scan the roll, scan the next place. Stock only moves along the route
 * Receiving → Store → Rack. Held or rejected stock never moves forward (it needs a quality release first), and going backwards is the normal
 * putaway on the Stock page, where a reason is visible to everyone.
 */
export const LOC_PREFIX = 'L:';
export const locationBarcode = (code: string) => LOC_PREFIX + code;
/** Code 128 (set B) can print ASCII 32–126 only. */
export const printable = (s: string) => s.length > 0 && s.length <= 40 && /^[\x20-\x7e]+$/.test(s);
const ROUTE = ['RECEIVING', 'STORE', 'RACK'];
export const routeRank = (kind: string) => ROUTE.indexOf(kind);

export interface Where { location_id: string; code: string; kind: string; status: 'HOLD' | 'ACCEPTED' | 'REJECTED'; qty: string }

async function balances(db: Db, lotId: string): Promise<Where[]> {
  return (await db.query(
    `SELECT sl.location_id, loc.code, loc.kind, sl.status, sum(sl.qty)::text AS qty
       FROM stock_ledger sl JOIN location loc ON loc.id = sl.location_id
      WHERE sl.lot_id = $1 GROUP BY sl.location_id, loc.code, loc.kind, sl.status HAVING sum(sl.qty) <> 0 ORDER BY loc.code, sl.status`, [lotId])).rows
    .map((r) => ({ ...r, qty: norm(r.qty) }));
}

/** Read one scanned code: a roll or a location. Only what the person may see; unknown and hidden look the same. */
export async function resolveScan(db: Db, userId: string, raw: string) {
  const code = raw.trim();
  if (!code) throw badRequest('Nothing was scanned');
  const sites = await visibleSites(db, userId, 'inventory.view');
  if (sites && !sites.length) throw notFound('Code');
  const scope = '($2::uuid[] IS NULL OR %s = ANY($2::uuid[]))';
  if (code.startsWith(LOC_PREFIX)) {
    const loc = (await db.query(`SELECT l.id, l.code, l.name, l.kind, l.site_id FROM location l WHERE l.code = $1 AND ${scope.replace('%s', 'l.site_id')} LIMIT 1`, [code.slice(LOC_PREFIX.length), sites])).rows[0];
    if (!loc) throw notFound('Location');
    const lots = (await db.query(
      `SELECT lot.id, lot.label, i.code AS item_code, i.name AS item_name, sl.status, sum(sl.qty)::text AS qty
         FROM stock_ledger sl JOIN lot ON lot.id = sl.lot_id JOIN item i ON i.id = lot.item_id WHERE sl.location_id = $1
        GROUP BY lot.id, i.code, i.name, sl.status HAVING sum(sl.qty) <> 0 ORDER BY lot.label`, [loc.id])).rows.map((r) => ({ ...r, qty: norm(r.qty) }));
    return { type: 'location' as const, location: loc, lots };
  }
  const lot = (await db.query(
    `SELECT lot.id, lot.label, lot.site_id, lot.created_at, i.code AS item_code, i.name AS item_name, i.stock_unit AS unit
       FROM lot JOIN item i ON i.id = lot.item_id WHERE lot.label = $1 AND ${scope.replace('%s', 'lot.site_id')}`, [code, sites])).rows[0];
  if (!lot) throw notFound('Roll or location with this code');
  const where = await balances(db, lot.id);
  const av = await inv.availability(db, lot.id);
  return { type: 'lot' as const, lot, where, availability: av };
}

/** Labels to print: every lot the person can see, and every location. */
export async function labelData(db: Db, userId: string) {
  const sites = await visibleSites(db, userId, 'inventory.view');
  if (sites && !sites.length) return { lots: [], locations: [] };
  const lots = (await db.query(
    `SELECT lot.id, lot.label, to_char(lot.created_at,'DD Mon YYYY') AS date, i.code AS item_code, i.name AS item_name, i.stock_unit AS unit, s.code AS site,
            COALESCE(sum(sl.qty) FILTER (WHERE sl.status IN ('HOLD','ACCEPTED')),0)::text AS qty
       FROM lot JOIN item i ON i.id = lot.item_id JOIN site s ON s.id = lot.site_id LEFT JOIN stock_ledger sl ON sl.lot_id = lot.id
      WHERE ($1::uuid[] IS NULL OR lot.site_id = ANY($1::uuid[])) GROUP BY lot.id, i.code, i.name, i.stock_unit, s.code ORDER BY lot.created_at DESC LIMIT 300`, [sites])).rows
    .map((r) => ({ ...r, qty: norm(r.qty), printable: printable(r.label) }));
  const locations = (await db.query(
    `SELECT l.id, l.code, l.name, l.kind, s.code AS site FROM location l JOIN site s ON s.id = l.site_id WHERE ($1::uuid[] IS NULL OR l.site_id = ANY($1::uuid[])) ORDER BY l.code`, [sites])).rows
    .map((r) => ({ ...r, barcode: locationBarcode(r.code) }));
  return { lots, locations };
}

/** Scan the roll, scan the next place. Moves the whole usable balance unless a quantity is given. */
export async function moveForward(ctx: Ctx, a: { lotCode: string; toLocationCode: string; qty?: string }) {
  const lot = (await ctx.db.query('SELECT * FROM lot WHERE label = $1', [a.lotCode.trim()])).rows[0];
  if (!lot) throw notFound('Roll with this code');
  const sites = await visibleSites(ctx.db, ctx.actor.id, 'inventory.view');
  if (sites && !sites.includes(lot.site_id)) throw notFound('Roll with this code');
  const toCode = a.toLocationCode.trim().replace(new RegExp('^' + LOC_PREFIX), '');
  const to = (await ctx.db.query('SELECT * FROM location WHERE site_id = $1 AND code = $2', [lot.site_id, toCode])).rows[0];
  if (!to) throw notFound('Location at this roll’s site');
  const where = await balances(ctx.db, lot.id);
  const held = where.filter((w) => w.status !== 'ACCEPTED' && qGt(w.qty, '0'));
  const ok = where.filter((w) => w.status === 'ACCEPTED' && qGt(w.qty, '0'));
  if (!ok.length) {
    if (held.length) throw conflict('NOT_RELEASED', `This roll is ${held[0].status === 'HOLD' ? 'on quality hold' : 'rejected'}. It can move forward only after quality releases it.`);
    throw conflict('NO_STOCK', 'This roll has no stock to move');
  }
  const toRank = routeRank(to.kind);
  if (toRank < 0) throw conflict('NOT_ON_ROUTE', `${to.code} is a ${to.kind.toLowerCase()} location. Forward moves go to a store or a rack.`);
  const candidates = ok.filter((w) => routeRank(w.kind) >= 0 && routeRank(w.kind) < toRank);
  if (!candidates.length) {
    const here = ok.find((w) => w.location_id === to.id);
    throw conflict('NOT_FORWARD', here ? `Already at ${to.code}.` : `Stock is already at or beyond ${to.code}. Moving it back is done from the Stock page.`);
  }
  // take from the furthest-back place first: it is the stock that still has the most journey left
  candidates.sort((x, y) => routeRank(x.kind) - routeRank(y.kind));
  let want = a.qty ?? candidates.reduce((s, c) => qAdd(s, c.qty), '0');
  if (!qGt(want, '0')) throw badRequest('Quantity must be positive');
  const moved: { from: string; qty: string }[] = [];
  const total = candidates.reduce((s, c) => qAdd(s, c.qty), '0');
  if (qGt(want, total)) throw conflict('INSUFFICIENT_STOCK', `Only ${total} m can move forward to ${to.code}`);
  for (const c of candidates) {
    if (!qGt(want, '0')) break;
    const take = qGt(want, c.qty) ? c.qty : want;
    await inv.putaway(ctx, { lotId: lot.id, fromLocationId: c.location_id, toLocationId: to.id, qty: take });
    moved.push({ from: c.code, qty: take });
    want = (BigInt(Math.round(Number(want) * 1e4)) - BigInt(Math.round(Number(take) * 1e4)) > 0n) ? (Number(want) - Number(take)).toFixed(4) : '0';
  }
  await audit(ctx, { action: 'barcode.move_forward', entityType: 'lot', entityId: lot.id, after: { lot: lot.label, to: to.code, moved } });
  return { lot: lot.label, to: to.code, moved };
}
