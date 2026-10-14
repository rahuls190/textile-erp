import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld, rejects } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as admin from '../src/domain/admin.js';
import * as po from '../src/domain/po.js';
import { can } from '../src/core/permissions.js';
import { login, changeOwnPassword, MAX_FAILED_ATTEMPTS } from '../src/core/auth.js';

let w: World;
beforeAll(async () => { w = await freshWorld('admin'); });
afterAll(async () => { await w.pool.end(); });

const PW = 'Demo-Passw0rd!';
const mk = (u: string, role?: string) => w.as('admin', async (c) => {
  const x = await admin.createUser(c, { username: u, displayName: u, password: PW });
  w.actors[u] = { id: x.id, username: u };
  if (role) await admin.assignRole(c, { userId: x.id, roleKey: role, siteId: w.siteId });
  return x;
});

describe('login hardening', () => {
  it('locks after repeated wrong passwords, even for the right one, until an administrator unlocks', async () => {
    await mk('lock1');
    for (let n = 0; n < MAX_FAILED_ATTEMPTS; n++) await rejects(login(w.pool, 'lock1', 'wrong-Password1'), 'UNAUTHORIZED', 401);
    await rejects(login(w.pool, 'lock1', PW), 'ACCOUNT_LOCKED', 423);
    await w.as('admin', (c) => admin.unlockUser(c, { userId: w.actors.lock1.id }));
    const ok = await login(w.pool, 'lock1', PW);
    expect(ok.token.length).toBeGreaterThan(40);
    const u = (await w.pool.query('SELECT failed_attempts FROM app_user WHERE username=$1', ['lock1'])).rows[0];
    expect(u.failed_attempts).toBe(0);
  });

  it('records every attempt, and a suspended user cannot sign in', async () => {
    await mk('susp1');
    await login(w.pool, 'susp1', PW);
    await w.as('admin', (c) => admin.suspendUser(c, { userId: w.actors.susp1.id, reason: 'left the company' }));
    await rejects(login(w.pool, 'susp1', PW), 'UNAUTHORIZED');
    const ev = await admin.listLoginEvents(w.pool, w.actors.admin.id);
    expect(ev!.filter((e) => e.username === 'susp1').map((e) => e.ok)).toEqual([false, true]);
    await w.as('admin', (c) => admin.reactivateUser(c, { userId: w.actors.susp1.id, reason: 'returned' }));
    await login(w.pool, 'susp1', PW);
  });

  it('temporary password forces a change, and changing it ends other sessions', async () => {
    await mk('temp1');
    const s1 = await login(w.pool, 'temp1', PW);
    await w.as('admin', (c) => admin.resetPassword(c, { userId: w.actors.temp1.id, temporaryPassword: 'Temp-Pass-77' }));
    await rejects(w.pool.query('SELECT 1').then(async () => { const r = await w.pool.query('SELECT 1 FROM session WHERE token=$1', [s1.token]); if (r.rowCount) throw new Error('session survived'); throw Object.assign(new Error('x'), { code: 'OK' }); }), 'OK');
    const s2 = await login(w.pool, 'temp1', 'Temp-Pass-77');
    expect(s2.mustChangePassword).toBe(true);
    await rejects(changeOwnPassword(w.pool, w.actors.temp1.id, 'wrong-one-1', 'Another-Pass-9'), 'UNAUTHORIZED');
    await rejects(changeOwnPassword(w.pool, w.actors.temp1.id, 'Temp-Pass-77', 'short1'), 'BAD_REQUEST');
    await changeOwnPassword(w.pool, w.actors.temp1.id, 'Temp-Pass-77', 'Another-Pass-9', s2.token);
    expect((await login(w.pool, 'temp1', 'Another-Pass-9')).mustChangePassword).toBe(false);
    await rejects(login(w.pool, 'temp1', 'Temp-Pass-77'), 'UNAUTHORIZED');
  });

  it('rejects weak passwords and odd usernames', async () => {
    await rejects(w.as('admin', (c) => admin.createUser(c, { username: 'weak1', displayName: 'x', password: 'password' })), 'BAD_REQUEST');
    await rejects(w.as('admin', (c) => admin.createUser(c, { username: 'Bad Name', displayName: 'x', password: PW })), 'BAD_REQUEST');
  });
});

