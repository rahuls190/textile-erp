import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan, assertIndependent, can } from '../core/permissions.js';
import { audit, emit } from '../core/audit.js';
import { badRequest, invalidState, notFound, staleVersion } from '../core/errors.js';

const ANY = { anySite: true } as const; // master data is company-level

// ───────────────────────── M02 Items & variants ─────────────────────────

export async function createItem(ctx: Ctx, i: {
  code: string; name: string; kind: string; stockUnit: string; tracking?: string; parentId?: string | null; attributes?: object;
}) {
  await assertCan(ctx.db, ctx.actor.id, 'item.create', ANY);
  if (!(await ctx.db.query('SELECT 1 FROM unit WHERE code=$1', [i.stockUnit])).rowCount) throw badRequest(`Unknown unit ${i.stockUnit}`);
  if (i.parentId && !(await ctx.db.query('SELECT 1 FROM item WHERE id=$1', [i.parentId])).rowCount) throw notFound('Parent style');
  const r = await ctx.db.query(
    `INSERT INTO item(code, name, kind, stock_unit, tracking, parent_id, attributes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [i.code, i.name, i.kind, i.stockUnit, i.tracking ?? 'LOT', i.parentId ?? null, JSON.stringify(i.attributes ?? {}), ctx.actor.id]);
  await audit(ctx, { action: 'item.create', entityType: 'item', entityId: r.rows[0].id, after: r.rows[0] });
  return r.rows[0];
}

async function loadItem(db: Db, id: string, expectedVersion?: number) {
  const it = (await db.query('SELECT * FROM item WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!it) throw notFound('Item');
  if (expectedVersion !== undefined && it.version !== expectedVersion) throw staleVersion(expectedVersion, it.version);
  return it;
}

export async function submitItem(ctx: Ctx, i: { itemId: string; expectedVersion: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'item.submit', ANY);
  const it = await loadItem(ctx.db, i.itemId, i.expectedVersion);
  if (it.status !== 'draft') throw invalidState(`Item is ${it.status}; only drafts can be submitted`);
  const r = await ctx.db.query(`UPDATE item SET status='submitted', version=version+1 WHERE id=$1 RETURNING *`, [i.itemId]);
  await audit(ctx, { action: 'item.submit', entityType: 'item', entityId: i.itemId, before: { status: it.status }, after: { status: 'submitted' } });
  return r.rows[0];
}

export async function approveItem(ctx: Ctx, i: { itemId: string; expectedVersion: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'item.approve', ANY);
  const it = await loadItem(ctx.db, i.itemId, i.expectedVersion);
  if (it.status !== 'submitted') throw invalidState(`Item is ${it.status}; only submitted items can be approved`);
  assertIndependent(ctx.actor.id, it.created_by, 'item');
  const r = await ctx.db.query(`UPDATE item SET status='active', approved_by=$2, version=version+1 WHERE id=$1 RETURNING *`, [i.itemId, ctx.actor.id]);
  await audit(ctx, { action: 'item.approve', entityType: 'item', entityId: i.itemId, before: { status: it.status }, after: { status: 'active' } });
  await emit(ctx, { type: 'item.released', entityType: 'item', entityId: i.itemId, version: r.rows[0].version, payload: { code: it.code } });
  return r.rows[0];
}

// ───────────────────────── M03 Partners ─────────────────────────

export async function createPartner(ctx: Ctx, i: {
  code: string; name: string; isVendor?: boolean; isSubcontractor?: boolean; isCustomer?: boolean; gstin?: string; bankAccount?: string;
}) {
  await assertCan(ctx.db, ctx.actor.id, 'partner.create', ANY);
  const dup = await ctx.db.query(`SELECT code FROM partner WHERE lower(name)=lower($1) OR ($2::text IS NOT NULL AND gstin=$2)`, [i.name, i.gstin ?? null]);
  if (dup.rowCount) throw badRequest(`Possible duplicate partner: ${dup.rows[0].code}`);
  const r = await ctx.db.query(
    `INSERT INTO partner(code, name, is_vendor, is_subcontractor, is_customer, gstin, bank_account, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, code, name, status, version`,
    [i.code, i.name, !!i.isVendor, !!i.isSubcontractor, !!i.isCustomer, i.gstin ?? null, i.bankAccount ?? null, ctx.actor.id]);
  await audit(ctx, { action: 'partner.create', entityType: 'partner', entityId: r.rows[0].id, after: { ...r.rows[0] } });
  return r.rows[0];
}

async function loadPartner(db: Db, id: string, expectedVersion?: number) {
  const p = (await db.query('SELECT * FROM partner WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!p) throw notFound('Partner');
  if (expectedVersion !== undefined && p.version !== expectedVersion) throw staleVersion(expectedVersion, p.version);
  return p;
}

export async function submitPartner(ctx: Ctx, i: { partnerId: string; expectedVersion: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'partner.submit', ANY);
  const p = await loadPartner(ctx.db, i.partnerId, i.expectedVersion);
  if (p.status !== 'draft') throw invalidState(`Partner is ${p.status}`);
  const r = await ctx.db.query(`UPDATE partner SET status='verification', version=version+1 WHERE id=$1 RETURNING id, status, version`, [i.partnerId]);
  await audit(ctx, { action: 'partner.submit', entityType: 'partner', entityId: i.partnerId, before: { status: p.status }, after: { status: 'verification' } });
  return r.rows[0];
}

/** Finance independently verifies bank details (blueprint M03 step 03). */
export async function verifyPartnerBank(ctx: Ctx, i: { partnerId: string; expectedVersion: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'partner.bank.approve', ANY);
  const p = await loadPartner(ctx.db, i.partnerId, i.expectedVersion);
  if (p.status !== 'verification') throw invalidState(`Partner is ${p.status}; bank verification happens in 'verification'`);
  assertIndependent(ctx.actor.id, p.created_by, 'partner');
  const r = await ctx.db.query(`UPDATE partner SET bank_verified_by=$2, version=version+1 WHERE id=$1 RETURNING id, status, version`, [i.partnerId, ctx.actor.id]);
  await audit(ctx, { action: 'partner.bank.verify', entityType: 'partner', entityId: i.partnerId });
  return r.rows[0];
}

export async function approvePartner(ctx: Ctx, i: { partnerId: string; expectedVersion: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'partner.trade.approve', ANY);
  const p = await loadPartner(ctx.db, i.partnerId, i.expectedVersion);
  if (p.status !== 'verification') throw invalidState(`Partner is ${p.status}`);
  assertIndependent(ctx.actor.id, p.created_by, 'partner');
  if (p.bank_account && !p.bank_verified_by) throw invalidState('Bank details must be verified by finance before activation');
  const r = await ctx.db.query(`UPDATE partner SET status='active', approved_by=$2, version=version+1 WHERE id=$1 RETURNING id, status, version`, [i.partnerId, ctx.actor.id]);
  await audit(ctx, { action: 'partner.approve', entityType: 'partner', entityId: i.partnerId, before: { status: p.status }, after: { status: 'active' } });
  await emit(ctx, { type: 'partner.activated', entityType: 'partner', entityId: i.partnerId, version: r.rows[0].version, payload: { code: p.code } });
  return r.rows[0];
}

/** Bank fields are masked unless the viewer holds partner.bank.view. */
export async function getPartner(db: Db, userId: string, partnerId: string) {
  if (!(await can(db, userId, 'partner.view', ANY))) throw notFound('Partner');
  const p = (await db.query('SELECT * FROM partner WHERE id=$1', [partnerId])).rows[0];
  if (!p) throw notFound('Partner');
  if (!(await can(db, userId, 'partner.bank.view', ANY))) p.bank_account = p.bank_account ? '••••' + String(p.bank_account).slice(-4) : null;
  return p;
}

// ───────────────────────── M04 Rates ─────────────────────────

export async function proposeRate(ctx: Ctx, i: { partnerId: string; itemId: string; rate: string; effectiveFrom: string; minQty?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'rate.propose', ANY);
  const it = (await ctx.db.query('SELECT stock_unit FROM item WHERE id=$1', [i.itemId])).rows[0];
  if (!it) throw notFound('Item');
  const r = await ctx.db.query(
    `INSERT INTO rate(partner_id, item_id, unit, rate, min_qty, effective_from, proposed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [i.partnerId, i.itemId, it.stock_unit, i.rate, i.minQty ?? '0', i.effectiveFrom, ctx.actor.id]);
  await audit(ctx, { action: 'rate.propose', entityType: 'rate', entityId: r.rows[0].id, after: r.rows[0] });
  return r.rows[0];
}

export async function approveRate(ctx: Ctx, i: { rateId: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'rate.approve', ANY);
  const rt = (await ctx.db.query('SELECT * FROM rate WHERE id=$1 FOR UPDATE', [i.rateId])).rows[0];
  if (!rt) throw notFound('Rate');
  if (rt.status !== 'proposed') throw invalidState(`Rate is ${rt.status}`);
  assertIndependent(ctx.actor.id, rt.proposed_by, 'rate');
  // The newer approved rate ends the previous one the day before it starts; history is kept.
  await ctx.db.query(
    `UPDATE rate SET status='superseded', effective_to = ($4::date - 1)
      WHERE partner_id=$1 AND item_id=$2 AND status='approved' AND effective_from < $4::date AND id <> $3`,
    [rt.partner_id, rt.item_id, rt.id, rt.effective_from]);
  const r = await ctx.db.query(`UPDATE rate SET status='approved', approved_by=$2 WHERE id=$1 RETURNING *`, [i.rateId, ctx.actor.id]);
  await audit(ctx, { action: 'rate.approve', entityType: 'rate', entityId: i.rateId, after: r.rows[0] });
  return r.rows[0];
}

/** The approved rate in force on a date for a quantity (best quantity band wins). */
export async function currentRate(db: Db, partnerId: string, itemId: string, qty: string, on: string = new Date().toISOString().slice(0, 10)) {
  const r = await db.query(
    `SELECT * FROM rate
      WHERE partner_id=$1 AND item_id=$2 AND status IN ('approved','superseded')
        AND effective_from <= $4::date AND (effective_to IS NULL OR effective_to >= $4::date)
        AND min_qty <= $3::numeric
      ORDER BY min_qty DESC, effective_from DESC LIMIT 1`,
    [partnerId, itemId, qty, on]);
  return r.rows[0] ?? null;
}
