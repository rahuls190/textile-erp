import type { Ctx } from '../core/command.js';
import { assertCan, can } from '../core/permissions.js';
import { audit, emit } from '../core/audit.js';
import { hashPassword, checkPasswordStrength } from '../core/auth.js';
import { badRequest, forbidden, invalidState, notFound } from '../core/errors.js';
import type { Db } from '../db/pool.js';

// ── Users & access (ADM provisions; ADM has no business-approval rights) ──
export async function createUser(ctx: Ctx, i: { username: string; displayName: string; password: string; email?: string | null; mustChangePassword?: boolean }) {
  await assertCan(ctx.db, ctx.actor.id, 'user.manage');
  if (!/^[a-z0-9._-]{2,32}$/.test(i.username)) throw badRequest('Username: 2–32 characters, lower-case letters, digits, dot, dash or underscore');
  checkPasswordStrength(i.password);
  const r = await ctx.db.query(
    `INSERT INTO app_user(username, display_name, email, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5) RETURNING id, username, display_name`,
    [i.username, i.displayName, i.email ?? null, await hashPassword(i.password), !!i.mustChangePassword]);
  await audit(ctx, { action: 'user.create', entityType: 'app_user', entityId: r.rows[0].id, after: { username: i.username, email: i.email ?? null } });
  return r.rows[0];
}

export async function updateUser(ctx: Ctx, i: { userId: string; displayName?: string; email?: string | null }) {
  await assertCan(ctx.db, ctx.actor.id, 'user.manage');
  const before = (await ctx.db.query('SELECT display_name, email FROM app_user WHERE id=$1', [i.userId])).rows[0];
  if (!before) throw notFound('User');
  const r = await ctx.db.query('UPDATE app_user SET display_name=COALESCE($2, display_name), email=CASE WHEN $4 THEN $3 ELSE email END WHERE id=$1 RETURNING id, username, display_name, email',
    [i.userId, i.displayName ?? null, i.email ?? null, i.email !== undefined]);
  await audit(ctx, { action: 'user.update', entityType: 'app_user', entityId: i.userId, before, after: { display_name: r.rows[0].display_name, email: r.rows[0].email } });
  return r.rows[0];
}

