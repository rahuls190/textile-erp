import type { Db } from '../db/pool.js';
import { can, visibleSites } from '../core/permissions.js';
import { notFound } from '../core/errors.js';
import { norm, qSub } from '../core/qty.js';

/** Stock by lot with every quantity dimension kept separate. Balances are derived from the ledger, never stored. */
export async function stockSummary(db: Db, userId: string, f: { siteId?: string; itemCode?: string } = {}) {
  const sites = await visibleSites(db, userId, 'inventory.view');
  if (sites && !sites.length) return [];
  const r = await db.query(
    `SELECT l.id AS lot_id, l.label, i.code AS item_code, i.name AS item_name, l.site_id, i.stock_unit AS unit,
            COALESCE(SUM(sl.qty) FILTER (WHERE sl.status='HOLD'),0)                                  AS held,
            COALESCE(SUM(sl.qty) FILTER (WHERE sl.status='REJECTED'),0)                              AS rejected,
            COALESCE(SUM(sl.qty) FILTER (WHERE sl.status='ACCEPTED'),0)                              AS accepted,
            COALESCE(SUM(sl.qty) FILTER (WHERE sl.status='ACCEPTED' AND loc.kind IN ('RECEIVING','STORE','RACK','FLOOR')),0) AS eligible,
            COALESCE((SELECT SUM(r.qty) FROM reservation r WHERE r.lot_id = l.id AND r.status='active'),0) AS reserved
       FROM lot l
       JOIN item i ON i.id = l.item_id
       LEFT JOIN stock_ledger sl ON sl.lot_id = l.id
       LEFT JOIN location loc ON loc.id = sl.location_id
      WHERE ($1::uuid[] IS NULL OR l.site_id = ANY($1::uuid[]))
        AND ($2::uuid IS NULL OR l.site_id = $2) AND ($3::text IS NULL OR i.code = $3)
      GROUP BY l.id, i.code, i.name, i.stock_unit
      ORDER BY l.created_at DESC LIMIT 500`,
    [sites, f.siteId ?? null, f.itemCode ?? null]);
  return r.rows.map((x) => ({
    ...x, held: norm(x.held), rejected: norm(x.rejected), accepted: norm(x.accepted), eligible: norm(x.eligible), reserved: norm(x.reserved),
    available: qSub(x.eligible, x.reserved),
  }));
}

export async function lotLedger(db: Db, userId: string, lotId: string) {
  const lot = (await db.query('SELECT site_id FROM lot WHERE id=$1', [lotId])).rows[0];
  if (!lot || !(await can(db, userId, 'inventory.view', { siteId: lot.site_id }))) throw notFound('Lot');
  return (await db.query(
    `SELECT sl.id, sl.movement_id, sl.movement_type, sl.status, sl.qty, sl.unit, loc.code AS location, sl.source_type, sl.source_id, u.username AS actor, sl.posted_at
       FROM stock_ledger sl JOIN location loc ON loc.id = sl.location_id JOIN app_user u ON u.id = sl.actor_id
      WHERE sl.lot_id=$1 ORDER BY sl.id`, [lotId])).rows;
}

export async function auditTrail(db: Db, userId: string, entityType: string, entityId: string) {
  if (!(await can(db, userId, 'audit.view'))) throw notFound('Audit trail');
  return (await db.query(
    `SELECT a.at, a.action, u.username AS actor, a.before, a.after, a.reason
       FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_id WHERE a.entity_type=$1 AND a.entity_id=$2 ORDER BY a.id`, [entityType, entityId])).rows;
}

export async function listItems(db: Db, userId: string) {
  if (!(await can(db, userId, 'item.view', { anySite: true }))) return [];
  return (await db.query(`SELECT id, code, name, kind, stock_unit, tracking, status, version FROM item ORDER BY code LIMIT 500`)).rows;
}

