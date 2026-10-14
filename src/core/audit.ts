import type { Ctx } from './command.js';

export async function audit(ctx: Ctx, a: {
  action: string; entityType: string; entityId?: string | null; before?: unknown; after?: unknown; reason?: string | null;
}): Promise<void> {
  await ctx.db.query(
    `INSERT INTO audit_log(actor_id, action, entity_type, entity_id, before, after, reason, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.actor.id, a.action, a.entityType, a.entityId ?? null,
     a.before === undefined ? null : JSON.stringify(a.before),
     a.after === undefined ? null : JSON.stringify(a.after), a.reason ?? null, ctx.requestId],
  );
}

/** Outbox event written in the same transaction as the business change. */
export async function emit(ctx: Ctx, e: {
  type: string; entityType: string; entityId?: string | null; version?: number | null; siteId?: string | null; payload: unknown;
}): Promise<void> {
  await ctx.db.query(
    `INSERT INTO outbox_event(event_type, entity_type, entity_id, entity_version, site_id, actor_id, correlation_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [e.type, e.entityType, e.entityId ?? null, e.version ?? null, e.siteId ?? null, ctx.actor.id, ctx.requestId, JSON.stringify(e.payload)],
  );
}
