import type { Ctx } from './command.js';

/** Per-site, per-document-type series so sites can number offline without overlap. */
export async function nextNumber(ctx: Ctx, siteId: string, docType: string): Promise<string> {
  const site = (await ctx.db.query('SELECT code FROM site WHERE id=$1', [siteId])).rows[0];
  const prefix = `${docType}-${site.code}-`;
  const r = await ctx.db.query(
    `INSERT INTO doc_series(site_id, doc_type, prefix, next_no) VALUES ($1,$2,$3,2)
     ON CONFLICT (site_id, doc_type) DO UPDATE SET next_no = doc_series.next_no + 1
     RETURNING prefix, next_no - 1 AS n`,
    [siteId, docType, prefix],
  );
  return `${r.rows[0].prefix}${String(r.rows[0].n).padStart(5, '0')}`;
}