export async function listPartners(db: Db, userId: string) {
  if (!(await can(db, userId, 'partner.view', { anySite: true }))) return [];
  const bank = await can(db, userId, 'partner.bank.view', { anySite: true });
  return (await db.query(`SELECT id, code, name, is_vendor, is_subcontractor, is_customer, gstin, status, version,
      CASE WHEN $1 THEN bank_account WHEN bank_account IS NULL THEN NULL ELSE '••••' || right(bank_account, 4) END AS bank_account
    FROM partner ORDER BY code LIMIT 500`, [bank])).rows;
}

export async function myAccess(db: Db, userId: string) {
  return (await db.query(
    `SELECT ur.role_key AS role, s.code AS site, ur.max_amount, ur.valid_until,
            array_agg(rp.permission ORDER BY rp.permission) AS permissions
       FROM user_role ur LEFT JOIN site s ON s.id = ur.site_id JOIN role_permission rp ON rp.role_key = ur.role_key
      WHERE ur.user_id=$1 AND ur.valid_from <= now() AND (ur.valid_until IS NULL OR ur.valid_until > now())
      GROUP BY ur.id, s.code`, [userId])).rows;
}

export async function listAdjustments(db: Db, userId: string) {
  const sites = await visibleSites(db, userId, 'inventory.view');
  if (sites && !sites.length) return [];
  return (await db.query(
    `SELECT a.id, a.number, a.status, a.version, a.qty_delta, a.reason, a.site_id, l.label, i.code AS item_code, pu.username AS proposed_by, au.username AS approved_by
       FROM stock_adjustment a JOIN lot l ON l.id = a.lot_id JOIN item i ON i.id = l.item_id
       JOIN app_user pu ON pu.id = a.proposed_by LEFT JOIN app_user au ON au.id = a.approved_by
      WHERE ($1::uuid[] IS NULL OR a.site_id = ANY($1::uuid[])) ORDER BY a.created_at DESC LIMIT 100`, [sites])).rows;
}

export async function lotReservations(db: Db, userId: string, lotId: string) {
  const lot = (await db.query('SELECT site_id FROM lot WHERE id=$1', [lotId])).rows[0];
  if (!lot || !(await can(db, userId, 'inventory.view', { siteId: lot.site_id }))) return [];
  return (await db.query(
    `SELECT r.id, r.qty, r.demand_type, r.demand_ref, r.status, u.username AS requested_by, r.created_at
       FROM reservation r JOIN app_user u ON u.id = r.requested_by WHERE r.lot_id=$1 ORDER BY r.created_at DESC`, [lotId])).rows;
}

export async function recentAudit(db: Db, userId: string, limit = 120) {
  if (!(await can(db, userId, 'audit.view', { anySite: true }))) return null;
  return (await db.query(
    `SELECT a.id, a.at, a.action, a.entity_type, u.username AS actor, a.reason, a.after
       FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT $1`, [limit])).rows;
}

/** Roles, their permissions and who holds them (reference view for the access page). */
export async function accessMatrix(db: Db) {
  const roles = (await db.query(
    `SELECT r.key, r.description, array_agg(rp.permission || CASE WHEN rp.banded THEN ' (banded)' ELSE '' END ORDER BY rp.permission) AS permissions
       FROM role r JOIN role_permission rp ON rp.role_key = r.key GROUP BY r.key, r.description ORDER BY r.key`)).rows;
  const holders = (await db.query(
    `SELECT u.username, u.display_name, ur.role_key, s.code AS site, ur.max_amount
       FROM user_role ur JOIN app_user u ON u.id = ur.user_id LEFT JOIN site s ON s.id = ur.site_id ORDER BY u.username`)).rows;
  return { roles, holders };
}

export async function referenceData(db: Db) {
  const locations = (await db.query(`SELECT id, site_id, code, name, kind FROM location ORDER BY code`)).rows;
  const sites = (await db.query(`SELECT id, code, name FROM site ORDER BY code`)).rows;
  return { locations, sites };
}
