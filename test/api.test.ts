import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { freshWorld } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import { buildServer } from '../src/server.js';

let w: World; let app: FastifyInstance;
const tokens: Record<string, string> = {};
beforeAll(async () => {
  process.env.LOG = 'off';
  w = await freshWorld('api'); app = await buildServer(w.pool);
  for (const u of ['buy', 'com', 'sto', 'qci', 'qcm', 'inv', 'aud', 'md'])
    tokens[u] = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: 'Demo-Passw0rd!' } })).json().token;
});
afterAll(async () => { await app.close(); await w.pool.end(); });

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown, key: string | null = randomUUID()) =>
  app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${tokens[who]}`, ...(key ? { 'idempotency-key': key } : {}) } });

describe('HTTP API', () => {
  it('rejects unauthenticated requests, bad tokens, missing idempotency keys and invalid input', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/stock' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/stock', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await call('buy', 'POST', '/api/po', { siteId: w.siteId }, null)).statusCode).toBe(400);
    const bad = await call('buy', 'POST', '/api/po', { siteId: 'not-a-uuid', partnerId: w.vendorId, lines: [] });
    expect(bad.statusCode).toBe(400); expect(bad.json().error.code).toBe('VALIDATION');
    const frac = await call('buy', 'POST', '/api/po', { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '1.23456' }] });
    expect(frac.statusCode).toBe(400);     // more than 4 decimals refused, never rounded silently
  });

  it('login with a wrong password is 401', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'buy', password: 'x' } })).statusCode).toBe(401);
  });

  it('full flow over HTTP: PO → approve → release → receive → QC → reserve; each role limited to its own steps', async () => {
    const create = await call('buy', 'POST', '/api/po', { siteId: w.siteId, partnerId: w.vendorId, lines: [{ itemId: w.items.fabric, qty: '500' }] });
    expect(create.statusCode).toBe(201);
    let p = create.json(); expect(p.total).toBe('125000.00');

    expect((await call('sto', 'POST', `/api/po/${p.id}/submit`, { expectedVersion: p.version })).statusCode).toBe(403);
    p = (await call('buy', 'POST', `/api/po/${p.id}/submit`, { expectedVersion: p.version })).json();
    expect((await call('buy', 'POST', `/api/po/${p.id}/approve`, { expectedVersion: p.version })).statusCode).toBe(403);
    p = (await call('com', 'POST', `/api/po/${p.id}/approve`, { expectedVersion: p.version })).json();
    p = (await call('com', 'POST', `/api/po/${p.id}/release`, { expectedVersion: p.version })).json();
    expect(p.status).toBe('released');

    const detail = (await call('buy', 'GET', `/api/po/${p.id}`)).json();
    const lineId = detail.lines[0].id;

    const key = randomUUID();
    const body = { siteId: w.siteId, partnerId: w.vendorId, poId: p.id, challanNo: 'API-CH-1', lines: [{ poLineId: lineId, itemId: w.items.fabric, qty: '500' }] };
    const r1 = await call('sto', 'POST', '/api/receipts', body, key);
    const r2 = await call('sto', 'POST', '/api/receipts', body, key);   // network retry
    expect(r1.statusCode).toBe(201); expect(r2.statusCode).toBe(200);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.json().id).toBe(r1.json().id);
    const lot = r1.json().lines[0]; const insp = lot.inspectionId;

    expect((await call('sto', 'GET', '/api/stock')).json().find((s: { lot_id: string }) => s.lot_id === lot.lotId).available).toBe('0.0000');

    let qci = (await call('qci', 'POST', `/api/qc/${insp}/start`, {})).json();
    qci = (await call('qci', 'POST', `/api/qc/${insp}/submit`, { expectedVersion: qci.version, inspectedQty: '20', recommendAccept: '480', recommendReject: '20' })).json();
    expect((await call('qci', 'POST', `/api/qc/${insp}/disposition`, { expectedVersion: qci.version, acceptQty: '480', rejectQty: '20' })).statusCode).toBe(403);
    const done = await call('qcm', 'POST', `/api/qc/${insp}/disposition`, { expectedVersion: qci.version, acceptQty: '480', rejectQty: '20' });
    expect(done.statusCode).toBe(200); expect(done.json().status).toBe('partial');

    const res = await call('sto', 'POST', '/api/reservations', { lotId: lot.lotId, qty: '120', demandType: 'cut_order', demandRef: 'CUT-1' });
    expect(res.statusCode).toBe(201);
    const row = (await call('sto', 'GET', '/api/stock')).json().find((s: { lot_id: string }) => s.lot_id === lot.lotId);
    expect(row).toMatchObject({ accepted: '480.0000', rejected: '20.0000', reserved: '120.0000', available: '360.0000' });
    const tooMuch = await call('sto', 'POST', '/api/reservations', { lotId: lot.lotId, qty: '400', demandType: 'cut_order', demandRef: 'CUT-2' });
    expect(tooMuch.statusCode).toBe(409); expect(tooMuch.json().error.code).toBe('INSUFFICIENT_AVAILABLE');

    const ledger = (await call('sto', 'GET', `/api/lots/${lot.lotId}/ledger`)).json();
    expect(ledger.length).toBeGreaterThanOrEqual(5);   // receipt + release legs + reject legs
    const trail = await call('aud', 'GET', `/api/audit/purchase_order/${p.id}`);
    expect(trail.json().map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['po.create', 'po.submit', 'po.approve', 'po.release']));
    expect((await call('sto', 'GET', `/api/audit/purchase_order/${p.id}`)).statusCode).toBe(404);   // no audit.view
  });

  it('bank details are masked for users without the grant', async () => {
    const list = (await call('buy', 'GET', '/api/partners')).json();
    expect(list[0].bank_account).toBe('••••9012');
  });

  it('malformed identifiers are a clean 400 and never leak database internals', async () => {
    const r = await call('buy', 'GET', '/api/po/not-a-uuid');
    expect(r.statusCode).toBe(400); expect(JSON.stringify(r.json())).not.toMatch(/uuid|syntax|select|pg_/i);
  });
});
