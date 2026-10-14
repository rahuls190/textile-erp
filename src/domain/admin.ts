import type { Ctx } from '../core/command.js';
import { assertCan } from '../core/permissions.js';
import { audit, emit } from '../core/audit.js';
import { hashPassword } from '../core/auth.js';
import { badRequest, notFound } from '../core/errors.js';

// ── Users & access (ADM provisions; ADM has no business-approval rights) ──
export async function createUser(ctx: Ctx, i: { username: string; displayName: string; password: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'user.manage');
  if (i.password.length < 10) throw badRequest('Password must be at least 10 characters');
  const r = await ctx.db.query(
    `INSERT INTO app_user(username, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id, username, display_name`,
    [i.username, i.displayName, await hashPassword(i.password)]);
  await audit(ctx, { action: 'user.create', entityType: 'app_user', entityId: r.rows[0].id, after: { username: i.username } });
  return r.rows[0];
}

export async function assignRole(ctx: Ctx, i: { userId: string; roleKey: string; siteId?: string | null; maxAmount?: string | null; validUntil?: string | null }) {
  await assertCan(ctx.db, ctx.actor.id, 'access.assign');
  if (!(await ctx.db.query('SELECT 1 FROM role WHERE key=$1', [i.roleKey])).rowCount) throw notFound(`Role ${i.roleKey}`);
  if (i.siteId && !(await ctx.db.query('SELECT 1 FROM site WHERE id=$1', [i.siteId])).rowCount) throw notFound('Site');
  const r = await ctx.db.query(
    `INSERT INTO user_role(user_id, role_key, site_id, max_amount, valid_until) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [i.userId, i.roleKey, i.siteId ?? null, i.maxAmount ?? null, i.validUntil ?? null]);
  await audit(ctx, { action: 'access.assign', entityType: 'user_role', entityId: r.rows[0].id, after: i });
  return { id: r.rows[0].id };
}

/** Local emergency suspension (blueprint §06): audited, immediate. */
export async function suspendUser(ctx: Ctx, i: { userId: string; reason: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'user.manage');
  if (!i.reason) throw badRequest('A reason is required');
  await ctx.db.query('UPDATE app_user SET active=false WHERE id=$1', [i.userId]);
  await ctx.db.query('DELETE FROM session WHERE user_id=$1', [i.userId]);
  await audit(ctx, { action: 'user.suspend', entityType: 'app_user', entityId: i.userId, reason: i.reason });
  return { userId: i.userId, active: false };
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
