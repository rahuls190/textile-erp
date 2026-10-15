import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { createPool, type Pool } from './db/pool.js';
import { migrate } from './migrate.js';
import { actorFromToken, login, logout, changeOwnPassword } from './core/auth.js';
import { runCommand, type Actor, type Ctx } from './core/command.js';
import { AppError, badRequest, forbidden, unauthorized } from './core/errors.js';
import * as owner from './domain/owner.js';
import * as reports from './domain/reports.js';
import * as custom from './domain/custom-reports.js';
import * as ai from './domain/ai.js';
import * as barcode from './domain/barcode.js';
import * as bcs from './domain/barcodes.js';
import * as bom from './domain/bom.js';
import * as bulk from './domain/bulk.js';
import * as plan from './domain/planning.js';
import * as sales from './domain/sales.js';
import * as prefs from './domain/prefs.js';
import * as admin from './domain/admin.js';
import * as masters from './domain/masters.js';
import * as po from './domain/po.js';
import * as rcv from './domain/receipt.js';
import * as qc from './domain/qc.js';
import * as inv from './domain/inventory.js';
import * as q from './domain/queries.js';
import * as mdata from './domain/master-data.js';
import * as aim from './domain/ai-models.js';
import * as agent from './domain/agent.js';
import * as hr from './domain/hr.js';

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
    return { token: s.token, user: s.actor.username, mustChangePassword: s.mustChangePassword };
  });

  // Everything below /api requires a valid session (login excluded)
  app.addHook('preHandler', async (req: FastifyRequest) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/login') return;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) throw unauthorized();
    req.actor = await actorFromToken(pool, m[1]);
  });

  app.post('/api/logout', async (req) => { await logout(pool, /^Bearer (.+)$/.exec(req.headers.authorization ?? '')![1]); return { ok: true }; });
  app.post('/api/me/password', async (req) => {
    const b = z.object({ current: z.string().min(1), next: z.string().min(1) }).parse(req.body);
    const c = await pool.connect();
    try { await changeOwnPassword(c, req.actor.id, b.current, b.next, /^Bearer (.+)$/.exec(req.headers.authorization ?? '')![1]); } finally { c.release(); }
    return { ok: true };
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
  app.get('/api/me/preferences', read((db, a) => prefs.getPreferences(db, a.id)));
  cmd('/api/me/preferences', 'user.preferences', z.object({ theme: z.string().optional(), accent: z.string().optional(), layout: z.string().optional(), density: z.string().optional(), reset: z.boolean().optional() }),
    (c, b) => prefs.setPreferences(c, b.reset ? { reset: true } : (b as never)));
  // ── CRM and sales ──
  const slines = z.array(z.object({ itemId: id, qty: z.string(), rate: z.string(), discPct: z.string().optional() })).min(1);
  app.get('/api/crm/leads', read(async (db, a) => { const r = await sales.listLeads(db, a.id); if (!r) throw forbidden('Not permitted: crm.view'); return r; }));
  app.get('/api/crm/leads/:id', read((db, a, r) => sales.getLead(db, a.id, (r.params as { id: string }).id)));
  cmd('/api/crm/leads', 'crm.lead.create', z.object({ name: z.string(), company: z.string().optional(), phone: z.string().optional(), email: z.string().optional(), source: z.string().optional(), interest: z.string().optional(), estValue: z.string().optional(), nextFollowUp: z.string().optional() }), (c, b) => sales.createLead(c, b), true);
  cmd('/api/crm/leads/:id/status', 'crm.lead.status', z.object({ status: z.string(), reason: z.string().optional(), expectedVersion: ver }), (c, b, p) => sales.setLeadStatus(c, { leadId: p.id, ...b }));
  cmd('/api/crm/activities', 'crm.activity', z.object({ leadId: id.optional(), customerId: id.optional(), kind: z.string(), summary: z.string(), dueDate: z.string().optional() }), (c, b) => sales.addActivity(c, b), true);
  cmd('/api/crm/activities/:id/done', 'crm.activity.done', z.object({ outcome: z.string().optional() }), (c, b, p) => sales.completeActivity(c, { activityId: p.id, outcome: b.outcome }));
  // Master data
  const qs = (r: { query: unknown }) => r.query as Record<string, string | undefined>;
  app.get('/api/material-types', read((db, a) => mdata.listMaterialTypes(db, a.id)));
  app.get('/api/materials', read((db, a, r) => mdata.listMaterials(db, a.id, { q: qs(r).q, typeId: qs(r).type, status: qs(r).status })));
  app.get('/api/materials/:id', read((db, a, r) => mdata.getMaterial(db, a.id, (r.params as { id: string }).id)));
  cmd('/api/material-types', 'mtype.manage', z.object({ code: z.string(), name: z.string(), kind: z.string(), defaultUnit: z.string(), tracking: z.string().optional(), prefix: z.string().optional(), attrs: z.array(z.object({ key: z.string(), label: z.string(), type: z.enum(['number', 'text']), unit: z.string().optional(), required: z.boolean().optional() })).optional() }), (c, b) => mdata.createMaterialType(c, b), true);
  cmd('/api/materials', 'item.create', z.object({ typeId: id, name: z.string(), code: z.string().optional(), unit: z.string().optional(), description: z.string().optional(), hsnCode: z.string().optional(), gstRate: z.string().optional(), reorderLevel: z.string().optional(), attributes: z.record(z.string(), z.unknown()).optional() }), (c, b) => mdata.createMaterial(c, b), true);
  cmd('/api/materials/import', 'item.create', z.object({ csv: z.string(), dryRun: z.boolean().optional() }), (c, b) => mdata.importMaterials(c, b.csv, b.dryRun));
  app.get('/api/parties', read((db, a, r) => mdata.listParties(db, a.id, { role: qs(r).role === 'customer' ? 'customer' : 'vendor', q: qs(r).q, status: qs(r).status })));
  app.get('/api/parties/:id', read((db, a, r) => mdata.getParty(db, a.id, (r.params as { id: string }).id)));
  cmd('/api/parties', 'partner.create', z.object({ name: z.string(), role: z.enum(['vendor', 'customer', 'both', 'subcontractor']), customerType: z.enum(['distributor', 'retailer']).optional(), gstin: z.string().optional(), pan: z.string().optional(), city: z.string().optional(), state: z.string().optional(), phone: z.string().optional(), email: z.string().optional(), paymentDays: z.number().int().optional(), bankAccount: z.string().optional(), billing: z.object({ label: z.string().optional(), line1: z.string(), line2: z.string().optional(), city: z.string().optional(), state: z.string().optional(), pincode: z.string().optional(), contactName: z.string().optional(), phone: z.string().optional(), gstin: z.string().optional() }).optional(), shipping: z.object({ label: z.string().optional(), line1: z.string(), line2: z.string().optional(), city: z.string().optional(), state: z.string().optional(), pincode: z.string().optional(), contactName: z.string().optional(), phone: z.string().optional(), gstin: z.string().optional() }).optional(), shippingSameAsBilling: z.boolean().optional() }), (c, b) => mdata.createParty(c, b), true);
  cmd('/api/parties/:id/addresses', 'partner.edit', z.object({ label: z.string().optional(), line1: z.string(), line2: z.string().optional(), city: z.string().optional(), state: z.string().optional(), pincode: z.string().optional(), contactName: z.string().optional(), phone: z.string().optional(), gstin: z.string().optional(), kind: z.enum(['registered', 'billing', 'shipping', 'works']), makeDefault: z.boolean().optional() }), (c, b, p) => mdata.addAddress(c, { ...b, partnerId: p.id }), true);
  cmd('/api/addresses/:id/update', 'partner.edit', z.object({ label: z.string().optional(), line1: z.string(), line2: z.string().optional(), city: z.string().optional(), state: z.string().optional(), pincode: z.string().optional(), contactName: z.string().optional(), phone: z.string().optional(), gstin: z.string().optional() }), (c, b, p) => mdata.updateAddress(c, { ...b, addressId: p.id }));
  cmd('/api/addresses/:id/default', 'partner.edit', none, (c, _b, p) => mdata.setDefaultAddress(c, { addressId: p.id }));
  cmd('/api/addresses/:id/remove', 'partner.edit', none, (c, _b, p) => mdata.removeAddress(c, { addressId: p.id }));
  cmd('/api/parties/import', 'partner.create', z.object({ csv: z.string(), dryRun: z.boolean().optional() }), (c, b) => mdata.importParties(c, b.csv, b.dryRun));
  // AI models (owner and administrator) and the assistant
  const kindZ = z.enum(['anthropic', 'openai', 'google', 'openai_compatible']);
  app.get('/api/ai/overview', read((db, a) => aim.overview(db, a.id)));
  app.get('/api/ai/calls', read((db, a) => aim.recentCalls(db, a.id)));
  cmd('/api/ai/providers', 'ai.provider.add', z.object({ name: z.string(), kind: kindZ, baseUrl: z.string().optional(), apiKey: z.string().optional() }), (c, b) => aim.addProvider(c, b), true);
  cmd('/api/ai/providers/:id/update', 'ai.provider.update', z.object({ expectedVersion: ver, name: z.string().optional(), baseUrl: z.string().optional(), apiKey: z.string().optional(), clearKey: z.boolean().optional(), enabled: z.boolean().optional() }), (c, b, p) => aim.updateProvider(c, { id: p.id, ...b }));
  cmd('/api/ai/providers/:id/remove', 'ai.provider.remove', none, (c, _b, p) => aim.removeProvider(c, { id: p.id }));
  cmd('/api/ai/models', 'ai.model.add', z.object({ providerId: id, modelId: z.string(), label: z.string().optional(), maxTokens: z.number().int().optional(), temperature: z.number().optional() }), (c, b) => aim.addModel(c, b), true);
  cmd('/api/ai/models/:id/update', 'ai.model.update', z.object({ label: z.string().optional(), modelId: z.string().optional(), enabled: z.boolean().optional(), maxTokens: z.number().int().optional(), temperature: z.number().optional() }), (c, b, p) => aim.updateModel(c, { id: p.id, ...b }));
  cmd('/api/ai/models/:id/remove', 'ai.model.remove', none, (c, _b, p) => aim.removeModel(c, { id: p.id }));
  cmd('/api/ai/assign', 'ai.assign', z.object({ purpose: z.enum(['assistant', 'reports']), modelId: id.nullable(), fallbackId: id.nullable().optional() }), (c, b) => aim.assignModel(c, b));
  app.post('/api/ai/models/:id/test', read((db, a, r) => aim.testModel(db, a.id, (r.params as { id: string }).id)));
  app.get('/api/agent/capabilities', read((db, a) => agent.capabilities(db, a.id)));
  app.post('/api/agent/chat', read(async (db, a, r) => { const b = z.object({ text: z.string().max(500), history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(500) })).max(10).optional() }).parse(r.body ?? {}); return agent.chat(db, a.id, b.text, b.history ?? []); }));
  cmd('/api/agent/confirm', 'assistant.confirm', z.object({ tool: z.string(), args: z.record(z.string(), z.string()), title: z.string().max(200), details: z.array(z.string()).max(10).optional() }), async (c, b) => ({ message: await agent.executeProposal(c, { tool: b.tool, args: b.args, title: b.title, details: b.details ?? [] }) }));
  app.get('/api/customers', read((db, a) => sales.listCustomers(db, a.id)));
  cmd('/api/customers/:id/terms', 'customer.terms', z.object({ creditLimit: z.string(), paymentDays: z.number().int().optional() }), (c, b, p) => sales.setCreditTerms(c, { partnerId: p.id, ...b }));
  app.get('/api/quotes', read((db, a) => sales.listQuotes(db, a.id)));
  app.get('/api/quotes/:id', read((db, a, r) => sales.getQuote(db, a.id, (r.params as { id: string }).id)));
  cmd('/api/quotes', 'quote.create', z.object({ siteId: id, customerId: id, leadId: id.optional(), validUntil: z.string().optional(), lines: slines, notes: z.string().optional() }), (c, b) => sales.createQuote(c, b), true);
  cmd('/api/quotes/:id/send', 'quote.send', ev, (c, b, p) => sales.sendQuote(c, { quoteId: p.id, ...b }));
  cmd('/api/quotes/:id/decide', 'quote.decide', z.object({ expectedVersion: ver, accepted: z.boolean(), reason: z.string().optional() }), (c, b, p) => sales.decideQuote(c, { quoteId: p.id, ...b }));
  cmd('/api/quotes/:id/cancel', 'quote.cancel', z.object({ expectedVersion: ver, reason: z.string() }), (c, b, p) => sales.cancelQuote(c, { quoteId: p.id, ...b }));
  app.get('/api/sales/orders', read((db, a) => sales.listOrders(db, a.id)));
  app.get('/api/sales/orders/:id', read((db, a, r) => sales.getOrder(db, a.id, (r.params as { id: string }).id)));
  app.get('/api/sales/lines/:id/stock', read((db, a, r) => sales.stockForLine(db, a.id, (r.params as { id: string }).id)));
  app.get('/api/sales/summary', read((db, a) => sales.salesSummary(db, a.id)));
  cmd('/api/sales/orders', 'so.create', z.object({ siteId: id, customerId: id.optional(), quoteId: id.optional(), dueDate: z.string().optional(), lines: slines.optional() }), (c, b) => sales.createOrder(c, b), true);
  cmd('/api/sales/orders/:id/submit', 'so.submit', ev, (c, b, p) => sales.submitOrder(c, { orderId: p.id, ...b }));
  cmd('/api/sales/orders/:id/approve', 'so.approve', ev, (c, b, p) => sales.approveOrder(c, { orderId: p.id, ...b }));
  cmd('/api/sales/orders/:id/return', 'so.return', z.object({ expectedVersion: ver, reason: z.string() }), (c, b, p) => sales.returnOrder(c, { orderId: p.id, ...b }));
  cmd('/api/sales/orders/:id/cancel', 'so.cancel', z.object({ expectedVersion: ver, reason: z.string() }), (c, b, p) => sales.cancelOrder(c, { orderId: p.id, ...b }));
  cmd('/api/sales/orders/:id/allocate', 'so.allocate', z.object({ lineId: id, lotId: id, qty: z.string() }), (c, b, p) => sales.allocate(c, { orderId: p.id, ...b }));
  cmd('/api/sales/orders/:id/dispatch', 'so.dispatch', z.object({ vehicleNo: z.string().optional(), lrNo: z.string().optional(), lines: z.array(z.object({ lineId: id, lotId: id, locationId: id, qty: z.string() })).min(1) }), (c, b, p) => sales.dispatch(c, { orderId: p.id, ...b }), true);
  // ── barcodes: read a scanned code, list labels to print, move a roll forward ──
  app.get('/api/scan', read((db, a, req) => barcode.resolveScan(db, a.id, String((req.query as { code?: string }).code ?? ''))));
  app.get('/api/labels', read((db, a) => barcode.labelData(db, a.id)));
  // barcode registry, layouts and print log
  app.get('/api/barcodes', read((db, a, r) => bcs.registry(db, a.id, { q: qs(r).q, type: qs(r).type, status: qs(r).status, unused: qs(r).unused === '1', limit: Number(qs(r).limit) || undefined, offset: Number(qs(r).offset) || undefined })));
  app.get('/api/barcodes/series', read((db, a) => bcs.listSeries(db, a.id)));
  app.get('/api/barcodes/layouts', read((db, a, r) => bcs.listLayouts(db, a.id, qs(r).type)));
  app.get('/api/barcodes/:id/prints', read((db, a, r) => bcs.printHistory(db, a.id, (r.params as { id: string }).id)));
  cmd('/api/barcodes/series', 'barcode.series', z.object({ name: z.string(), entityType: z.string(), prefix: z.string(), digits: z.number().int().optional(), symbology: z.string().optional() }), (c, b) => bcs.createSeries(c, b as never), true);
  cmd('/api/barcodes/issue', 'barcode.issue', z.object({ seriesId: id, count: z.number().int(), siteId: id.nullable().optional(), note: z.string().optional() }), (c, b) => bcs.issueCodes(c, b), true);
  cmd('/api/barcodes/assign', 'barcode.issue', z.object({ code: z.string(), entityId: id }), (c, b) => bcs.assignCode(c, b));
  cmd('/api/barcodes/:id/void', 'barcode.void', z.object({ reason: z.string() }), (c, b, p) => bcs.voidCode(c, { id: p.id, reason: b.reason }));
  cmd('/api/barcodes/:id/note', 'barcode.issue', z.object({ note: z.string() }), (c, b, p) => bcs.updateNote(c, { id: p.id, note: b.note }));
  cmd('/api/barcodes/layouts', 'barcode.layout', z.object({ entityType: z.string(), name: z.string(), widthMm: z.number(), heightMm: z.number(), columns: z.number().int().optional(), gapMm: z.number().optional(), elements: z.array(z.object({ type: z.enum(['field', 'text', 'barcode', 'qr', 'line']), x: z.number(), y: z.number(), w: z.number(), h: z.number(), field: z.string().optional(), text: z.string().optional(), size: z.number().optional(), bold: z.boolean().optional(), align: z.enum(['left', 'center', 'right']).optional() })), makeDefault: z.boolean().optional() }), (c, b) => bcs.saveLayout(c, b as never), true);
  cmd('/api/barcodes/layouts/:id/update', 'barcode.layout', z.object({ entityType: z.string(), name: z.string(), widthMm: z.number(), heightMm: z.number(), columns: z.number().int().optional(), gapMm: z.number().optional(), elements: z.array(z.object({ type: z.enum(['field', 'text', 'barcode', 'qr', 'line']), x: z.number(), y: z.number(), w: z.number(), h: z.number(), field: z.string().optional(), text: z.string().optional(), size: z.number().optional(), bold: z.boolean().optional(), align: z.enum(['left', 'center', 'right']).optional() })), makeDefault: z.boolean().optional(), expectedVersion: z.number().int().optional() }), (c, b, p) => bcs.saveLayout(c, { ...b, id: p.id } as never));
  cmd('/api/barcodes/layouts/:id/default', 'barcode.layout', none, (c, _b, p) => bcs.setDefaultLayout(c, { id: p.id }));
  cmd('/api/barcodes/layouts/:id/remove', 'barcode.layout', none, (c, _b, p) => bcs.removeLayout(c, { id: p.id }));
  app.post('/api/barcodes/labels', read((db, a, r) => { const b = r.body as { ids: string[]; layoutId: string }; return bcs.labelValues(db, a.id, b.ids ?? [], b.layoutId); }));
  cmd('/api/barcodes/print', 'barcode.print', z.object({ ids: z.array(id), layoutId: id, copies: z.number().int().optional(), reason: z.string().optional() }), (c, b) => bcs.recordPrint(c, { barcodeIds: b.ids, layoutId: b.layoutId, copies: b.copies, reason: b.reason }));
  cmd('/api/stock/forward', 'inventory.forward', z.object({ lotCode: z.string().min(1), toLocationCode: z.string().min(1), qty: z.string().optional() }), (c, b) => barcode.moveForward(c, b));
  // ── reports (read-only; each run is audited) ──
  app.get('/api/reports', read((db, a) => reports.listReports(db, a.id)));
  app.get('/api/reports/runs', read(async (db, a) => { const r = await reports.recentRuns(db, a.id); if (!r) throw forbidden('Not permitted: audit.view'); return r; }));
  const aiProvider = process.env.ANTHROPIC_API_KEY ? ai.anthropicProvider(process.env.ANTHROPIC_API_KEY) : undefined;
  app.get('/api/reports/datasets', read(async (db, a) => custom.catalogue(await custom.availableDatasets(db, a.id))));
  app.get('/api/reports/custom', read((db, a) => custom.listSaved(db, a.id)));
  app.get('/api/reports/custom/:id/run', read((db, a, req) => custom.runSaved(db, a, (req.params as { id: string }).id)));
  // Describe a report in words; the assistant returns a spec and the report is run as the caller (audited, same rights as any report)
  app.post('/api/reports/ask', read(async (db, a, req) => {
    const b = z.object({ question: z.string().max(400) }).parse(req.body ?? {});
    const it = await ai.interpret(db, a.id, b.question, (await aim.reportsProvider(db, a.id)) ?? aiProvider);
    return { ...it, result: await custom.runCustom(db, a, it.spec, it.source === 'ai' ? 'ai' : 'manual', b.question) };
  }));
  app.post('/api/reports/custom/run', read((db, a, req) => custom.runCustom(db, a, (req.body as { spec?: unknown } | undefined)?.spec)));
  cmd('/api/reports/custom', 'report.save', z.object({ name: z.string(), spec: z.unknown(), shared: z.boolean().optional(), question: z.string().optional() }), (c, b) => custom.saveCustom(c, b), true);
  cmd('/api/reports/custom/:id/delete', 'report.delete', none, (c, _b, p) => custom.deleteSaved(c, { id: p.id }));
  app.get('/api/reports/:key', read((db, a, req) => reports.runReport(db, a, (req.params as { key: string }).key, req.query as Record<string, string>)));
  // ── owner desk, escalation ladder, override ──
  const itemType = z.enum(['purchase_order', 'stock_adjustment', 'leave_request', 'salary_structure', 'payroll_run']);
  app.get('/api/owner', read(async (db, a) => { const d = await owner.ownerDashboard(db, a.id); if (!d) throw forbidden('Not permitted: owner.view'); return d; }));
  app.get('/api/approvals/pending', read((db, a) => owner.pendingItems(db, a.id)));
  app.get('/api/escalations', read((db, a, req) => owner.listEscalations(db, a.id, { status: (req.query as { status?: string }).status === 'all' ? 'all' : 'open' })));
  app.get('/api/overrides', read(async (db, a) => { const r = await owner.listOverrides(db, a.id); if (!r) throw forbidden('Not permitted'); return r; }));
  cmd('/api/escalations', 'escalation.raise', z.object({ entityType: itemType, entityId: id, urgency: z.enum(['urgent', 'critical']), reason: z.string().min(8) }), (c, b) => owner.raiseEscalation(c, b), true);
  cmd('/api/escalations/:id/up', 'escalation.up', z.object({ note: z.string().optional() }), (c, b, p) => owner.escalateUp(c, { escalationId: p.id, note: b.note }));
  cmd('/api/escalations/:id/cancel', 'escalation.cancel', z.object({ reason: z.string().min(3) }), (c, b, p) => owner.cancelEscalation(c, { escalationId: p.id, reason: b.reason }));
  cmd('/api/escalations/sweep', 'escalation.sweep', z.object({ asOf: z.string().optional() }), (c, b) => owner.sweepEscalations(c, b));
  cmd('/api/owner/override', 'owner.override', z.object({ entityType: itemType, entityId: id, decision: z.enum(['approve', 'reject']), reason: z.string().min(10) }), (c, b) => owner.ownerOverride(c, b));
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
  cmd('/api/users/:id/update', 'user.update', z.object({ displayName: z.string().min(1).optional(), email: z.string().email().nullish() }), (c, b, p) => admin.updateUser(c, { userId: p.id, ...b }));
  cmd('/api/users/:id/reactivate', 'user.reactivate', z.object({ reason: z.string().min(3) }), (c, b, p) => admin.reactivateUser(c, { userId: p.id, reason: b.reason }));
  cmd('/api/users/:id/unlock', 'user.unlock', none, (c, _b, p) => admin.unlockUser(c, { userId: p.id }));
  cmd('/api/users/:id/reset-password', 'user.password_reset', z.object({ temporaryPassword: z.string() }), (c, b, p) => admin.resetPassword(c, { userId: p.id, temporaryPassword: b.temporaryPassword }));
  cmd('/api/access/:id/revoke', 'access.revoke', z.object({ reason: z.string().min(3) }), (c, b, p) => admin.revokeRole(c, { userRoleId: p.id, reason: b.reason }));
  cmd('/api/roles', 'role.create', z.object({ key: z.string(), description: z.string(), permissions: z.array(z.string()) }), (c, b) => admin.createRole(c, b), true);
  cmd('/api/roles/:key/permissions', 'role.permissions', z.object({ permissions: z.array(z.string()), reason: z.string().min(3) }), (c, b, p) => admin.setRolePermissions(c, { roleKey: p.key, ...b }));
  cmd('/api/roles/:key/update', 'role.update', z.object({ description: z.string().min(2), reason: z.string().min(3) }), (c, b, p) => admin.updateRole(c, { roleKey: p.key, ...b }));
  cmd('/api/roles/:key/delete', 'role.delete', none, (c, _b, p) => admin.deleteRole(c, { roleKey: p.key }));
  app.get('/api/users', read((db, a) => admin.listUsers(db, a.id).then((r) => { if (!r) throw new AppError(403, 'FORBIDDEN', 'Not permitted: user.view'); return r; })));
  app.get('/api/login-events', read((db, a) => admin.listLoginEvents(db, a.id).then((r) => { if (!r) throw new AppError(403, 'FORBIDDEN', 'Not permitted: user.view'); return r; })));
  app.get('/api/roles', read((db) => admin.listRoles(db)));
  app.get('/api/permissions', read((db) => admin.permissionCatalogueRows(db)));
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

  // ── products, BOMs and packs ──
  const colour = z.object({ code: z.string(), name: z.string() });
  const bomLine = z.object({ section: z.enum(bom.SECTIONS), itemId: id, qty: z.string(), wastagePct: z.string().optional(), sizes: z.array(z.string()).nullish(), colours: z.array(z.string()).nullish(), qtyBySize: z.record(z.string(), z.string()).optional(), note: z.string().optional() });
  const rev = z.object({ expectedRev: z.number().int() });
  app.get('/api/styles', read((db, a) => bom.listStyles(db, a.id)));
  app.get('/api/styles/:id', read((db, a, r) => bom.getStyle(db, a.id, (r.params as { id: string }).id)));
  app.get('/api/boms/:id', read((db, a, r) => bom.getBom(db, a.id, (r.params as { id: string }).id)));
  app.get('/api/boms/:id/overview', read((db, a, r) => bom.bomOverview(db, a.id, (r.params as { id: string }).id)));
  app.get('/api/boms/:id/sku/:skuId', read((db, a, r) => { const p = r.params as { id: string; skuId: string }; return bom.skuBom(db, a.id, { bomId: p.id, skuId: p.skuId }); }));
  app.post('/api/boms/:id/requirements', read((db, a, r) => bom.requirements(db, a.id, { bomId: (r.params as { id: string }).id, plan: z.object({ plan: z.array(z.object({ skuId: id, qty: z.number().int().min(0) })).max(400) }).parse(r.body ?? {}).plan })));
  app.get('/api/packs', read((db, a) => bom.listPacks(db, a.id)));
  cmd('/api/styles', 'style.create', z.object({ code: z.string(), name: z.string(), category: z.string().optional(), description: z.string().optional(), hsnCode: z.string().optional(), gstRate: z.string().optional(), sizes: z.array(z.string()), colours: z.array(colour) }), (c, b) => bom.createStyle(c, b), true);
  cmd('/api/styles/:id/edit', 'style.update', z.object({ expectedVersion: ver, name: z.string().optional(), category: z.string().optional(), description: z.string().optional(), sizes: z.array(z.string()).optional(), colours: z.array(colour).optional() }), (c, b, p) => bom.updateStyle(c, { styleId: p.id, ...b }));
  cmd('/api/styles/:id/skus', 'style.skus', z.object({ combos: z.array(z.object({ size: z.string(), colour: z.string() })).optional() }), (c, b, p) => bom.createSkus(c, { styleId: p.id, combos: b.combos }));
  cmd('/api/styles/:id/bom', 'bom.start', z.object({ copyFromBomId: id.optional() }), (c, b, p) => bom.startBom(c, { styleId: p.id, copyFromBomId: b.copyFromBomId }), true);
  cmd('/api/boms/:id/lines', 'bom.save', rev.extend({ lines: z.array(bomLine).max(200), notes: z.string().optional() }), (c, b, p) => bom.saveBomLines(c, { bomId: p.id, ...b }));
  cmd('/api/boms/:id/submit', 'bom.submit', rev, (c, b, p) => bom.submitBom(c, { bomId: p.id, expectedRev: b.expectedRev }));
  cmd('/api/boms/:id/return', 'bom.return', rev.extend({ reason: z.string().min(3) }), (c, b, p) => bom.returnBom(c, { bomId: p.id, ...b }));
  cmd('/api/boms/:id/approve', 'bom.approve', rev, (c, b, p) => bom.approveBom(c, { bomId: p.id, expectedRev: b.expectedRev }));
  cmd('/api/boms/:id/discard', 'bom.discard', rev, (c, b, p) => bom.discardBom(c, { bomId: p.id, expectedRev: b.expectedRev }));
  cmd('/api/packs', 'pack.create', z.object({ code: z.string(), name: z.string(), notes: z.string().optional(), skus: z.array(z.object({ skuId: id, qty: z.number().int() })).min(1), materials: z.array(z.object({ itemId: id, qty: z.string() })).optional() }), (c, b) => bom.createPack(c, b), true);
  cmd('/api/packs/:id/status', 'pack.status', z.object({ status: z.enum(['active', 'inactive']) }), (c, b, p) => bom.setPackStatus(c, { packId: p.id, status: b.status }));

  // ── master lists: export and import (CSV in the same columns both ways) ──
  const headEnum = z.enum(['vendors', 'distributors', 'retailers', 'materials', 'finished', 'skus']);
  app.get('/api/export/:head', read((db, a, r) => bulk.exportCsv(db, a.id, headEnum.parse((r.params as { head: string }).head))));
  cmd('/api/import/:head', 'master.import', z.object({ csv: z.string().max(2_000_000), dryRun: z.boolean().optional() }), (c, b, p) => {
    const h = headEnum.parse(p.head);
    if (h === 'skus') return bulk.importSkus(c, b.csv, !!b.dryRun);
    if (h === 'materials' || h === 'finished') return mdata.importMaterials(c, b.csv, !!b.dryRun, h === 'finished' ? 'fg' : 'materials');
    return mdata.importParties(c, b.csv, !!b.dryRun, h === 'vendors' ? 'vendor' : h === 'distributors' ? 'distributor' : 'retailer');
  });

  // ── production planning ──
  app.get('/api/plan', read((db, a) => plan.computePlan(db, a.id)));
  app.get('/api/plan/requests', read((db, a) => plan.listRequests(db, a.id)));
  cmd('/api/plan/settings', 'plan.settings', z.object({ salesMonths: z.number().int().optional(), coverDays: z.number().int().optional(), leadDays: z.number().int().optional(), horizonMonths: z.number().int().optional() }), (c, b) => plan.updateSettings(c, b));
  cmd('/api/plan/items/:id', 'plan.item', z.object({ manualMin: z.string().nullish(), coverDays: z.number().int().nullish(), leadDays: z.number().int().nullish(), monthlyDemand: z.string().nullish(), preferredVendorId: id.nullish(), greyItemId: id.nullish(), finishLossPct: z.string().nullish() }), (c, b, p) => plan.setItemPlan(c, { itemId: p.id, ...b }));
  cmd('/api/plan/demand', 'plan.demand', z.object({ itemId: id, month: z.string(), qty: z.string().nullable(), note: z.string().optional() }), (c, b) => plan.setDemand(c, b));
  cmd('/api/plan/yield', 'plan.yield', z.object({ styleId: id, yieldPct: z.number() }), (c, b) => plan.setCuttingYield(c, b));
  cmd('/api/plan/requests/generate', 'request.create', z.object({ withinDays: z.number().int().optional() }), (c, b) => plan.generateRequests(c, b), true);
  cmd('/api/plan/requests/:id/convert', 'request.convert', z.object({ expectedVersion: ver, partnerId: id.optional() }), (c, b, p) => plan.convertRequest(c, { requestId: p.id, ...b }), true);
  cmd('/api/plan/requests/:id/cancel', 'request.cancel', z.object({ expectedVersion: ver, reason: z.string().min(3) }), (c, b, p) => plan.cancelRequest(c, { requestId: p.id, ...b }));

  // ── purchase orders ──
  const poLine = z.object({ itemId: id, qty: pos, rate: pos.optional(), dueDate: date.nullish() });
  app.post('/api/po/quote', read((db, a, r) => { const b = z.object({ partnerId: id, lines: z.array(z.object({ itemId: id, qty: z.string() })).max(50) }).parse(r.body ?? {}); return po.quoteLines(db, a.id, b); }));
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

  // ── HR & payroll ──
  const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
  const period = z.string().regex(/^\d{4}-\d{2}$/);
  app.get('/api/hr/reference', read((db) => hr.hrReference(db)));
  app.get('/api/hr/employees', read((db, a, r) => hr.listEmployees(db, a.id, { includeExited: (r.query as { all?: string }).all === '1' })));
  app.get('/api/hr/attendance', read((db, a, r) => { const x = z.object({ siteId: id, date }).parse(r.query); return hr.dailyAttendance(db, a.id, x.siteId, x.date).then((v) => { if (!v) throw new AppError(403, 'FORBIDDEN', 'Not permitted: hr.attendance.view'); return v; }); }));
  app.get('/api/hr/employees/:id/attendance/:period', read((db, a, r) => { const p = r.params as { id: string; period: string }; return hr.monthlyAttendance(db, a.id, p.id, p.period); }));
  app.get('/api/hr/employees/:id/leave-balance', read((db, _a, r) => hr.leaveBalance(db, (r.params as { id: string }).id)));
  app.get('/api/hr/leave', read((db, a, r) => hr.listLeave(db, a.id, ((r.query as { scope?: string }).scope as 'mine' | 'team' | 'all') ?? 'mine')));
  app.get('/api/hr/salary', read((db, a) => hr.listSalary(db, a.id).then((v) => { if (!v) throw new AppError(403, 'FORBIDDEN', 'Not permitted: hr.salary.view'); return v; })));
  app.get('/api/hr/payroll', read((db, a) => hr.listPayrollRuns(db, a.id).then((v) => { if (!v) throw new AppError(403, 'FORBIDDEN', 'Not permitted: hr.payroll.view'); return v; })));
  app.get('/api/hr/payslips', read((db, a, r) => hr.listPayslips(db, a.id, (r.query as { run?: string }).run)));

  cmd('/api/hr/departments', 'hr.department.create', z.object({ code: z.string().min(1), name: z.string().min(1) }), (c, b) => hr.createDepartment(c, b), true);
  cmd('/api/hr/designations', 'hr.designation.create', z.object({ code: z.string().min(1), name: z.string().min(1), grade: z.string().optional() }), (c, b) => hr.createDesignation(c, b), true);
  cmd('/api/hr/shifts', 'hr.shift.create', z.object({ code: z.string().min(1), name: z.string().min(1), start: hhmm, end: hhmm, breakMin: z.number().int().min(0).optional(), graceMin: z.number().int().min(0).optional() }), (c, b) => hr.createShift(c, b), true);
  cmd('/api/hr/holidays', 'hr.holiday.add', z.object({ date, name: z.string().min(1), siteId: id.nullish() }), (c, b) => hr.addHoliday(c, b), true);
  cmd('/api/hr/employees', 'hr.employee.create', z.object({ name: z.string().min(1), siteId: id, joinDate: date, departmentId: id.nullish(), designationId: id.nullish(), managerId: id.nullish(), shiftId: id.nullish(), empType: z.enum(['permanent', 'contract', 'daily']).optional(), phone: z.string().nullish(), bankAccount: z.string().nullish(), pfApplicable: z.boolean().optional(), esiApplicable: z.boolean().optional(), userId: id.nullish() }), (c, b) => hr.createEmployee(c, b), true);
  cmd('/api/hr/employees/:id/update', 'hr.employee.update', z.object({ expectedVersion: ver, changes: z.object({ name: z.string().min(1), departmentId: id.nullable(), designationId: id.nullable(), managerId: id.nullable(), shiftId: id.nullable(), phone: z.string().nullable(), bankAccount: z.string().nullable(), pfApplicable: z.boolean(), esiApplicable: z.boolean(), empType: z.enum(['permanent', 'contract', 'daily']), userId: id.nullable() }).partial() }), (c, b, p) => hr.updateEmployee(c, { employeeId: p.id, ...b }));
  cmd('/api/hr/employees/:id/exit', 'hr.employee.exit', z.object({ expectedVersion: ver, exitDate: date, reason: z.string().min(3) }), (c, b, p) => hr.exitEmployee(c, { employeeId: p.id, ...b }));
  cmd('/api/hr/attendance/mark', 'hr.attendance.mark', z.object({ employeeId: id, date, status: z.enum(['P', 'A', 'H', 'WO', 'HOL']).optional(), inTime: hhmm.nullish(), outTime: hhmm.nullish(), note: z.string().optional(), reason: z.string().optional() }), (c, b) => hr.markAttendance(c, b));
  cmd('/api/hr/attendance/fill', 'hr.attendance.fill', z.object({ siteId: id, from: date, to: date }), (c, b) => hr.fillDefaultAttendance(c, b));
  cmd('/api/hr/leave/allocate', 'hr.leave.allocate', z.object({ siteId: id, year: z.number().int().min(2000).max(2100) }), (c, b) => hr.allocateAnnualLeave(c, b));
  cmd('/api/hr/leave/adjust', 'hr.leave.adjust', z.object({ employeeId: id, leaveType: z.string(), days: dec, reason: z.string().min(3), year: z.number().int().optional() }), (c, b) => hr.adjustLeave(c, b));
  cmd('/api/hr/leave', 'hr.leave.apply', z.object({ employeeId: id.optional(), leaveType: z.string(), from: date, to: date, halfDay: z.boolean().optional(), reason: z.string().min(3) }), (c, b) => hr.applyLeave(c, b), true);
  cmd('/api/hr/leave/:id/decide', 'hr.leave.decide', z.object({ expectedVersion: ver, approve: z.boolean(), note: z.string().optional() }), (c, b, p) => hr.decideLeave(c, { leaveId: p.id, ...b }));
  cmd('/api/hr/leave/:id/cancel', 'hr.leave.cancel', z.object({ expectedVersion: ver, reason: z.string().min(3) }), (c, b, p) => hr.cancelLeave(c, { leaveId: p.id, ...b }));
  cmd('/api/hr/salary', 'hr.salary.propose', z.object({ employeeId: id, effectiveFrom: date, basic: pos, hra: pos.optional(), otherAllowance: pos.optional() }), (c, b) => hr.proposeSalary(c, b), true);
  cmd('/api/hr/salary/:id/decide', 'hr.salary.decide', z.object({ approve: z.boolean() }), (c, b, p) => hr.decideSalary(c, { salaryId: p.id, approve: b.approve }));
  cmd('/api/hr/payroll', 'hr.payroll.create', z.object({ siteId: id, period }), (c, b) => hr.createPayrollRun(c, b), true);
  cmd('/api/hr/payroll/:id/recalculate', 'hr.payroll.recalculate', ev, (c, b, p) => hr.recalculatePayrollRun(c, { runId: p.id, expectedVersion: b.expectedVersion }));
  cmd('/api/hr/payroll/:id/approve', 'hr.payroll.approve', ev, (c, b, p) => hr.approvePayrollRun(c, { runId: p.id, expectedVersion: b.expectedVersion }));
  cmd('/api/hr/payroll/:id/cancel', 'hr.payroll.cancel', z.object({ expectedVersion: ver, reason: z.string().min(3) }), (c, b, p) => hr.cancelPayrollRun(c, { runId: p.id, ...b }));

  return app;
}

if (process.argv[1]?.endsWith('server.ts')) {
  const pool = createPool();
  migrate(pool).then(() => buildServer(pool)).then((app) => app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' }));
}
