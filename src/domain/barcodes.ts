// Barcode registry, label layouts and the print log.
// Every code the company uses is a row in `barcode` with its own id and a code that is unique forever (cancelled codes are never reused).
// Rolls, shelves, materials and staff get their row automatically; cartons, assets and spare roll labels are issued ahead of time in series.
import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan, visibleSites } from '../core/permissions.js';
import { audit } from '../core/audit.js';
import { badRequest, invalidState, notFound } from '../core/errors.js';

const ANY = { anySite: true } as const;
export const ENTITY_TYPES = ['item', 'lot', 'location', 'employee', 'carton', 'asset', 'generic'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const SYMBOLOGIES = ['CODE128', 'QR'] as const;
export const printable = (s: string) => /^[\x20-\x7e]{1,40}$/.test(s);

/** What can be printed on a label for each kind of thing ("barcode" is always the registry code itself). */
export const FIELDS: Record<EntityType, { key: string; label: string }[]> = {
  item: [{ key: 'barcode', label: 'Barcode text' }, { key: 'code', label: 'Material code' }, { key: 'name', label: 'Material name' }, { key: 'unit', label: 'Unit' }, { key: 'type', label: 'Material type' }, { key: 'hsn', label: 'HSN code' }],
  lot: [{ key: 'barcode', label: 'Barcode text' }, { key: 'code', label: 'Roll label' }, { key: 'item_code', label: 'Material code' }, { key: 'item_name', label: 'Material name' }, { key: 'unit', label: 'Unit' }, { key: 'date', label: 'Received on' }, { key: 'site', label: 'Plant' }, { key: 'qty', label: 'Quantity now' }],
  location: [{ key: 'barcode', label: 'Barcode text' }, { key: 'code', label: 'Shelf code' }, { key: 'name', label: 'Shelf name' }, { key: 'kind', label: 'Kind' }, { key: 'site', label: 'Plant' }],
  employee: [{ key: 'barcode', label: 'Barcode text' }, { key: 'code', label: 'Employee code' }, { key: 'name', label: 'Name' }, { key: 'department', label: 'Department' }, { key: 'site', label: 'Plant' }],
  carton: [{ key: 'barcode', label: 'Barcode text' }, { key: 'code', label: 'Code' }, { key: 'note', label: 'Note' }, { key: 'date', label: 'Issued on' }, { key: 'site', label: 'Plant' }],
  asset: [{ key: 'barcode', label: 'Barcode text' }, { key: 'code', label: 'Code' }, { key: 'note', label: 'Note' }, { key: 'date', label: 'Issued on' }, { key: 'site', label: 'Plant' }],
  generic: [{ key: 'barcode', label: 'Barcode text' }, { key: 'code', label: 'Code' }, { key: 'note', label: 'Note' }, { key: 'date', label: 'Issued on' }, { key: 'site', label: 'Plant' }],
};
const TABLE: Partial<Record<EntityType, string>> = { item: 'item', lot: 'lot', location: 'location', employee: 'employee' };

// ───────────────────────── series and issuing ─────────────────────────
export async function listSeries(db: Db, userId: string) {
  await assertCan(db, userId, 'barcode.view', ANY);
  return (await db.query(
    `SELECT s.*, (SELECT count(*) FROM barcode b WHERE b.series_id = s.id)::int AS issued,
            (SELECT count(*) FROM barcode b WHERE b.series_id = s.id AND b.entity_id IS NULL AND b.status = 'active')::int AS unused
       FROM barcode_series s ORDER BY s.name`)).rows;
}

export async function createSeries(ctx: Ctx, i: { name: string; entityType: EntityType; prefix: string; digits?: number; symbology?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'barcode.series', ANY);
  const prefix = (i.prefix ?? '').trim().toUpperCase();
  if (!i.name?.trim()) throw badRequest('Give the series a name');
  if (!/^[A-Z0-9]{1,6}$/.test(prefix)) throw badRequest('Prefix: 1 to 6 letters or digits');
  if (!ENTITY_TYPES.includes(i.entityType)) throw badRequest('Pick what the codes are for');
  if (i.symbology && !SYMBOLOGIES.includes(i.symbology as never)) throw badRequest('Code type: Code 128 or QR');
  if (i.digits != null && !(Number.isInteger(i.digits) && i.digits >= 4 && i.digits <= 10)) throw badRequest('Digits: 4 to 10');
  if ((await ctx.db.query('SELECT 1 FROM barcode_series WHERE prefix=$1 OR lower(name)=lower($2)', [prefix, i.name.trim()])).rowCount) throw badRequest('A series with this name or prefix already exists');
  const r = (await ctx.db.query(`INSERT INTO barcode_series(name, entity_type, prefix, digits, symbology) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [i.name.trim(), i.entityType, prefix, i.digits ?? 6, i.symbology ?? 'CODE128'])).rows[0];
  await audit(ctx, { action: 'barcode.series.create', entityType: 'barcode_series', entityId: r.id, after: r });
  return r;
}

/** Issue a run of new blank codes. Numbers only go up; a number that was ever used is never used again. */
export async function issueCodes(ctx: Ctx, i: { seriesId: string; count: number; siteId?: string | null; note?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'barcode.issue', ANY);
  if (!Number.isInteger(i.count) || i.count < 1 || i.count > 500) throw badRequest('Issue 1 to 500 codes at a time');
  const s = (await ctx.db.query('SELECT * FROM barcode_series WHERE id=$1 FOR UPDATE', [i.seriesId])).rows[0];
  if (!s) throw notFound('Series');
  if (!s.active) throw invalidState('This series is switched off');
  if (i.siteId && !(await ctx.db.query('SELECT 1 FROM site WHERE id=$1', [i.siteId])).rowCount) throw notFound('Plant');
  const made: { id: string; code: string }[] = [];
  let no = Number(s.next_no);
  for (let guard = 0; made.length < i.count && guard < 20; guard++) {
    const need = i.count - made.length;
    const r = await ctx.db.query(
      `INSERT INTO barcode(code, series_id, entity_type, symbology, site_id, note, issued_by)
       SELECT $1 || '-' || lpad(n::text, $2, '0'), $3, $4, $5, $6, $7, $8 FROM generate_series($9::bigint, $10::bigint) n
       ON CONFLICT (code) DO NOTHING RETURNING id, code`,
      [s.prefix, s.digits, s.id, s.entity_type, s.symbology, i.siteId ?? null, i.note?.trim() || null, ctx.actor.id, no, no + need - 1]);
    made.push(...r.rows); no += need;
  }
  if (made.length < i.count) throw invalidState('Could not find free numbers in this series; try again');
  await ctx.db.query('UPDATE barcode_series SET next_no=$2 WHERE id=$1', [s.id, no]);
  made.sort((a, b) => a.code.localeCompare(b.code));
  await audit(ctx, { action: 'barcode.issue', entityType: 'barcode_series', entityId: s.id, after: { count: made.length, from: made[0].code, to: made[made.length - 1].code } });
  return { series: s.name, count: made.length, ids: made.map((m) => m.id), first: made[0].code, last: made[made.length - 1].code };
}

/** Attach a blank code to the roll, shelf, material or person it will be stuck on. */
export async function assignCode(ctx: Ctx, i: { code: string; entityId: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'barcode.issue', ANY);
  const b = (await ctx.db.query('SELECT * FROM barcode WHERE code=$1 FOR UPDATE', [i.code.trim()])).rows[0];
  if (!b) throw notFound('Code');
  if (b.status !== 'active') throw invalidState('This code was cancelled');
  if (b.entity_id) throw invalidState('This code is already attached');
  const table = TABLE[b.entity_type as EntityType];
  if (!table) throw badRequest('This kind of code (cartons, assets, general) stands on its own; there is nothing to attach it to');
  const e = (await ctx.db.query(`SELECT id${table === 'lot' || table === 'location' || table === 'employee' ? ', site_id' : ''} FROM ${table} WHERE id=$1`, [i.entityId])).rows[0];
  if (!e) throw notFound('The thing to attach to');
  await ctx.db.query('UPDATE barcode SET entity_id=$2, assigned_at=now(), site_id=COALESCE(site_id,$3) WHERE id=$1', [b.id, e.id, e.site_id ?? null]);
  await audit(ctx, { action: 'barcode.assign', entityType: 'barcode', entityId: b.id, after: { code: b.code, entity_type: b.entity_type, entity_id: e.id } });
}

export async function updateNote(ctx: Ctx, i: { id: string; note: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'barcode.issue', ANY);
  const r = await ctx.db.query('UPDATE barcode SET note=$2 WHERE id=$1 AND status=\'active\' RETURNING id', [i.id, i.note.trim() || null]);
  if (!r.rowCount) throw notFound('Active code');
  await audit(ctx, { action: 'barcode.note', entityType: 'barcode', entityId: i.id, after: { note: i.note } });
}

/** Cancel a code (lost label, wrong print). The number is kept so it is never reused; scanning it says it was cancelled. */
export async function voidCode(ctx: Ctx, i: { id: string; reason: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'barcode.void', ANY);
  if (!i.reason?.trim()) throw badRequest('Say why it is being cancelled');
  const b = (await ctx.db.query('SELECT * FROM barcode WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
  if (!b) throw notFound('Code');
  if (b.status === 'void') throw invalidState('Already cancelled');
  if (b.issued_by === null) throw invalidState('This code is the identity of the roll, shelf, material or person itself and cannot be cancelled');
  await ctx.db.query(`UPDATE barcode SET status='void', voided_by=$2, voided_at=now(), void_reason=$3 WHERE id=$1`, [b.id, ctx.actor.id, i.reason.trim()]);
  await audit(ctx, { action: 'barcode.void', entityType: 'barcode', entityId: b.id, before: { code: b.code }, reason: i.reason.trim() });
}

// ───────────────────────── looking codes up ─────────────────────────
const NAME_SQL = `CASE b.entity_type WHEN 'item' THEN (SELECT i.code || ' · ' || i.name FROM item i WHERE i.id=b.entity_id)
                                    WHEN 'lot' THEN (SELECT 'Roll ' || l.label FROM lot l WHERE l.id=b.entity_id)
                                    WHEN 'location' THEN (SELECT x.code || ' · ' || x.name FROM location x WHERE x.id=b.entity_id)
                                    WHEN 'employee' THEN (SELECT e.code || ' · ' || e.name FROM employee e WHERE e.id=b.entity_id) END`;

export async function registry(db: Db, userId: string, f: { q?: string; type?: string; status?: string; unused?: boolean; limit?: number; offset?: number } = {}) {
  await assertCan(db, userId, 'barcode.view', ANY);
  const sites = await visibleSites(db, userId, 'barcode.view');
  const args: unknown[] = [sites];
  const w: string[] = ['($1::uuid[] IS NULL OR b.site_id IS NULL OR b.site_id = ANY($1::uuid[]))'];
  if (f.q?.trim()) { args.push('%' + f.q.trim().toLowerCase() + '%'); w.push(`(lower(b.code) LIKE $${args.length} OR lower(COALESCE(b.note,'')) LIKE $${args.length})`); }
  if (f.type) { args.push(f.type); w.push(`b.entity_type = $${args.length}`); }
  if (f.status) { args.push(f.status); w.push(`b.status = $${args.length}`); }
  if (f.unused) w.push(`b.entity_id IS NULL AND b.status = 'active' AND b.entity_type IN ('item','lot','location','employee')`);
  const where = w.join(' AND ');
  const total = (await db.query(`SELECT count(*)::int AS n FROM barcode b WHERE ${where}`, args)).rows[0].n;
  const rows = (await db.query(
    `SELECT b.id, b.code, b.entity_type, b.entity_id, b.symbology, b.status, b.note, b.issued_at, b.assigned_at, b.print_count, b.void_reason, b.issued_by IS NULL AS own_identity,
            s.name AS series, st.code AS site, u.display_name AS issued_by_name, ${NAME_SQL} AS attached_to
       FROM barcode b LEFT JOIN barcode_series s ON s.id=b.series_id LEFT JOIN site st ON st.id=b.site_id LEFT JOIN app_user u ON u.id=b.issued_by
      WHERE ${where} ORDER BY b.issued_at DESC, b.code DESC LIMIT ${Math.min(f.limit ?? 100, 500)} OFFSET ${Math.max(f.offset ?? 0, 0)}`, args)).rows;
  const counts = (await db.query(`SELECT b.entity_type, count(*)::int AS n, count(*) FILTER (WHERE b.status='void')::int AS voided FROM barcode b WHERE ($1::uuid[] IS NULL OR b.site_id IS NULL OR b.site_id = ANY($1::uuid[])) GROUP BY 1 ORDER BY 1`, [sites])).rows;
  return { total, rows, counts };
}

/** Read one code from the registry: what it is, whether it is still good, and what it is stuck on. */
export async function lookup(db: Db, userId: string, code: string) {
  await assertCan(db, userId, 'barcode.view', ANY);
  const b = (await db.query(`SELECT b.*, ${NAME_SQL} AS attached_to, s.name AS series FROM barcode b LEFT JOIN barcode_series s ON s.id=b.series_id WHERE b.code=$1`, [code.trim()])).rows[0];
  if (!b) return null;
  const sites = await visibleSites(db, userId, 'barcode.view');
  if (sites && b.site_id && !sites.includes(b.site_id)) return null;
  return b;
}

export async function printHistory(db: Db, userId: string, barcodeId: string) {
  await assertCan(db, userId, 'barcode.view', ANY);
  return (await db.query(
    `SELECT p.printed_at, p.copies, p.is_reprint, p.reason, p.layout_name, u.display_name AS who FROM barcode_print p LEFT JOIN app_user u ON u.id=p.printed_by WHERE p.barcode_id=$1 ORDER BY p.id DESC LIMIT 50`, [barcodeId])).rows;
}

// ───────────────────────── layouts ─────────────────────────
export type Element = { type: 'field' | 'text' | 'barcode' | 'qr' | 'line'; x: number; y: number; w: number; h: number; field?: string; text?: string; size?: number; bold?: boolean; align?: 'left' | 'center' | 'right' };

export function checkLayout(i: { entityType: string; widthMm: number; heightMm: number; elements: Element[] }) {
  if (!ENTITY_TYPES.includes(i.entityType as EntityType)) throw badRequest('Pick what this label is for');
  if (!(i.widthMm >= 15 && i.widthMm <= 210) || !(i.heightMm >= 10 && i.heightMm <= 297)) throw badRequest('Label size: width 15 to 210 mm, height 10 to 297 mm');
  if (!Array.isArray(i.elements) || i.elements.length > 40) throw badRequest('A label can hold up to 40 items');
  const keys = FIELDS[i.entityType as EntityType].map((f) => f.key);
  let codes = 0;
  i.elements.forEach((e, n) => {
    const at = `Item ${n + 1}`;
    if (!['field', 'text', 'barcode', 'qr', 'line'].includes(e.type)) throw badRequest(`${at}: unknown kind`);
    for (const k of ['x', 'y', 'w', 'h'] as const) if (typeof e[k] !== 'number' || !Number.isFinite(e[k])) throw badRequest(`${at}: ${k} must be a number`);
    if (e.x < 0 || e.y < 0 || e.w < 0 || e.h < 0 || e.x + e.w > i.widthMm + 0.01 || e.y + e.h > i.heightMm + 0.01) throw badRequest(`${at} sticks out of the label`);
    if (e.type === 'field' && !keys.includes(e.field ?? '')) throw badRequest(`${at}: "${e.field}" is not available for this kind of label`);
    if (e.type === 'text' && !(e.text ?? '').trim()) throw badRequest(`${at}: write some text`);
    if ((e.type === 'field' || e.type === 'text') && !(e.size == null || (e.size >= 4 && e.size <= 60))) throw badRequest(`${at}: text size 4 to 60 pt`);
    if ((e.type === 'barcode' || e.type === 'qr') && (e.w < 5 || e.h < 5)) throw badRequest(`${at}: code too small to scan`);
    if (e.type === 'barcode' || e.type === 'qr') codes++;
  });
  if (!codes) throw badRequest('A label needs at least one barcode or QR code');
}

export async function listLayouts(db: Db, userId: string, entityType?: string) {
  await assertCan(db, userId, 'barcode.view', ANY);
  return (await db.query(`SELECT * FROM label_layout WHERE active AND ($1::text IS NULL OR entity_type=$1) ORDER BY entity_type, is_default DESC, name`, [entityType ?? null])).rows;
}

export async function saveLayout(ctx: Ctx, i: { id?: string; name: string; entityType: string; widthMm: number; heightMm: number; columns?: number; gapMm?: number; elements: Element[]; makeDefault?: boolean; expectedVersion?: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'barcode.layout', ANY);
  if (!i.name?.trim()) throw badRequest('Give the layout a name');
  checkLayout(i);
  if (i.columns != null && !(Number.isInteger(i.columns) && i.columns >= 1 && i.columns <= 8)) throw badRequest('Labels across: 1 to 8');
  if (i.gapMm != null && !(i.gapMm >= 0 && i.gapMm <= 20)) throw badRequest('Gap: 0 to 20 mm');
  const clash = (await ctx.db.query('SELECT id FROM label_layout WHERE lower(name)=lower($1) AND active AND id IS DISTINCT FROM $2', [i.name.trim(), i.id ?? null])).rowCount;
  if (clash) throw badRequest('Another layout already has this name');
  let row;
  if (i.id) {
    const old = (await ctx.db.query('SELECT * FROM label_layout WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!old || !old.active) throw notFound('Layout');
    if (i.expectedVersion != null && old.version !== i.expectedVersion) throw invalidState('Someone else changed this layout; reopen it and try again');
    if (old.entity_type !== i.entityType) throw badRequest('A layout cannot change what it is for; make a new one');
    row = (await ctx.db.query(`UPDATE label_layout SET name=$2,width_mm=$3,height_mm=$4,columns=$5,gap_mm=$6,elements=$7,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
      [i.id, i.name.trim(), i.widthMm, i.heightMm, i.columns ?? old.columns, i.gapMm ?? old.gap_mm, JSON.stringify(i.elements)])).rows[0];
    await audit(ctx, { action: 'barcode.layout.update', entityType: 'label_layout', entityId: i.id, before: old, after: row });
  } else {
    row = (await ctx.db.query(`INSERT INTO label_layout(name,entity_type,width_mm,height_mm,columns,gap_mm,elements,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [i.name.trim(), i.entityType, i.widthMm, i.heightMm, i.columns ?? 1, i.gapMm ?? 2, JSON.stringify(i.elements), ctx.actor.id])).rows[0];
    await audit(ctx, { action: 'barcode.layout.create', entityType: 'label_layout', entityId: row.id, after: row });
  }
  if (i.makeDefault) await setDefaultLayout(ctx, { id: row.id });
  return row;
}

export async function setDefaultLayout(ctx: Ctx, i: { id: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'barcode.layout', ANY);
  const l = (await ctx.db.query('SELECT * FROM label_layout WHERE id=$1 AND active', [i.id])).rows[0];
  if (!l) throw notFound('Layout');
  await ctx.db.query('UPDATE label_layout SET is_default=false WHERE entity_type=$1 AND is_default', [l.entity_type]);
  await ctx.db.query('UPDATE label_layout SET is_default=true WHERE id=$1', [i.id]);
  await audit(ctx, { action: 'barcode.layout.default', entityType: 'label_layout', entityId: i.id });
}

export async function removeLayout(ctx: Ctx, i: { id: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'barcode.layout', ANY);
  const l = (await ctx.db.query('SELECT * FROM label_layout WHERE id=$1 AND active FOR UPDATE', [i.id])).rows[0];
  if (!l) throw notFound('Layout');
  const others = (await ctx.db.query('SELECT count(*)::int n FROM label_layout WHERE entity_type=$1 AND active AND id<>$2', [l.entity_type, i.id])).rows[0].n;
  if (!others) throw invalidState('Keep at least one layout for this kind of label');
  await ctx.db.query('UPDATE label_layout SET active=false, is_default=false WHERE id=$1', [i.id]);
  if (l.is_default) await ctx.db.query(`UPDATE label_layout SET is_default=true WHERE id=(SELECT id FROM label_layout WHERE entity_type=$1 AND active ORDER BY name LIMIT 1)`, [l.entity_type]);
  await audit(ctx, { action: 'barcode.layout.remove', entityType: 'label_layout', entityId: i.id, before: { name: l.name } });
}

// ───────────────────────── printing ─────────────────────────
/** The words that go on each label, for the chosen codes. */
export async function labelValues(db: Db, userId: string, barcodeIds: string[], layoutId: string) {
  await assertCan(db, userId, 'barcode.print', ANY);
  if (!barcodeIds.length) throw badRequest('Pick the codes to print');
  if (barcodeIds.length > 500) throw badRequest('Print up to 500 labels at a time');
  const layout = (await db.query('SELECT * FROM label_layout WHERE id=$1 AND active', [layoutId])).rows[0];
  if (!layout) throw notFound('Layout');
  const sites = await visibleSites(db, userId, 'barcode.print');
  const codes = (await db.query(`SELECT b.*, st.code AS site_code FROM barcode b LEFT JOIN site st ON st.id=b.site_id WHERE b.id = ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR b.site_id IS NULL OR b.site_id = ANY($2::uuid[]))`, [barcodeIds, sites])).rows;
  if (codes.length !== new Set(barcodeIds).size) throw notFound('One or more codes');
  const labels = [];
  for (const b of codes.sort((x, y) => x.code.localeCompare(y.code))) {
    if (b.status !== 'active') throw invalidState(`${b.code} was cancelled and cannot be printed`);
    if (b.entity_type !== layout.entity_type) throw badRequest(`${b.code} is a ${b.entity_type} code but this layout is for ${layout.entity_type} labels`);
    const v: Record<string, string> = { barcode: b.code, code: b.code, note: b.note ?? '', date: new Date(b.issued_at).toISOString().slice(0, 10), site: b.site_code ?? '' };
    if (b.entity_id) {
      let r: Record<string, unknown> | undefined;
      if (b.entity_type === 'item') r = (await db.query(`SELECT i.code, i.name, i.stock_unit AS unit, COALESCE(t.name,'') AS type, COALESCE(i.hsn_code,'') AS hsn FROM item i LEFT JOIN material_type t ON t.id=i.material_type_id WHERE i.id=$1`, [b.entity_id])).rows[0];
      else if (b.entity_type === 'lot') r = (await db.query(`SELECT l.label AS code, i.code AS item_code, i.name AS item_name, i.stock_unit AS unit, to_char(l.created_at,'DD Mon YYYY') AS date,
          COALESCE((SELECT sum(qty) FROM stock_ledger s WHERE s.lot_id=l.id AND s.status IN ('HOLD','ACCEPTED')),0)::text AS qty FROM lot l JOIN item i ON i.id=l.item_id WHERE l.id=$1`, [b.entity_id])).rows[0];
      else if (b.entity_type === 'location') r = (await db.query(`SELECT code, name, lower(kind) AS kind FROM location WHERE id=$1`, [b.entity_id])).rows[0];
      else if (b.entity_type === 'employee') r = (await db.query(`SELECT e.code, e.name, COALESCE(d.name,'') AS department FROM employee e LEFT JOIN department d ON d.id=e.department_id WHERE e.id=$1`, [b.entity_id])).rows[0];
      if (r) for (const [k, x] of Object.entries(r)) v[k] = x == null ? '' : String(x);
    }
    labels.push({ id: b.id, code: b.code, symbology: b.symbology as string, values: v, printed_before: b.print_count > 0 });
  }
  return { layout, labels };
}

/** Write down that these codes were printed. A second print of the same code needs a reason, so spare labels do not quietly pile up. */
export async function recordPrint(ctx: Ctx, i: { barcodeIds: string[]; layoutId: string; copies?: number; reason?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'barcode.print', ANY);
  const copies = i.copies ?? 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > 100) throw badRequest('Copies: 1 to 100');
  const layout = (await ctx.db.query('SELECT id, name, entity_type FROM label_layout WHERE id=$1', [i.layoutId])).rows[0];
  if (!layout) throw notFound('Layout');
  const codes = (await ctx.db.query('SELECT * FROM barcode WHERE id = ANY($1::uuid[]) FOR UPDATE', [i.barcodeIds])).rows;
  if (!codes.length || codes.length !== new Set(i.barcodeIds).size) throw notFound('One or more codes');
  for (const b of codes) { if (b.status !== 'active') throw invalidState(`${b.code} was cancelled and cannot be printed`); if (b.entity_type !== layout.entity_type) throw badRequest(`${b.code} does not match this layout`); }
  const again = codes.filter((b) => b.print_count > 0);
  if (again.length && !i.reason?.trim()) throw badRequest(`${again.length === 1 ? again[0].code + ' was' : again.length + ' of these codes were'} printed before. Say why they are printed again (torn, faded, extra copy)`);
  const batch = (await ctx.db.query('SELECT gen_random_uuid() AS id')).rows[0].id;
  for (const b of codes) await ctx.db.query(`INSERT INTO barcode_print(batch_id, barcode_id, layout_id, layout_name, copies, is_reprint, reason, printed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [batch, b.id, layout.id, layout.name, copies, b.print_count > 0, b.print_count > 0 ? i.reason!.trim() : null, ctx.actor.id]);
  await ctx.db.query('UPDATE barcode SET print_count = print_count + 1 WHERE id = ANY($1::uuid[])', [codes.map((b) => b.id)]);
  await audit(ctx, { action: 'barcode.print', entityType: 'barcode', after: { batch, layout: layout.name, codes: codes.length, copies, reprints: again.length }, reason: i.reason ?? null });
  return { batch, printed: codes.length, reprints: again.length };
}
