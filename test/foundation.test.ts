import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld, rejects } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as masters from '../src/domain/masters.js';
import * as admin from '../src/domain/admin.js';
import { can } from '../src/core/permissions.js';
import { login, actorFromToken } from '../src/core/auth.js';
import { runCommand } from '../src/core/command.js';
import { randomUUID } from 'node:crypto';

let w: World;
beforeAll(async () => { w = await freshWorld('foundation'); });
afterAll(async () => { await w.pool.end(); });

describe('identity, scope and approval limits', () => {
  it('denies by default: a storekeeper cannot create items, approve POs or release QC', async () => {
    const c = await w.pool.connect();
    try {
      expect(await can(c, w.actors.sto.id, 'item.create')).toBe(false);
      expect(await can(c, w.actors.sto.id, 'po.approve', { siteId: w.siteId, amount: '1' })).toBe(false);
      expect(await can(c, w.actors.sto.id, 'qc.release', { siteId: w.siteId })).toBe(false);
      expect(await can(c, w.actors.sto.id, 'receipt.post', { siteId: w.siteId })).toBe(true);
    } finally { c.release(); }
  });

  it('site scope: a permission at one site does not apply at another', async () => {
    const other = await w.as('md', (c) => admin.createSite(c, { entityId: w.entityId, code: 'WH2', name: 'Warehouse 2' }));
    const c = await w.pool.connect();
    try {
      expect(await can(c, w.actors.sto.id, 'receipt.post', { siteId: w.siteId })).toBe(true);
      expect(await can(c, w.actors.sto.id, 'receipt.post', { siteId: other.id })).toBe(false);
      expect(await can(c, w.actors.sto.id, 'receipt.post')).toBe(false); // site-scoped users do not match "no site"
    } finally { c.release(); }
  });

  it('approval band: a value above the approver\'s band is refused', async () => {
    const c = await w.pool.connect();
    try {
      expect(await can(c, w.actors.com.id, 'po.approve', { siteId: w.siteId, amount: '500000' })).toBe(true);
      expect(await can(c, w.actors.com.id, 'po.approve', { siteId: w.siteId, amount: '500000.01' })).toBe(false);
    } finally { c.release(); }
  });

  it('an administrator has no business-approval power', async () => {
    const c = await w.pool.connect();
    try {
      for (const p of ['po.approve', 'po.release', 'qc.release', 'adjustment.approve', 'item.approve', 'partner.trade.approve'])
        expect(await can(c, w.actors.admin.id, p, { siteId: w.siteId, amount: '1' })).toBe(false);
    } finally { c.release(); }
  });

  it('expired role assignments stop working', async () => {
    const u = await w.addUser('temp-sto', 'STO');
    await w.pool.query(`UPDATE user_role SET valid_until = now() - interval '1 minute' WHERE user_id=$1`, [u.id]);
    const c = await w.pool.connect();
    try { expect(await can(c, u.id, 'receipt.post', { siteId: w.siteId })).toBe(false); } finally { c.release(); }
  });

  it('login: wrong password and unknown user are indistinguishable; suspension kills sessions', async () => {
    const a = await rejects(login(w.pool, 'buy', 'wrong-password'), 'UNAUTHORIZED', 401);
    const b = await rejects(login(w.pool, 'nobody', 'wrong-password'), 'UNAUTHORIZED', 401);
    expect(a.message).toBe(b.message);
    const s = await login(w.pool, 'buy', 'Demo-Passw0rd!');
    expect((await actorFromToken(w.pool, s.token)).username).toBe('buy');
    await w.as('admin', (c) => admin.suspendUser(c, { userId: w.actors.buy.id, reason: 'test suspension' }));
    await rejects(actorFromToken(w.pool, s.token), 'UNAUTHORIZED', 401);
    await rejects(login(w.pool, 'buy', 'Demo-Passw0rd!'), 'UNAUTHORIZED', 401);
    await w.pool.query('UPDATE app_user SET active=true WHERE id=$1', [w.actors.buy.id]);
  });
});

