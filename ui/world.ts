import { randomUUID } from 'node:crypto';
import { runCommand, type Actor, type Ctx } from '../src/core/command.js';
import { buildWorld, type World } from '../src/seed/demo.js';
import { seedHrRecent } from '../src/seed/hr-demo.js';
import { refreshOwnerDemo } from '../src/seed/owner-demo.js';
import type { LitePool } from './lite-pool.js';

/** Rebuild the World handle from an already-seeded database (page reload with persisted data). */
export async function restoreWorld(pool: LitePool): Promise<World> {
  const users = (await pool.query('SELECT id, username FROM app_user')).rows;
  const actors: Record<string, Actor> = {};
  for (const u of users) actors[u.username] = { id: u.id, username: u.username };
  const site = (await pool.query(`SELECT id, entity_id FROM site WHERE code='KLY'`)).rows[0];
  const locs = (await pool.query('SELECT id, code FROM location WHERE site_id=$1', [site.id])).rows;
  const byCode = (c: string) => locs.find((l) => l.code === c)!.id as string;
  const items = (await pool.query('SELECT id, code FROM item')).rows;
  const vendor = (await pool.query(`SELECT id FROM partner WHERE code='V-001'`)).rows[0];
  const as = <T>(who: string, fn: (ctx: Ctx) => Promise<T>, requestId = randomUUID()) =>
    runCommand(pool as never, { requestId, actor: actors[who], action: 'ui.' + who }, fn).then((r) => r.result);
  return {
    pool: pool as never, actors, siteId: site.id, entityId: site.entity_id,
    loc: { rcv: byCode('RCV'), store: byCode('STORE-A'), rack: byCode('RACK-A1'), transit: byCode('TRN') },
    items: { fabric: items.find((i) => i.code === 'FAB-001')!.id, trim: items.find((i) => i.code === 'TRM-001')!.id },
    vendorId: vendor.id, as,
    async addUser() { throw new Error('not available in the browser demo'); },
  };
}

export async function isSeeded(pool: LitePool): Promise<boolean> {
  const t = (await pool.query(`SELECT to_regclass('public.app_user') AS t`)).rows[0].t;
  return !!t && (await pool.query('SELECT count(*)::int AS n FROM app_user')).rows[0].n > 0;
}

export async function openWorld(pool: LitePool, onStage: (s: string) => void): Promise<World> {
  const seeded = (await pool.query(`SELECT to_regclass('public.app_user') AS t`)).rows[0].t;
  if (seeded && (await pool.query('SELECT count(*)::int AS n FROM app_user')).rows[0].n > 0) {
    onStage('Opening your demo…');
    const world = await restoreWorld(pool);
    if (!(await pool.query('SELECT 1 FROM attendance LIMIT 1')).rowCount) { onStage('Preparing this month\u2019s attendance and leave…'); await seedHrRecent(world); }
    if (!(await pool.query('SELECT 1 FROM escalation LIMIT 1')).rowCount) { onStage('Preparing the factory floor…'); await refreshOwnerDemo(world); }
    return world;
  }
  onStage('Creating the demo company, roles and master data…');
  const built = await buildWorld(pool as never, undefined, { owner: true, sales: true, masters: true }); await refreshOwnerDemo(built); return built;
}