describe('access control', () => {
  it('only an administrator manages users and roles', async () => {
    await rejects(w.as('buy', (c) => admin.createUser(c, { username: 'nope', displayName: 'x', password: PW })), 'FORBIDDEN');
    await rejects(w.as('md', (c) => admin.assignRole(c, { userId: w.actors.sto.id, roleKey: 'COM' })), 'FORBIDDEN');
    expect(await admin.listUsers(w.pool, w.actors.buy.id)).toBeNull();
  });

  it('nobody changes their own access, and duplicates are refused', async () => {
    await rejects(w.as('admin', (c) => admin.assignRole(c, { userId: w.actors.admin.id, roleKey: 'COM' })), 'FORBIDDEN');
    await rejects(w.as('admin', (c) => admin.assignRole(c, { userId: w.actors.sto.id, roleKey: 'STO', siteId: w.siteId })), 'INVALID_STATE');
  });

  it('a revoked role stops working at once and is kept as history', async () => {
    await mk('rv1', 'BUY');
    expect(await can(w.pool, w.actors.rv1.id, 'po.create', { siteId: w.siteId })).toBe(true);
    const g = (await w.pool.query('SELECT id FROM user_role WHERE user_id=$1', [w.actors.rv1.id])).rows[0];
    await rejects(w.as('admin', (c) => admin.revokeRole(c, { userRoleId: g.id, reason: '' })), 'BAD_REQUEST');
    await w.as('admin', (c) => admin.revokeRole(c, { userRoleId: g.id, reason: 'moved to stores' }));
    expect(await can(w.pool, w.actors.rv1.id, 'po.create', { siteId: w.siteId })).toBe(false);
    expect((await w.pool.query('SELECT revoked_at FROM user_role WHERE id=$1', [g.id])).rows[0].revoked_at).not.toBeNull();
    await rejects(w.as('rv1', (c) => po.createPO(c, { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '1' }] })), 'FORBIDDEN');
  });

  it('the last administrator can be neither revoked nor suspended', async () => {
    await w.as('admin', (c) => admin.createRole(c, { key: 'ACCESS', description: 'Access clerk', permissions: ['access.assign', 'user.manage'] }));
    const acc = await mk('acc1');
    await w.as('admin', (c) => admin.assignRole(c, { userId: acc.id, roleKey: 'ACCESS' }));
    const g = (await w.pool.query(`SELECT id FROM user_role WHERE role_key='ADM' AND revoked_at IS NULL`)).rows[0];
    await rejects(w.as('acc1', (c) => admin.revokeRole(c, { userRoleId: g.id, reason: 'x' })), 'INVALID_STATE');
    await rejects(w.as('acc1', (c) => admin.suspendUser(c, { userId: w.actors.admin.id, reason: 'x' })), 'INVALID_STATE');
    await rejects(w.as('admin', (c) => admin.suspendUser(c, { userId: w.actors.admin.id, reason: 'x' })), 'FORBIDDEN');
  });
});

describe('roles are data', () => {
  it('a new role carries exactly the permissions given, and edits take effect immediately', async () => {
    await w.as('admin', (c) => admin.createRole(c, { key: 'GATE', description: 'Gate clerk', permissions: ['receipt.view', 'inventory.view'] }));
    await mk('gate1', 'GATE');
    expect(await can(w.pool, w.actors.gate1.id, 'receipt.view', { siteId: w.siteId })).toBe(true);
    expect(await can(w.pool, w.actors.gate1.id, 'receipt.post', { siteId: w.siteId })).toBe(false);
    await w.as('admin', (c) => admin.setRolePermissions(c, { roleKey: 'GATE', permissions: ['receipt.view', 'receipt.post'], reason: 'gate now books receipts' }));
    expect(await can(w.pool, w.actors.gate1.id, 'receipt.post', { siteId: w.siteId })).toBe(true);
    expect(await can(w.pool, w.actors.gate1.id, 'inventory.view', { siteId: w.siteId })).toBe(false);
    const a = (await w.pool.query(`SELECT after, reason FROM audit_log WHERE action='role.permissions' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(a.after.added).toEqual(['receipt.post']); expect(a.after.removed).toEqual(['inventory.view']);
  });

  it('refuses unknown permissions, edits to ADM, missing reasons and deleting a held role', async () => {
    await rejects(w.as('admin', (c) => admin.setRolePermissions(c, { roleKey: 'GATE', permissions: ['made.up'], reason: 'x' })), 'BAD_REQUEST');
    await rejects(w.as('admin', (c) => admin.setRolePermissions(c, { roleKey: 'ADM', permissions: [], reason: 'x' })), 'FORBIDDEN');
    await rejects(w.as('admin', (c) => admin.setRolePermissions(c, { roleKey: 'GATE', permissions: ['receipt.view'], reason: '' })), 'BAD_REQUEST');
    await rejects(w.as('admin', (c) => admin.deleteRole(c, { roleKey: 'GATE' })), 'INVALID_STATE');
    await rejects(w.as('admin', (c) => admin.deleteRole(c, { roleKey: 'BUY' })), 'INVALID_STATE');   // still held
    await rejects(w.as('admin', (c) => admin.deleteRole(c, { roleKey: 'ADM' })), 'FORBIDDEN');
    await rejects(w.as('admin', (c) => admin.setRolePermissions(c, { roleKey: 'ADM', permissions: ['audit.view'], reason: 'x' })), 'FORBIDDEN');
    await w.as('admin', (c) => admin.updateRole(c, { roleKey: 'GATE', description: 'Gate clerk (night shift)', reason: 'Clearer name' }));
    expect((await admin.listRoles(w.pool)).find((r) => r.key === 'GATE')?.description).toBe('Gate clerk (night shift)');
  });

  it('the permission catalogue and role list are readable', async () => {
    const cat = await admin.permissionCatalogueRows(w.pool);
    expect(cat.length).toBeGreaterThan(50);
    expect(cat.find((p) => p.key === 'po.approve')?.bandable).toBe(true);
    expect((await admin.listRoles(w.pool)).find((r) => r.key === 'HRM')?.permissions).toContain('hr.payroll.create');
  });
});
