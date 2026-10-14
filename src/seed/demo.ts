import { randomUUID } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import { migrate } from '../migrate.js';
import { hashPassword } from '../core/auth.js';
import { runCommand, type Actor, type Ctx } from '../core/command.js';
import { seedRbac } from './rbac.js';
import * as admin from '../domain/admin.js';
import * as masters from '../domain/masters.js';
import { seedHrBase, seedHrRecent } from './hr-demo.js';
import { seedOwnerBase, seedOwnerFloor } from './owner-demo.js';

export interface World {
  pool: Pool;
  actors: Record<string, Actor>;
  siteId: string; entityId: string;
  loc: { rcv: string; store: string; rack: string; transit: string };
  items: { fabric: string; trim: string };
  vendorId: string;
  /** run a command as a named actor with a fresh idempotency key */
  as<T>(who: string, fn: (ctx: Ctx) => Promise<T>, requestId?: string): Promise<T>;
  /** create another user with a role at the site (via the real admin commands) */
  addUser(username: string, roleKey: string, opts?: { maxAmount?: string; siteId?: string | null; displayName?: string }): Promise<Actor>;
}

/** First-run only: the initial system administrator. Everything else goes through permission-checked commands. */
export async function bootstrapAdmin(pool: Pool, username: string, password: string): Promise<Actor> {
  const u = (await pool.query(
    `INSERT INTO app_user(username, display_name, password_hash) VALUES ($1,'System Administrator',$2) RETURNING id`,
    [username, await hashPassword(password)])).rows[0];
  await pool.query(`INSERT INTO user_role(user_id, role_key) VALUES ($1,'ADM')`, [u.id]);
  return { id: u.id, username };
}

export async function buildWorld(pool: Pool, password = 'Demo-Passw0rd!', opts: { recent?: boolean; owner?: boolean } = {}): Promise<World> {
  await migrate(pool);
  await seedRbac(pool);
  const actors: Record<string, Actor> = {};
  actors.admin = await bootstrapAdmin(pool, 'admin', password);

  const as = <T>(who: string, fn: (ctx: Ctx) => Promise<T>, requestId = randomUUID()) =>
    runCommand(pool, { requestId, actor: actors[who], action: 'demo.' + who }, fn).then((r) => r.result);

  // Company-wide roles first (no site exists yet)
  const NAMES: Record<string, string> = { md: 'Rahul Sharma', eng: 'Deepak Menon', fc: 'Anita Desai', aud: 'Karan Mehta', buy: 'Asha Rao', com: 'Vikram Shah', sto: 'Imran Qureshi', inv: 'Lakshmi Iyer', qci: 'Meera Nair', qcm: 'Dr. Suresh Pillai' };
  for (const [name, role] of [['md', 'MD'], ['eng', 'ENG'], ['fc', 'FC'], ['aud', 'AUD']] as const) {
    const u = await as('admin', (c) => admin.createUser(c, { username: name, displayName: NAMES[name], password }));
    actors[name] = { id: u.id, username: name };
    await as('admin', (c) => admin.assignRole(c, { userId: u.id, roleKey: role }));
  }

  const ent = await as('md', (c) => admin.createEntity(c, { name: 'Kalyani Innerwear (demo)', state: 'Karnataka' }));
  const site = await as('md', (c) => admin.createSite(c, { entityId: ent.id, code: 'KLY', name: 'Kalyani Plant 1' }));
  const mk = (code: string, name: string, kind: string) => as('md', (c) => admin.createLocation(c, { siteId: site.id, code, name, kind }));
  const loc = {
    rcv: (await mk('RCV', 'Receiving / QC hold', 'RECEIVING')).id,
    store: (await mk('STORE-A', 'Fabric store A', 'STORE')).id,
    rack: (await mk('RACK-A1', 'Rack A1', 'RACK')).id,
    transit: (await mk('TRN', 'Transit', 'TRANSIT')).id,
  };
  for (const [code, name, p] of [['M', 'Metre', 3], ['PC', 'Piece', 0], ['KG', 'Kilogram', 3]] as const)
    await as('md', (c) => admin.createUnit(c, { code, name, precision: p }));

  const world: World = {
    pool, actors, siteId: site.id, entityId: ent.id, loc, items: { fabric: '', trim: '' }, vendorId: '', as,
    async addUser(username, roleKey, opts = {}) {
      const u = await as('admin', (c) => admin.createUser(c, { username, displayName: opts.displayName ?? NAMES[username] ?? username, password }));
      actors[username] = { id: u.id, username };
      await as('admin', (c) => admin.assignRole(c, {
        userId: u.id, roleKey, siteId: opts.siteId === undefined ? site.id : opts.siteId, maxAmount: opts.maxAmount ?? null }));
      return actors[username];
    },
  };

  // Site-scoped operational roles. Approval bands are explicit: deny by default.
  await world.addUser('buy', 'BUY');
  await world.addUser('com', 'COM', { maxAmount: '500000' });
  await world.addUser('sto', 'STO');
  await world.addUser('inv', 'INV', { maxAmount: '1000' });
  await world.addUser('qci', 'QCI');
  await world.addUser('qcm', 'QCM');

  // Masters: created by one person, approved by an independent one
  const fab = await as('md', (c) => masters.createItem(c, { code: 'FAB-001', name: 'Cotton lycra jersey 180 GSM', kind: 'FABRIC', stockUnit: 'M', tracking: 'ROLL', attributes: { widthCm: 160, gsm: 180 } }));
  await as('md', (c) => masters.submitItem(c, { itemId: fab.id, expectedVersion: 1 }));
  await as('eng', (c) => masters.approveItem(c, { itemId: fab.id, expectedVersion: 2 }));
  const trim = await as('md', (c) => masters.createItem(c, { code: 'TRM-001', name: 'Elastic 12mm', kind: 'TRIM', stockUnit: 'M' }));
  await as('md', (c) => masters.submitItem(c, { itemId: trim.id, expectedVersion: 1 }));
  await as('eng', (c) => masters.approveItem(c, { itemId: trim.id, expectedVersion: 2 }));
  world.items = { fabric: fab.id, trim: trim.id };

  const v = await as('buy', (c) => masters.createPartner(c, { code: 'V-001', name: 'Sunrise Textiles', isVendor: true, gstin: '29ABCDE1234F1Z5', bankAccount: '123456789012' }));
  await as('buy', (c) => masters.submitPartner(c, { partnerId: v.id, expectedVersion: 1 }));
  await as('fc', (c) => masters.verifyPartnerBank(c, { partnerId: v.id, expectedVersion: 2 }));
  await as('com', (c) => masters.approvePartner(c, { partnerId: v.id, expectedVersion: 3 }));
  world.vendorId = v.id;

  const rate = await as('buy', (c) => masters.proposeRate(c, { partnerId: v.id, itemId: fab.id, rate: '250.0000', effectiveFrom: '2026-01-01' }));
  await as('com', (c) => masters.approveRate(c, { rateId: rate.id }));
  await seedHrBase(world, password);
  await seedOwnerBase(world);
  if (opts.recent !== false) await seedHrRecent(world);
  if (opts.owner) await seedOwnerFloor(world);
  return world;
}
