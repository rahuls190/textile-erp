import type { Db } from '../db/pool.js';
import { forbidden } from './errors.js';

export interface Scope {
  siteId?: string | null;
  amount?: string | number | null;
  /** Company-level master data (items, partners, rates): the role may be held at any site. */
  anySite?: boolean;
}

/**
 * Effective permission = role action AND site scope AND validity AND approval band (deny by default).
 * A permission with no siteId only matches company-wide assignments.
 */
export async function can(db: Db, userId: string, permission: string, scope: Scope = {}): Promise<boolean> {
  const r = await db.query(
    `SELECT 1
       FROM user_role ur
       JOIN app_user u ON u.id = ur.user_id AND u.active
       JOIN role_permission rp ON rp.role_key = ur.role_key AND rp.permission = $2
      WHERE ur.user_id = $1 AND ur.revoked_at IS NULL
        AND ur.valid_from <= now() AND (ur.valid_until IS NULL OR ur.valid_until > now())
        AND (ur.site_id IS NULL OR $5::boolean OR ($3::uuid IS NOT NULL AND ur.site_id = $3::uuid))
        AND (NOT rp.banded OR $4::numeric IS NULL OR (ur.max_amount IS NOT NULL AND $4::numeric <= ur.max_amount))
      LIMIT 1`,
    [userId, permission, scope.siteId ?? null, scope.amount ?? null, scope.anySite ?? false],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function assertCan(db: Db, userId: string, permission: string, scope: Scope = {}): Promise<void> {
  if (!(await can(db, userId, permission, scope)))
    throw forbidden(`Not permitted: ${permission}${scope.siteId ? ' at this site' : ''}${scope.amount != null ? ` for amount ${scope.amount}` : ''}`);
}

/** Creator cannot approve their own sensitive record (blueprint §08 separation of duties). */
export function assertIndependent(actorId: string, creatorId: string | null | undefined, what: string): void {
  if (creatorId && actorId === creatorId) throw forbidden(`Separation of duties: you cannot approve a ${what} you created or proposed`);
}

/**
 * Which sites may this user see for a permission? null = every site (company-wide assignment), [] = none.
 * Lists and reports must filter by this — row scope is enforced in the query, not the UI.
 */
export async function visibleSites(db: Db, userId: string, permission: string): Promise<string[] | null> {
  const r = await db.query(
    `SELECT ur.site_id
       FROM user_role ur
       JOIN app_user u ON u.id = ur.user_id AND u.active
       JOIN role_permission rp ON rp.role_key = ur.role_key AND rp.permission = $2
      WHERE ur.user_id = $1 AND ur.revoked_at IS NULL AND ur.valid_from <= now() AND (ur.valid_until IS NULL OR ur.valid_until > now())`,
    [userId, permission]);
  if (r.rows.some((x) => x.site_id === null)) return null;
  return [...new Set(r.rows.map((x) => x.site_id as string))];
}