/** Role grants are the most sensitive thing an administrator does: never to yourself. */
export async function assignRole(ctx: Ctx, i: { userId: string; roleKey: string; siteId?: string | null; maxAmount?: string | null; validUntil?: string | null }) {
  await assertCan(ctx.db, ctx.actor.id, 'access.assign');
  if (i.userId === ctx.actor.id) throw forbidden('Separation of duties: you cannot change your own access');
  if (!(await ctx.db.query('SELECT 1 FROM app_user WHERE id=$1', [i.userId])).rowCount) throw notFound('User');
  if (!(await ctx.db.query('SELECT 1 FROM role WHERE key=$1', [i.roleKey])).rowCount) throw notFound(`Role ${i.roleKey}`);
  if (i.siteId && !(await ctx.db.query('SELECT 1 FROM site WHERE id=$1', [i.siteId])).rowCount) throw notFound('Site');
  if (i.maxAmount != null && Number(i.maxAmount) < 0) throw badRequest('An approval limit cannot be negative');
  if (i.validUntil && new Date(i.validUntil) <= new Date()) throw badRequest('The end date must be in the future');
  const dup = await ctx.db.query(
    `SELECT 1 FROM user_role WHERE user_id=$1 AND role_key=$2 AND site_id IS NOT DISTINCT FROM $3::uuid AND revoked_at IS NULL AND (valid_until IS NULL OR valid_until > now())`,
    [i.userId, i.roleKey, i.siteId ?? null]);
  if (dup.rowCount) throw invalidState('This person already holds that role at that site. Revoke it first to change the limits');
  const r = await ctx.db.query(
    `INSERT INTO user_role(user_id, role_key, site_id, max_amount, valid_until, granted_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [i.userId, i.roleKey, i.siteId ?? null, i.maxAmount ?? null, i.validUntil ?? null, ctx.actor.id]);
  await audit(ctx, { action: 'access.assign', entityType: 'user_role', entityId: r.rows[0].id, after: i });
  return { id: r.rows[0].id };
}

export async function revokeRole(ctx: Ctx, i: { userRoleId: string; reason: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'access.assign');
  if (!i.reason) throw badRequest('A reason is required');
  const ur = (await ctx.db.query('SELECT * FROM user_role WHERE id=$1 FOR UPDATE', [i.userRoleId])).rows[0];
  if (!ur) throw notFound('Role assignment');
  if (ur.user_id === ctx.actor.id) throw forbidden('Separation of duties: you cannot change your own access');
  if (ur.revoked_at) throw invalidState('Already revoked');
  // Never strand the system: at least one other active administrator must remain
  if (ur.role_key === 'ADM') {
    const others = await ctx.db.query(
      `SELECT 1 FROM user_role x JOIN app_user u ON u.id = x.user_id AND u.active
        WHERE x.role_key='ADM' AND x.revoked_at IS NULL AND x.id <> $1 LIMIT 1`, [ur.id]);
    if (!others.rowCount) throw invalidState('This is the last administrator. Add another before removing this one');
  }
  await ctx.db.query('UPDATE user_role SET revoked_at=now(), revoked_by=$2 WHERE id=$1', [i.userRoleId, ctx.actor.id]);
  await audit(ctx, { action: 'access.revoke', entityType: 'user_role', entityId: i.userRoleId, before: { user_id: ur.user_id, role: ur.role_key, site_id: ur.site_id }, reason: i.reason });
  return { id: i.userRoleId };
}

/** Local emergency suspension (blueprint §06): audited, immediate. */
export async function suspendUser(ctx: Ctx, i: { userId: string; reason: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'user.manage');
  if (!i.reason) throw badRequest('A reason is required');
  if (i.userId === ctx.actor.id) throw forbidden('You cannot suspend your own account');
  const adm = await ctx.db.query(
    `SELECT 1 FROM user_role x JOIN app_user u ON u.id = x.user_id AND u.active WHERE x.role_key='ADM' AND x.revoked_at IS NULL AND x.user_id <> $1 LIMIT 1`, [i.userId]);
  const isAdm = await ctx.db.query(`SELECT 1 FROM user_role WHERE user_id=$1 AND role_key='ADM' AND revoked_at IS NULL`, [i.userId]);
  if (isAdm.rowCount && !adm.rowCount) throw invalidState('This is the last administrator and cannot be suspended');
  const r = await ctx.db.query('UPDATE app_user SET active=false WHERE id=$1 RETURNING id', [i.userId]);
  if (!r.rowCount) throw notFound('User');
  await ctx.db.query('DELETE FROM session WHERE user_id=$1', [i.userId]);
  await audit(ctx, { action: 'user.suspend', entityType: 'app_user', entityId: i.userId, reason: i.reason });
  return { userId: i.userId, active: false };
}

export async function reactivateUser(ctx: Ctx, i: { userId: string; reason: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'user.manage');
  if (!i.reason) throw badRequest('A reason is required');
  const r = await ctx.db.query('UPDATE app_user SET active=true, failed_attempts=0, locked_until=NULL WHERE id=$1 RETURNING id', [i.userId]);
  if (!r.rowCount) throw notFound('User');
  await audit(ctx, { action: 'user.reactivate', entityType: 'app_user', entityId: i.userId, reason: i.reason });
  return { userId: i.userId, active: true };
}

export async function unlockUser(ctx: Ctx, i: { userId: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'user.manage');
  const r = await ctx.db.query('UPDATE app_user SET failed_attempts=0, locked_until=NULL WHERE id=$1 RETURNING id', [i.userId]);
  if (!r.rowCount) throw notFound('User');
  await audit(ctx, { action: 'user.unlock', entityType: 'app_user', entityId: i.userId });
  return { userId: i.userId };
}

/** Administrator sets a temporary password; the person must replace it at next sign-in. All their sessions end. */
export async function resetPassword(ctx: Ctx, i: { userId: string; temporaryPassword: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'user.manage');
  if (i.userId === ctx.actor.id) throw forbidden('Use "change my password" for your own account');
  checkPasswordStrength(i.temporaryPassword);
  const r = await ctx.db.query(
    `UPDATE app_user SET password_hash=$2, must_change_password=true, failed_attempts=0, locked_until=NULL, password_changed_at=now() WHERE id=$1 RETURNING id`,
    [i.userId, await hashPassword(i.temporaryPassword)]);
  if (!r.rowCount) throw notFound('User');
  await ctx.db.query('DELETE FROM session WHERE user_id=$1', [i.userId]);
  await audit(ctx, { action: 'user.password_reset', entityType: 'app_user', entityId: i.userId });
  return { userId: i.userId };
}

// ── Roles: who may do what is data, not code ──
export async function createRole(ctx: Ctx, i: { key: string; description: string; permissions: string[] }) {
  await assertCan(ctx.db, ctx.actor.id, 'role.manage');
  if (!/^[A-Z][A-Z0-9_]{1,15}$/.test(i.key)) throw badRequest('Role key: 2–16 capital letters, digits or underscore, starting with a letter');
  if (!i.description.trim()) throw badRequest('A description is required');
  await ctx.db.query('INSERT INTO role(key, description, is_system) VALUES ($1,$2,false)', [i.key, i.description]);
  await writePermissions(ctx.db, i.key, i.permissions);
  await audit(ctx, { action: 'role.create', entityType: 'role', after: i });
  return { key: i.key };
}

async function writePermissions(db: Db, key: string, perms: string[]) {
  const defs = (await db.query('SELECT key, bandable FROM permission_def')).rows as { key: string; bandable: boolean }[];
  const known = new Map(defs.map((d) => [d.key, d.bandable]));
  const bad = perms.filter((p) => !known.has(p));
  if (bad.length) throw badRequest(`Unknown permission: ${bad.join(', ')}`);
  await db.query('DELETE FROM role_permission WHERE role_key=$1', [key]);
  for (const p of new Set(perms)) await db.query('INSERT INTO role_permission(role_key, permission, banded) VALUES ($1,$2,$3)', [key, p, known.get(p)]);
}

export async function setRolePermissions(ctx: Ctx, i: { roleKey: string; permissions: string[]; reason: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'role.manage');
  if (!i.reason) throw badRequest('A reason is required');
  if (i.roleKey === 'ADM') throw forbidden('The administrator role is fixed so the system cannot be locked out');
  const role = (await ctx.db.query('SELECT key FROM role WHERE key=$1', [i.roleKey])).rows[0];
  if (!role) throw notFound(`Role ${i.roleKey}`);
  const before = (await ctx.db.query('SELECT permission FROM role_permission WHERE role_key=$1 ORDER BY permission', [i.roleKey])).rows.map((r) => r.permission);
  await writePermissions(ctx.db, i.roleKey, i.permissions);
  const after = [...new Set(i.permissions)].sort();
  await audit(ctx, { action: 'role.permissions', entityType: 'role', before: { role: i.roleKey, permissions: before }, after: { role: i.roleKey, permissions: after, added: after.filter((p) => !before.includes(p)), removed: before.filter((p: string) => !after.includes(p)) }, reason: i.reason });
  return { roleKey: i.roleKey, count: after.length };
}

export async function deleteRole(ctx: Ctx, i: { roleKey: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'role.manage');
  const role = (await ctx.db.query('SELECT is_system FROM role WHERE key=$1', [i.roleKey])).rows[0];
  if (!role) throw notFound(`Role ${i.roleKey}`);
  if (role.is_system) throw forbidden('Built-in roles cannot be deleted');
  if ((await ctx.db.query('SELECT 1 FROM user_role WHERE role_key=$1 AND revoked_at IS NULL LIMIT 1', [i.roleKey])).rowCount) throw invalidState('Someone still holds this role. Revoke it first');
  await ctx.db.query('DELETE FROM role_permission WHERE role_key=$1', [i.roleKey]);
  await ctx.db.query('DELETE FROM user_role WHERE role_key=$1', [i.roleKey]);   // only revoked history remains
  await ctx.db.query('DELETE FROM role WHERE key=$1', [i.roleKey]);
  await audit(ctx, { action: 'role.delete', entityType: 'role', before: { key: i.roleKey } });
  return { key: i.roleKey };
}

// ── Reads for the console ──
export async function listUsers(db: Db, actorId: string) {
  if (!(await can(db, actorId, 'user.view', { anySite: true }))) return null;
  const users = (await db.query(
    `SELECT u.id, u.username, u.display_name, u.email, u.active, u.must_change_password, u.last_login_at, u.failed_attempts,
            (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
            (SELECT count(*)::int FROM session s WHERE s.user_id = u.id AND s.expires_at > now()) AS sessions
       FROM app_user u ORDER BY u.username`)).rows;
  const grants = (await db.query(
    `SELECT ur.id, ur.user_id, ur.role_key, ur.max_amount, ur.valid_until, s.code AS site
       FROM user_role ur LEFT JOIN site s ON s.id = ur.site_id
      WHERE ur.revoked_at IS NULL AND (ur.valid_until IS NULL OR ur.valid_until > now()) ORDER BY ur.created_at`)).rows;
  return users.map((u) => ({ ...u, grants: grants.filter((g) => g.user_id === u.id) }));
}

export async function listLoginEvents(db: Db, actorId: string, limit = 60) {
  if (!(await can(db, actorId, 'user.view', { anySite: true }))) return null;
  return (await db.query('SELECT at, username, ok, reason FROM login_event ORDER BY id DESC LIMIT $1', [limit])).rows;
}

export async function permissionCatalogueRows(db: Db) {
  return (await db.query('SELECT key, area, label, bandable FROM permission_def ORDER BY area, key')).rows as { key: string; area: string; label: string; bandable: boolean }[];
}

export async function listRoles(db: Db) {
  const roles = (await db.query('SELECT key, description, is_system FROM role ORDER BY key')).rows;
  const perms = (await db.query('SELECT role_key, permission, banded FROM role_permission ORDER BY permission')).rows;
  const holders = (await db.query(`SELECT role_key, count(*)::int AS n FROM user_role WHERE revoked_at IS NULL AND (valid_until IS NULL OR valid_until > now()) GROUP BY role_key`)).rows;
  return roles.map((r) => ({ ...r, permissions: perms.filter((p) => p.role_key === r.key).map((p) => p.permission as string),
    holders: holders.find((h) => h.role_key === r.key)?.n ?? 0 }));
}

// ── M01 Company, sites, locations ──
export async function createEntity(ctx: Ctx, i: { name: string; gstin?: string; state?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'org.create');
  const r = await ctx.db.query(`INSERT INTO legal_entity(name, gstin, state) VALUES ($1,$2,$3) RETURNING *`, [i.name, i.gstin ?? null, i.state ?? null]);
  await audit(ctx, { action: 'org.entity.create', entityType: 'legal_entity', entityId: r.rows[0].id, after: r.rows[0] });
  return r.rows[0];
}

export async function createSite(ctx: Ctx, i: { entityId: string; code: string; name: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'org.create');
  const r = await ctx.db.query(`INSERT INTO site(entity_id, code, name) VALUES ($1,$2,$3) RETURNING *`, [i.entityId, i.code, i.name]);
  await audit(ctx, { action: 'org.site.create', entityType: 'site', entityId: r.rows[0].id, after: r.rows[0] });
  await emit(ctx, { type: 'site.created', entityType: 'site', entityId: r.rows[0].id, siteId: r.rows[0].id, payload: r.rows[0] });
  return r.rows[0];
}

export async function createLocation(ctx: Ctx, i: { siteId: string; code: string; name: string; kind: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'location.configure', { siteId: i.siteId }).catch(async () =>
    assertCan(ctx.db, ctx.actor.id, 'org.create'));
  const r = await ctx.db.query(`INSERT INTO location(site_id, code, name, kind) VALUES ($1,$2,$3,$4) RETURNING *`, [i.siteId, i.code, i.name, i.kind]);
  await audit(ctx, { action: 'org.location.create', entityType: 'location', entityId: r.rows[0].id, after: r.rows[0] });
  return r.rows[0];
}

export async function createUnit(ctx: Ctx, i: { code: string; name: string; precision: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'unit.create');
  const r = await ctx.db.query(`INSERT INTO unit(code, name, precision) VALUES ($1,$2,$3) RETURNING *`, [i.code, i.name, i.precision]);
  await audit(ctx, { action: 'unit.create', entityType: 'unit', after: r.rows[0] });
  return r.rows[0];
}
