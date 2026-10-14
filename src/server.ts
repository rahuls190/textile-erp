import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { createPool, type Pool } from './db/pool.js';
import { migrate } from './migrate.js';
import { actorFromToken, login } from './core/auth.js';
import { runCommand, type Actor, type Ctx } from './core/command.js';
import { AppError, badRequest, unauthorized } from './core/errors.js';
import * as admin from './domain/admin.js';
import * as masters from './domain/masters.js';
import * as po from './domain/po.js';
import * as rcv from './domain/receipt.js';
import * as qc from './domain/qc.js';
import * as inv from './domain/inventory.js';
import * as q from './domain/queries.js';

declare module 'fastify' { interface FastifyRequest { actor: Actor } }

const id = z.string().uuid();
const dec = z.string().regex(/^-?\d+(\.\d{1,4})?$/, 'Use an exact decimal string, e.g. "120.5000"');
const pos = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Use a non-negative decimal string');
const ver = z.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function buildServer(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' && process.env.LOG !== 'off' });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: 'Invalid input', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '22P02') return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Malformed identifier or value' } });
    req.log.error(err);   // never leak internals to the client
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Unexpected error' } });
  });

  app.get('/health', async () => { await pool.query('SELECT 1'); return { ok: true }; });

  app.post('/api/login', async (req) => {
    const b = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const s = await login(pool, b.username, b.password);
    return { token: s.token, user: s.actor.username };
  });

  // Everything below /api requires a valid session (login excluded)
  app.addHook('preHandler', async (req: FastifyRequest) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/login') return;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) throw unauthorized();
    req.actor = await actorFromToken(pool, m[1]);
  });

  const read = <T>(fn: (db: import('./db/pool.js').Db, actor: Actor, req: FastifyRequest) => Promise<T>) => async (req: FastifyRequest) => {
    const c = await pool.connect();
    try { return await fn(c, req.actor, req); } finally { c.release(); }
  };

  // Every write is a command: needs an Idempotency-Key, runs in one transaction, replays safely.
  function cmd<S extends z.ZodTypeAny>(path: string, action: string, schema: S,
    handler: (ctx: Ctx, body: z.infer<S>, params: Record<string, string>) => Promise<unknown>, created = false) {
    app.post(path, async (req, reply) => {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length < 8 || key.length > 100) throw badRequest('An Idempotency-Key header (8-100 chars) is required on every write');
      const body = schema.parse(req.body ?? {});
      const out = await runCommand(pool, { requestId: key, actor: req.actor, action }, (ctx) => handler(ctx, body, req.params as Record<string, string>));
      reply.code(out.replayed || !created ? 200 : 201).header('Idempotent-Replayed', String(out.replayed));
      return out.result;
    });
  }
  const none = z.object({});
  const ev = z.object({ expectedVersion: ver });

  // ── session / reads ──
  app.get('/api/me', read((db, a) => q.myAccess(db, a.id).then((access) => ({ user: a.username, access }))));
  app.get('/api/items', read((db, a) => q.listItems(db, a.id)));
  app.get('/api/partners', read((db, a) => q.listPartners(db, a.id)));
  app.get('/api/po', read((db, a, r) => po.listPOs(db, a.id, { status: (r.query as { status?: string }).status })));
  app.get('/api/po/:id', read((db, a, r) => po.getPO(db, a.id, (r.params as { id: string }).id)));
  app.get('/api/receipts', read((db, a) => rcv.listReceipts(db, a.id)));
  app.get('/api/receipts/:id', read((db, a, r) => rcv.getReceipt(db, a.id, (r.params as { id: string }).id)));
  app.get('/api/qc', read((db, a, r) => qc.listInspections(db, a.id, { status: (r.query as { status?: string }).status })));
  app.get('/api/stock', read((db, a, r) => q.stockSummary(db, a.id, { itemCode: (r.query as { item?: string }).item })));
  app.get('/api/lots/:id/ledger', read((db, a, r) => q.lotLedger(db, a.id, (r.params as { id: string }).id)));
  app.get('/api/audit/:type/:id', read((db, a, r) => { const p = r.params as { type: string; id: string }; return q.auditTrail(db, a.id, p.type, p.id); }));

  // ── administration ──
  cmd('/api/users', 'user.create', z.object({ username: z.string().min(3), displayName: z.string().min(1), password: z.string() }), (c, b) => admin.createUser(c, b), true);
  cmd('/api/users/:id/roles', 'access.assign', z.object({ roleKey: z.string(), siteId: id.nullish(), maxAmount: pos.nullish(), validUntil: z.string().nullish() }), (c, b, p) => admin.assignRole(c, { userId: p.id, ...b }), true);
  cmd('/api/users/:id/suspend', 'user.suspend', z.object({ reason: z.string().min(3) }), (c, b, p) => admin.suspendUser(c, { userId: p.id, reason: b.reason }));
  cmd('/api/entities', 'org.entity.create', z.object({ name: z.string().min(1), gstin: z.string().optional(), state: z.string().optional() }), (c, b) => admin.createEntity(c, b), true);
  cmd('/api/sites', 'org.site.create', z.object({ entityId: id, code: z.string().min(1), name: z.string().min(1) }), (c, b) => admin.createSite(c, b), true);
  cmd('/api/locations', 'org.location.create', z.object({ siteId: id, code: z.string(), name: z.string(), kind: z.enum(['RECEIVING', 'STORE', 'RACK', 'TRANSIT', 'FLOOR', 'VENDOR', 'SCRAP']) }), (c, b) => admin.createLocation(c, b), true);
  cmd('/api/units', 'unit.create', z.object({ code: z.string(), name: z.string(), precision: z.number().int().min(0).max(4) }), (c, b) => admin.createUnit(c, b), true);

  // ── masters ──
  cmd('/api/items', 'item.create', z.object({ code: z.string().min(1), name: z.string().min(1), kind: z.enum(['FABRIC', 'TRIM', 'CUP', 'PACKING', 'PROCESS', 'WIP', 'FG']), stockUnit: z.string(), tracking: z.enum(['NONE', 'LOT', 'ROLL']).optional(), parentId: id.nullish(), attributes: z.record(z.string(), z.unknown()).optional() }), (c, b) => masters.createItem(c, b), true);
  cmd('/api/items/:id/submit', 'item.submit', ev, (c, b, p) => masters.submitItem(c, { itemId: p.id, expectedVersion: b.expectedVersion }));
  cmd('/api/items/:id/approve', 'item.approve', ev, (c, b, p) => masters.approveItem(c, { itemId: p.id, expectedVersion: b.expectedVersion }));
  cmd('/api/partners', 'partner.create', z.object({ code: z.string(), name: z.string(), isVendor: z.boolean().optional(), isSubcontractor: z.boolean().optional(), isCustomer: z.boolean().optional(), gstin: z.string().optional(), bankAccount: z.string().optional() }), (c, b) => masters.createPartner(c, b), true);
  cmd('/api/partners/:id/submit', 'partner.submit', ev, (c, b, p) => masters.submitPartner(c, { partnerId: p.id, expectedVersion: b.expectedVersion }));
  cmd('/api/partners/:id/verify-bank', 'partner.bank.verify', ev, (c, b, p) => masters.verifyPartnerBank(c, { partnerId: p.id, expectedVersion: b.expectedVersion }));
  cmd('/api/partners/:id/approve', 'partner.approve', ev, (c, b, p) => masters.approvePartner(c, { partnerId: p.id, expectedVersion: b.expectedVersion }));
  cmd('/api/rates', 'rate.propose', z.object({ partnerId: id, itemId: id, rate: pos, effectiveFrom: date, minQty: pos.optional() }), (c, b) => masters.proposeRate(c, b), true);
  cmd('/api/rates/:id/approve', 'rate.approve', none, (c, _b, p) => masters.approveRate(c, { rateId: p.id }));

  // ── purchase orders ──
  const poLine = z.object({ itemId: id, qty: pos, rate: pos.optional(), dueDate: date.nullish() });
  cmd('/api/po', 'po.create', z.object({ siteId: id, partnerId: id, lines: z.array(poLine).min(1), terms: z.record(z.string(), z.unknown()).optional() }), (c, b) => po.createPO(c, b), true);
  cmd('/api/po/:id/edit', 'po.edit', z.object({ expectedVersion: ver, lines: z.array(poLine).min(1), terms: z.record(z.string(), z.unknown()).optional() }), (c, b, p) => po.updateDraftPO(c, { poId: p.id, ...b }));
  cmd('/api/po/:id/submit', 'po.submit', ev, (c, b, p) => po.submitPO(c, { poId: p.id, expectedVersion: b.expectedVersion }));
  cmd('/api/po/:id/approve', 'po.approve', ev, (c, b, p) => po.approvePO(c, { poId: p.id, expectedVersion: b.expectedVersion }));
  cmd('/api/po/:id/return', 'po.return', z.object({ expectedVersion: ver, reason: z.string().min(3) }), (c, b, p) => po.returnPO(c, { poId: p.id, ...b }));
  cmd('/api/po/:id/release', 'po.release', ev, (c, b, p) => po.releasePO(c, { poId: p.id, expectedVersion: b.expectedVersion }));
  cmd('/api/po/:id/amend', 'po.amend', z.object({ expectedVersion: ver, reason: z.string().min(3), changes: z.array(z.object({ lineId: id, qty: pos.optional(), rate: pos.optional(), dueDate: date.nullish() })).min(1) }), (c, b, p) => po.amendPO(c, { poId: p.id, ...b }));
  cmd('/api/po/:id/cancel', 'po.cancel', z.object({ expectedVersion: ver, reason: z.string().min(3) }), (c, b, p) => po.cancelPO(c, { poId: p.id, ...b }));

  // ── receipt & quality ──
  cmd('/api/receipts', 'receipt.post', z.object({ siteId: id, partnerId: id, poId: id.nullish(), challanNo: z.string().min(1), vehicleNo: z.string().optional(), notes: z.string().optional(), receivingLocationId: id.optional(), acknowledgeDuplicate: z.boolean().optional(),
    lines: z.array(z.object({ poLineId: id.optional(), itemId: id, qty: pos, unit: z.string().optional(), attributes: z.record(z.string(), z.unknown()).optional() })).min(1) }), (c, b) => rcv.postReceipt(c, b), true);
  cmd('/api/qc/:id/start', 'qc.start', none, (c, _b, p) => qc.startInspection(c, { inspectionId: p.id }));
  cmd('/api/qc/:id/submit', 'qc.submit', z.object({ expectedVersion: ver, inspectedQty: pos, recommendAccept: pos, recommendReject: pos, defects: z.array(z.unknown()).optional() }), (c, b, p) => qc.submitInspection(c, { inspectionId: p.id, ...b }));
  cmd('/api/qc/:id/disposition', 'qc.disposition', z.object({ expectedVersion: ver, acceptQty: pos, rejectQty: pos, reason: z.string().optional() }), (c, b, p) => qc.dispositionInspection(c, { inspectionId: p.id, ...b }));

  // ── inventory ──
  cmd('/api/reservations', 'reservation.create', z.object({ lotId: id, qty: pos, demandType: z.string().min(1), demandRef: z.string().min(1) }), (c, b) => inv.reserveStock(c, b), true);
  cmd('/api/reservations/:id/release', 'reservation.release', z.object({ reason: z.string().min(3) }), (c, b, p) => inv.releaseReservation(c, { reservationId: p.id, reason: b.reason }));
  cmd('/api/putaway', 'inventory.putaway', z.object({ lotId: id, fromLocationId: id, toLocationId: id, qty: pos, status: z.enum(['HOLD', 'ACCEPTED', 'REJECTED']).optional() }), (c, b) => inv.putaway(c, b));
  cmd('/api/adjustments', 'adjustment.propose', z.object({ lotId: id, locationId: id, qtyDelta: dec, reason: z.string().min(3), evidence: z.string().optional() }), (c, b) => inv.proposeAdjustment(c, b), true);
  cmd('/api/adjustments/:id/decide', 'adjustment.decide', z.object({ expectedVersion: ver, approve: z.boolean() }), (c, b, p) => inv.approveAdjustment(c, { adjustmentId: p.id, ...b }));
  cmd('/api/adjustments/:id/post', 'adjustment.post', ev, (c, b, p) => inv.postAdjustment(c, { adjustmentId: p.id, expectedVersion: b.expectedVersion }));

  return app;
}

if (process.argv[1]?.endsWith('server.ts')) {
  const pool = createPool();
  migrate(pool).then(() => buildServer(pool)).then((app) => app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' }));
}