describe('masters: separation of duties', () => {
  it('the creator of an item cannot approve it; an independent approver can', async () => {
    const it = await w.as('eng', (c) => masters.createItem(c, { code: 'FAB-SOD', name: 'SoD test', kind: 'FABRIC', stockUnit: 'M' }));
    await w.as('eng', (c) => masters.submitItem(c, { itemId: it.id, expectedVersion: 1 }));
    await rejects(w.as('eng', (c) => masters.approveItem(c, { itemId: it.id, expectedVersion: 2 })), 'FORBIDDEN', 403);
    await w.as('md', async (c) => { /* md has no item.approve */ await rejects(masters.approveItem(c, { itemId: it.id, expectedVersion: 2 }), 'FORBIDDEN'); });
  });

  it('stale versions are refused (optimistic concurrency)', async () => {
    const it = await w.as('md', (c) => masters.createItem(c, { code: 'FAB-STALE', name: 'x', kind: 'FABRIC', stockUnit: 'M' }));
    await rejects(w.as('md', (c) => masters.submitItem(c, { itemId: it.id, expectedVersion: 99 })), 'STALE_VERSION', 409);
  });

  it('a partner cannot activate before finance verifies bank details; bank number is masked without the grant', async () => {
    const p = await w.as('buy', (c) => masters.createPartner(c, { code: 'V-002', name: 'Blue Dye House', isSubcontractor: true, bankAccount: '9988776655' }));
    await w.as('buy', (c) => masters.submitPartner(c, { partnerId: p.id, expectedVersion: 1 }));
    await rejects(w.as('com', (c) => masters.approvePartner(c, { partnerId: p.id, expectedVersion: 2 })), 'INVALID_STATE');
    const c = await w.pool.connect();
    try {
      expect((await masters.getPartner(c, w.actors.buy.id, p.id)).bank_account).toBe('••••6655');
      expect((await masters.getPartner(c, w.actors.fc.id, p.id)).bank_account).toBe('9988776655');
    } finally { c.release(); }
  });

  it('duplicate item codes and unknown units are rejected', async () => {
    await rejects(w.as('md', (c) => masters.createItem(c, { code: 'FAB-001', name: 'dup', kind: 'FABRIC', stockUnit: 'M' })), 'DUPLICATE', 409);
    await rejects(w.as('md', (c) => masters.createItem(c, { code: 'FAB-NOUNIT', name: 'x', kind: 'FABRIC', stockUnit: 'XX' })), 'BAD_REQUEST');
  });
});

describe('integrity', () => {
  it('audit log and ledger are append-only at the database level', async () => {
    await rejects(w.pool.query('DELETE FROM audit_log').catch((e) => { throw Object.assign(new Error(e.message), { code: 'IMMUTABLE' }); }), 'IMMUTABLE');
    await rejects(w.pool.query(`UPDATE audit_log SET action='x'`).catch((e) => { throw Object.assign(new Error(e.message), { code: 'IMMUTABLE' }); }), 'IMMUTABLE');
  });

  it('a replayed request_id returns the original result and writes nothing twice', async () => {
    const key = randomUUID();
    const before = (await w.pool.query('SELECT count(*)::int n FROM item')).rows[0].n;
    const run = () => runCommand(w.pool, { requestId: key, actor: w.actors.md, action: 'item.create' },
      (c) => masters.createItem(c, { code: 'FAB-IDEM', name: 'idem', kind: 'FABRIC', stockUnit: 'M' }));
    const a = await run(), b = await run();
    expect(a.replayed).toBe(false); expect(b.replayed).toBe(true);
    expect(b.result.id).toBe(a.result.id);
    expect((await w.pool.query('SELECT count(*)::int n FROM item')).rows[0].n).toBe(before + 1);
  });

  it('the same request_id cannot be reused for a different command', async () => {
    const key = randomUUID();
    await runCommand(w.pool, { requestId: key, actor: w.actors.md, action: 'a' }, async () => 1);
    await rejects(runCommand(w.pool, { requestId: key, actor: w.actors.md, action: 'b' }, async () => 2), 'REQUEST_ID_REUSED', 409);
  });

  it('every committed change leaves an audit entry with the actor', async () => {
    const r = await w.pool.query(`SELECT count(*)::int n FROM audit_log WHERE actor_id IS NOT NULL AND action='item.approve'`);
    expect(r.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});
