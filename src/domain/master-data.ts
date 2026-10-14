// Master data: material types, materials (items), vendors and clients (partners) — profile, contacts, addresses, status, bulk add.
import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan, can } from '../core/permissions.js';
import { audit } from '../core/audit.js';
import { badRequest, invalidState, notFound, staleVersion } from '../core/errors.js';

const ANY = { anySite: true } as const;
export const KINDS = ['FABRIC', 'TRIM', 'CUP', 'PACKING', 'PROCESS', 'WIP', 'FG'] as const;
export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
export type AttrDef = { key: string; label: string; type: 'number' | 'text'; unit?: string; required?: boolean };

/** Parse "Width|number|cm|required" lines into an attribute schema (one per line). */
export function parseAttrs(text: string): AttrDef[] {
  const out: AttrDef[] = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [label, type = 'text', unit = '', req = ''] = line.split('|').map((x) => x.trim());
    const key = label.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w, n) => (n ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
    if (!key) throw badRequest(`Bad attribute line "${line}"`);
    if (type !== 'number' && type !== 'text') throw badRequest(`Attribute "${label}": type must be number or text`);
    if (out.some((a) => a.key === key)) throw badRequest(`Attribute "${label}" is listed twice`);
    out.push({ key, label, type, ...(unit ? { unit } : {}), ...(/^req/i.test(req) || /^req/i.test(unit) ? { required: true } : {}) });
    if (/^req/i.test(unit)) delete (out[out.length - 1] as AttrDef).unit;
  }
  return out;
}
export const attrsToText = (a: AttrDef[]) => a.map((x) => [x.label, x.type, x.unit ?? '', x.required ? 'required' : ''].join('|').replace(/\|+$/, '')).join('\n');

/** Check an item's attributes against its type's schema; returns the cleaned object. */
export function checkAttrs(schema: AttrDef[], given: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of schema) {
    const v = given[a.key];
    if (v === undefined || v === null || v === '') { if (a.required) throw badRequest(`${a.label} is required for this material type`); continue; }
    if (a.type === 'number') { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw badRequest(`${a.label} must be a number`); out[a.key] = n; }
    else out[a.key] = String(v).trim();
  }
  for (const k of Object.keys(given)) if (!(k in out) && !schema.some((a) => a.key === k)) out[k] = given[k]; // keep legacy keys (e.g. widthCm)
  return out;
}

// ───────────────────────── Material types ─────────────────────────
export async function createMaterialType(ctx: Ctx, i: { code: string; name: string; kind: string; defaultUnit: string; tracking?: string; prefix?: string; attrs?: AttrDef[] }) {
  await assertCan(ctx.db, ctx.actor.id, 'mtype.manage', ANY);
  const code = i.code.trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,12}$/.test(code)) throw badRequest('Type code: 2–12 letters, digits or dashes');
  if (!i.name.trim()) throw badRequest('Name is required');
  if (!KINDS.includes(i.kind as never)) throw badRequest(`Unknown kind ${i.kind}`);
  if (!(await ctx.db.query('SELECT 1 FROM unit WHERE code=$1', [i.defaultUnit])).rowCount) throw badRequest(`Unknown unit ${i.defaultUnit}`);
  if ((await ctx.db.query('SELECT 1 FROM material_type WHERE code=$1 OR lower(name)=lower($2)', [code, i.name.trim()])).rowCount) throw badRequest('A material type with this code or name already exists');
  const prefix = (i.prefix || code.slice(0, 3)).toUpperCase();
  const r = await ctx.db.query(
    `INSERT INTO material_type(code,name,kind,default_unit,tracking,attr_schema,code_prefix,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [code, i.name.trim(), i.kind, i.defaultUnit, i.tracking ?? 'LOT', JSON.stringify(i.attrs ?? []), prefix, ctx.actor.id]);
  await audit(ctx, { action: 'mtype.create', entityType: 'material_type', entityId: r.rows[0].id, after: r.rows[0] });
  return r.rows[0];
}

export async function updateMaterialType(ctx: Ctx, i: { id: string; name?: string; attrs?: AttrDef[]; status?: 'active' | 'inactive'; tracking?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'mtype.manage', ANY);
  const t = (await ctx.db.query('SELECT * FROM material_type WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
  if (!t) throw notFound('Material type');
  const r = await ctx.db.query(
    `UPDATE material_type SET name=$2, attr_schema=$3, status=$4, tracking=$5 WHERE id=$1 RETURNING *`,
    [i.id, i.name?.trim() || t.name, JSON.stringify(i.attrs ?? t.attr_schema), i.status ?? t.status, i.tracking ?? t.tracking]);
  await audit(ctx, { action: 'mtype.update', entityType: 'material_type', entityId: i.id, before: t, after: r.rows[0] });
  return r.rows[0];
}

export async function listMaterialTypes(db: Db, userId: string) {
  if (!(await can(db, userId, 'item.view', ANY))) return [];
  return (await db.query(
    `SELECT t.*, (SELECT count(*) FROM item i WHERE i.material_type_id=t.id)::int AS items,
            (SELECT count(*) FROM item i WHERE i.material_type_id=t.id AND i.status='active')::int AS active_items
       FROM material_type t ORDER BY t.kind, t.name`)).rows;
}
export async function listUnits(db: Db) { return (await db.query('SELECT * FROM unit ORDER BY code')).rows; }

async function nextCode(db: Db, table: 'item' | 'partner', prefix: string): Promise<string> {
  const r = (await db.query(`SELECT code FROM ${table} WHERE code LIKE $1`, [prefix + '-%'])).rows.map((x) => parseInt(String(x.code).slice(prefix.length + 1), 10)).filter(Number.isFinite);
  return `${prefix}-${String((r.length ? Math.max(...r) : 0) + 1).padStart(3, '0')}`;
}

// ───────────────────────── Materials ─────────────────────────
export type NewMaterial = { typeId: string; name: string; code?: string; unit?: string; description?: string; hsnCode?: string; gstRate?: string; reorderLevel?: string; attributes?: Record<string, unknown>; parentId?: string | null };

export async function createMaterial(ctx: Ctx, i: NewMaterial) {
  await assertCan(ctx.db, ctx.actor.id, 'item.create', ANY);
  const t = (await ctx.db.query('SELECT * FROM material_type WHERE id=$1', [i.typeId])).rows[0];
  if (!t) throw notFound('Material type');
  if (t.status !== 'active') throw invalidState(`Material type ${t.name} is switched off`);
  const name = i.name.trim(); if (!name) throw badRequest('Name is required');
  if ((await ctx.db.query('SELECT code FROM item WHERE lower(name)=lower($1) AND material_type_id=$2', [name, t.id])).rowCount) throw badRequest(`A ${t.name} called "${name}" already exists`);
  if (i.hsnCode && !/^\d{4,8}$/.test(i.hsnCode)) throw badRequest('HSN code is 4–8 digits');
  if (i.gstRate !== undefined && i.gstRate !== '' && !(Number(i.gstRate) >= 0 && Number(i.gstRate) <= 40)) throw badRequest('GST rate must be between 0 and 40');
  if (i.reorderLevel && !(Number(i.reorderLevel) >= 0)) throw badRequest('Reorder level must be zero or more');
  const unit = i.unit || t.default_unit;
  if (!(await ctx.db.query('SELECT 1 FROM unit WHERE code=$1', [unit])).rowCount) throw badRequest(`Unknown unit ${unit}`);
  const code = (i.code?.trim().toUpperCase()) || (await nextCode(ctx.db, 'item', t.code_prefix));
  if ((await ctx.db.query('SELECT 1 FROM item WHERE code=$1', [code])).rowCount) throw badRequest(`Code ${code} is already used`);
  const attrs = checkAttrs(t.attr_schema, i.attributes);
  const r = await ctx.db.query(
    `INSERT INTO item(code,name,kind,stock_unit,tracking,parent_id,attributes,material_type_id,description,hsn_code,gst_rate,reorder_level,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [code, name, t.kind, unit, t.tracking, i.parentId ?? null, JSON.stringify(attrs), t.id, i.description?.trim() || null, i.hsnCode || null, i.gstRate ? i.gstRate : null, i.reorderLevel ? i.reorderLevel : null, ctx.actor.id]);
  await audit(ctx, { action: 'item.create', entityType: 'item', entityId: r.rows[0].id, after: r.rows[0] });
  return r.rows[0];
}

export async function updateMaterial(ctx: Ctx, i: { itemId: string; expectedVersion: number; name?: string; description?: string; hsnCode?: string; gstRate?: string; reorderLevel?: string; attributes?: Record<string, unknown>; typeId?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'item.edit', ANY);
  const it = (await ctx.db.query('SELECT * FROM item WHERE id=$1 FOR UPDATE', [i.itemId])).rows[0];
  if (!it) throw notFound('Material');
  if (it.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, it.version);
  if (it.status === 'submitted') throw invalidState('This material is waiting for approval; it cannot be edited now');
  if (i.hsnCode && !/^\d{4,8}$/.test(i.hsnCode)) throw badRequest('HSN code is 4–8 digits');
  if (i.gstRate && !(Number(i.gstRate) >= 0 && Number(i.gstRate) <= 40)) throw badRequest('GST rate must be between 0 and 40');
  let typeId = it.material_type_id;
  if (i.typeId && i.typeId !== typeId) {
    if (typeId) throw invalidState('The material type cannot be changed once set');
    const nt = (await ctx.db.query('SELECT * FROM material_type WHERE id=$1', [i.typeId])).rows[0];
    if (!nt) throw notFound('Material type');
    if (nt.kind !== it.kind) throw badRequest(`This type is for ${nt.kind} materials, not ${it.kind}`);
    typeId = nt.id;
  }
  const t = typeId ? (await ctx.db.query('SELECT attr_schema FROM material_type WHERE id=$1', [typeId])).rows[0] : null;
  const attrs = i.attributes ? checkAttrs(t?.attr_schema ?? [], i.attributes) : it.attributes;
  const r = await ctx.db.query(
    `UPDATE item SET name=$2, description=$3, hsn_code=$4, gst_rate=$5, reorder_level=$6, attributes=$7, material_type_id=$8, version=version+1 WHERE id=$1 RETURNING *`,
    [i.itemId, i.name?.trim() || it.name, i.description ?? it.description, i.hsnCode ?? it.hsn_code, i.gstRate === undefined ? it.gst_rate : (i.gstRate || null), i.reorderLevel === undefined ? it.reorder_level : (i.reorderLevel || null), JSON.stringify(attrs), typeId]);
  await audit(ctx, { action: 'item.update', entityType: 'item', entityId: i.itemId, before: it, after: r.rows[0] });
  return r.rows[0];
}

/** Switch a material off (or back on). Switching off is refused while stock or open orders still use it. */
export async function setMaterialActive(ctx: Ctx, i: { itemId: string; expectedVersion: number; active: boolean; reason?: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'item.deactivate', ANY);
  const it = (await ctx.db.query('SELECT * FROM item WHERE id=$1 FOR UPDATE', [i.itemId])).rows[0];
  if (!it) throw notFound('Material');
  if (it.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, it.version);
  if (i.active) {
    if (it.status !== 'inactive') throw invalidState(`Material is ${it.status}`);
  } else {
    if (it.status !== 'active') throw invalidState(`Only active materials can be switched off (this one is ${it.status})`);
    if (!i.reason?.trim()) throw badRequest('Say why it is being switched off');
    const stock = (await ctx.db.query(`SELECT COALESCE(sum(qty),0)::numeric AS q FROM stock_ledger WHERE item_id=$1 AND status IN ('ACCEPTED','HOLD')`, [i.itemId])).rows[0].q;
    if (Number(stock) > 0) throw invalidState(`Still ${Number(stock)} ${it.stock_unit} in stock — use it up or adjust it out first`);
    const open = (await ctx.db.query(
      `SELECT (SELECT count(*) FROM po_line l JOIN purchase_order p ON p.id=l.po_id WHERE l.item_id=$1 AND p.status NOT IN ('completed','closed','cancelled'))
            + (SELECT count(*) FROM so_line l JOIN sales_order s ON s.id=l.so_id WHERE l.item_id=$1 AND s.status NOT IN ('completed','dispatched','cancelled')) AS n`, [i.itemId])).rows[0].n;
    if (Number(open) > 0) throw invalidState(`${open} open order line(s) still use this material`);
  }
  const r = await ctx.db.query(`UPDATE item SET status=$2, version=version+1 WHERE id=$1 RETURNING *`, [i.itemId, i.active ? 'active' : 'inactive']);
  await audit(ctx, { action: i.active ? 'item.reactivate' : 'item.deactivate', entityType: 'item', entityId: i.itemId, before: { status: it.status }, after: { status: r.rows[0].status }, reason: i.reason ?? null });
  return r.rows[0];
}

export async function listMaterials(db: Db, userId: string, f: { q?: string; typeId?: string; status?: string } = {}) {
  if (!(await can(db, userId, 'item.view', ANY))) return [];
  const q = f.q?.trim() ? `%${f.q.trim().toLowerCase()}%` : null;
  return (await db.query(
    `SELECT i.id, i.code, i.name, i.kind, i.stock_unit, i.status, i.version, i.tracking, i.hsn_code, i.gst_rate::text, i.reorder_level::text, i.attributes, i.material_type_id,
            t.name AS type_name, t.code AS type_code,
            COALESCE((SELECT sum(qty) FROM stock_ledger s WHERE s.item_id=i.id AND s.status='ACCEPTED'),0)::text AS on_hand,
            COALESCE((SELECT sum(qty) FROM stock_ledger s WHERE s.item_id=i.id AND s.status='HOLD'),0)::text AS on_hold
       FROM item i LEFT JOIN material_type t ON t.id=i.material_type_id
      WHERE ($1::text IS NULL OR lower(i.code) LIKE $1 OR lower(i.name) LIKE $1)
        AND ($2::uuid IS NULL OR i.material_type_id=$2) AND ($3::text IS NULL OR i.status=$3)
      ORDER BY i.code`, [q, f.typeId || null, f.status || null])).rows;
}

export async function getMaterial(db: Db, userId: string, id: string) {
  if (!(await can(db, userId, 'item.view', ANY))) throw notFound('Material');
  const it = (await db.query(
    `SELECT i.*, t.name AS type_name, t.attr_schema, c.username AS created_by_name FROM item i
       LEFT JOIN material_type t ON t.id=i.material_type_id LEFT JOIN app_user c ON c.id=i.created_by WHERE i.id=$1`, [id])).rows[0];
  if (!it) throw notFound('Material');
  const stock = (await db.query(
    `SELECT l.label, loc.code AS location, sl.status, sum(sl.qty)::text AS qty FROM stock_ledger sl JOIN lot l ON l.id=sl.lot_id JOIN location loc ON loc.id=sl.location_id
      WHERE sl.item_id=$1 GROUP BY 1,2,3 HAVING sum(sl.qty)<>0 ORDER BY 1`, [id])).rows;
  const rates = (await db.query(
    `SELECT r.id, r.rate::text, r.unit, r.min_qty::text, r.effective_from, r.effective_to, r.status, p.name AS vendor, p.code AS vendor_code
       FROM rate r JOIN partner p ON p.id=r.partner_id WHERE r.item_id=$1 ORDER BY p.name, r.effective_from DESC`, [id])).rows;
  const history = (await db.query(`SELECT a.at, a.action, a.reason, u.display_name AS who FROM audit_log a LEFT JOIN app_user u ON u.id=a.actor_id WHERE a.entity_type='item' AND a.entity_id=$1 ORDER BY a.id DESC LIMIT 12`, [id])).rows;
  const used = (await db.query(`SELECT (SELECT count(*) FROM po_line WHERE item_id=$1)::int AS po, (SELECT count(*) FROM so_line WHERE item_id=$1)::int AS so`, [id])).rows[0];
  return { item: it, stock, rates, history, used };
}

// ───────────────────────── Vendors & clients ─────────────────────────
export const INDIAN_STATES = ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];
export type AddressInput = { kind?: string; label?: string; line1: string; line2?: string; city?: string; state?: string; pincode?: string; contactName?: string; phone?: string; gstin?: string; makeDefault?: boolean };
const checkState = (st?: string) => { if (st && !INDIAN_STATES.includes(st)) throw badRequest(`State "${st}" is not in the list`); };
function checkAddress(a: AddressInput, strict: boolean) {
  if (!a.line1?.trim()) throw badRequest('Address is required');
  if (strict && (!a.city?.trim() || !a.state || !a.pincode)) throw badRequest('Billing and shipping addresses need city, state and pincode');
  checkState(a.state);
  if (a.pincode && !/^\d{6}$/.test(a.pincode)) throw badRequest('Pincode is 6 digits');
  if (a.phone && !/^[+\d][\d\s-]{6,16}$/.test(a.phone)) throw badRequest('Phone number looks wrong');
  if (a.gstin && !GSTIN_RE.test(a.gstin.toUpperCase())) throw badRequest('GSTIN for this address looks wrong');
}
async function insertAddress(ctx: Ctx, partnerId: string, kind: string, a: AddressInput) {
  const first = !(await ctx.db.query('SELECT 1 FROM partner_address WHERE partner_id=$1 AND kind=$2', [partnerId, kind])).rowCount;
  const def = first || !!a.makeDefault;
  if (def) await ctx.db.query('UPDATE partner_address SET is_default=false WHERE partner_id=$1 AND kind=$2', [partnerId, kind]);
  const r = await ctx.db.query(`INSERT INTO partner_address(partner_id,kind,label,line1,line2,city,state,pincode,contact_name,phone,gstin,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [partnerId, kind, a.label?.trim() || null, a.line1.trim(), a.line2?.trim() || null, a.city?.trim() || null, a.state || null, a.pincode || null, a.contactName?.trim() || null, a.phone || null, a.gstin?.toUpperCase() || null, def]);
  return r.rows[0];
}

export type PartnerProfile = { name?: string; gstin?: string; pan?: string; state?: string; city?: string; phone?: string; email?: string; paymentDays?: number | null; notes?: string; bankAccount?: string };

function checkProfile(p: PartnerProfile) {
  if (p.gstin && !GSTIN_RE.test(p.gstin.toUpperCase())) throw badRequest('GSTIN looks wrong — it has 15 characters, like 29ABCDE1234F1Z5');
  if (p.pan && !PAN_RE.test(p.pan.toUpperCase())) throw badRequest('PAN looks wrong — 5 letters, 4 digits, 1 letter');
  if (p.gstin && p.pan && p.gstin.slice(2, 12).toUpperCase() !== p.pan.toUpperCase()) throw badRequest('PAN does not match the GSTIN');
  if (p.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) throw badRequest('Email address looks wrong');
  if (p.phone && !/^[+\d][\d\s-]{6,16}$/.test(p.phone)) throw badRequest('Phone number looks wrong');
  checkState(p.state);
  if (p.paymentDays != null && !(Number.isInteger(p.paymentDays) && p.paymentDays >= 0 && p.paymentDays <= 365)) throw badRequest('Payment days: 0 to 365');
}

export async function createParty(ctx: Ctx, i: PartnerProfile & { name: string; role: 'vendor' | 'customer' | 'both' | 'subcontractor'; code?: string; contact?: { name: string; phone?: string; email?: string; role?: string }; billing?: AddressInput; shipping?: AddressInput; shippingSameAsBilling?: boolean }) {
  await assertCan(ctx.db, ctx.actor.id, 'partner.create', ANY);
  if (!i.name?.trim()) throw badRequest('Name is required');
  checkProfile(i);
  if (i.billing) checkAddress(i.billing, true);
  const ship = i.shippingSameAsBilling ? i.billing : i.shipping;
  if (ship) checkAddress(ship, true);
  const dup = await ctx.db.query(`SELECT code FROM partner WHERE lower(name)=lower($1) OR ($2::text IS NOT NULL AND gstin=$2) OR ($3::text IS NOT NULL AND pan=$3 AND lower(name)=lower($1))`, [i.name.trim(), i.gstin?.toUpperCase() ?? null, i.pan?.toUpperCase() ?? null]);
  if (dup.rowCount) throw badRequest(`Possible duplicate — already on file as ${dup.rows[0].code}`);
  const vendor = i.role === 'vendor' || i.role === 'both', cust = i.role === 'customer' || i.role === 'both';
  const code = i.code?.trim().toUpperCase() || (await nextCode(ctx.db, 'partner', cust && !vendor ? 'C' : 'V'));
  const r = await ctx.db.query(
    `INSERT INTO partner(code,name,is_vendor,is_customer,is_subcontractor,gstin,pan,state,city,phone,email,payment_days,notes,bank_account,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [code, i.name.trim(), vendor, cust, i.role === 'subcontractor', i.gstin?.toUpperCase() || null, i.pan?.toUpperCase() || null, i.state || null, i.city || null, i.phone || null, i.email || null, i.paymentDays ?? null, i.notes || null, i.bankAccount || null, ctx.actor.id]);
  const p = r.rows[0];
  if (i.contact?.name.trim()) await ctx.db.query(`INSERT INTO partner_contact(partner_id,name,role,phone,email,is_primary) VALUES ($1,$2,$3,$4,$5,true)`, [p.id, i.contact.name.trim(), i.contact.role || null, i.contact.phone || null, i.contact.email || null]);
  if (i.billing) await insertAddress(ctx, p.id, 'billing', i.billing);
  if (ship) await insertAddress(ctx, p.id, 'shipping', ship);
  await audit(ctx, { action: 'partner.create', entityType: 'partner', entityId: p.id, after: { code: p.code, name: p.name, role: i.role } });
  return p;
}

/** Change the profile. Changing bank or GSTIN on an approved party sends it back for verification. */
export async function updateParty(ctx: Ctx, i: PartnerProfile & { partnerId: string; expectedVersion: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'partner.edit', ANY);
  const p = (await ctx.db.query('SELECT * FROM partner WHERE id=$1 FOR UPDATE', [i.partnerId])).rows[0];
  if (!p) throw notFound('Party');
  if (p.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, p.version);
  checkProfile(i);
  const gstin = i.gstin === undefined ? p.gstin : (i.gstin.toUpperCase() || null);
  const pan = i.pan === undefined ? p.pan : (i.pan.toUpperCase() || null);
  const bank = i.bankAccount === undefined || i.bankAccount === '' ? p.bank_account : i.bankAccount;
  if (gstin && pan && gstin.slice(2, 12) !== pan) throw badRequest('PAN does not match the GSTIN');
  if (gstin && gstin !== p.gstin && (await ctx.db.query('SELECT 1 FROM partner WHERE gstin=$1 AND id<>$2', [gstin, p.id])).rowCount) throw badRequest('Another party already has this GSTIN');
  const sensitive = gstin !== p.gstin || bank !== p.bank_account;
  const reverify = sensitive && ['active', 'suspended'].includes(p.status);
  const r = await ctx.db.query(
    `UPDATE partner SET name=$2, gstin=$3, pan=$4, state=$5, city=$6, phone=$7, email=$8, payment_days=$9, notes=$10, bank_account=$11,
            bank_verified_by = CASE WHEN $12 THEN NULL ELSE bank_verified_by END, status = CASE WHEN $12 THEN 'verification' ELSE status END, version=version+1
      WHERE id=$1 RETURNING *`,
    [i.partnerId, i.name?.trim() || p.name, gstin, pan, i.state ?? p.state, i.city ?? p.city, i.phone ?? p.phone, i.email ?? p.email, i.paymentDays === undefined ? p.payment_days : i.paymentDays, i.notes ?? p.notes, bank, reverify]);
  const mask = (x: Record<string, unknown>) => ({ ...x, bank_account: x.bank_account ? '••••' + String(x.bank_account).slice(-4) : null });
  await audit(ctx, { action: 'partner.update', entityType: 'partner', entityId: p.id, before: mask(p), after: mask(r.rows[0]), reason: reverify ? 'Bank/GSTIN changed — sent back for verification' : null });
  return { ...r.rows[0], sentBack: reverify };
}

export async function addContact(ctx: Ctx, i: { partnerId: string; name: string; role?: string; phone?: string; email?: string; primary?: boolean }) {
  await assertCan(ctx.db, ctx.actor.id, 'partner.edit', ANY);
  if (!(await ctx.db.query('SELECT 1 FROM partner WHERE id=$1', [i.partnerId])).rowCount) throw notFound('Party');
  if (!i.name.trim()) throw badRequest('Contact name is required');
  checkProfile({ phone: i.phone, email: i.email });
  const first = !(await ctx.db.query('SELECT 1 FROM partner_contact WHERE partner_id=$1', [i.partnerId])).rowCount;
  if (i.primary) await ctx.db.query('UPDATE partner_contact SET is_primary=false WHERE partner_id=$1', [i.partnerId]);
  const r = await ctx.db.query(`INSERT INTO partner_contact(partner_id,name,role,phone,email,is_primary) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [i.partnerId, i.name.trim(), i.role || null, i.phone || null, i.email || null, !!i.primary || first]);
  await audit(ctx, { action: 'partner.contact.add', entityType: 'partner', entityId: i.partnerId, after: r.rows[0] });
  return r.rows[0];
}
export async function removeContact(ctx: Ctx, i: { contactId: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'partner.edit', ANY);
  const c = (await ctx.db.query('DELETE FROM partner_contact WHERE id=$1 RETURNING *', [i.contactId])).rows[0];
  if (!c) throw notFound('Contact');
  if (c.is_primary) await ctx.db.query(`UPDATE partner_contact SET is_primary=true WHERE id=(SELECT id FROM partner_contact WHERE partner_id=$1 ORDER BY created_at LIMIT 1)`, [c.partner_id]);
  await audit(ctx, { action: 'partner.contact.remove', entityType: 'partner', entityId: c.partner_id, before: c });
}
export async function addAddress(ctx: Ctx, i: AddressInput & { partnerId: string; kind: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'partner.edit', ANY);
  if (!(await ctx.db.query('SELECT 1 FROM partner WHERE id=$1', [i.partnerId])).rowCount) throw notFound('Party');
  if (!['registered', 'billing', 'shipping', 'works'].includes(i.kind)) throw badRequest('Address kind: registered, billing, shipping or works');
  checkAddress(i, i.kind === 'billing' || i.kind === 'shipping');
  const row = await insertAddress(ctx, i.partnerId, i.kind, i);
  await audit(ctx, { action: 'partner.address.add', entityType: 'partner', entityId: i.partnerId, after: row });
  return row;
}
export async function updateAddress(ctx: Ctx, i: AddressInput & { addressId: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'partner.edit', ANY);
  const old = (await ctx.db.query('SELECT * FROM partner_address WHERE id=$1 FOR UPDATE', [i.addressId])).rows[0];
  if (!old) throw notFound('Address');
  checkAddress(i, old.kind === 'billing' || old.kind === 'shipping');
  const r = await ctx.db.query(`UPDATE partner_address SET label=$2,line1=$3,line2=$4,city=$5,state=$6,pincode=$7,contact_name=$8,phone=$9,gstin=$10 WHERE id=$1 RETURNING *`,
    [i.addressId, i.label?.trim() || null, i.line1.trim(), i.line2?.trim() || null, i.city?.trim() || null, i.state || null, i.pincode || null, i.contactName?.trim() || null, i.phone || null, i.gstin?.toUpperCase() || null]);
  await audit(ctx, { action: 'partner.address.update', entityType: 'partner', entityId: old.partner_id, before: old, after: r.rows[0] });
  return r.rows[0];
}
export async function setDefaultAddress(ctx: Ctx, i: { addressId: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'partner.edit', ANY);
  const a = (await ctx.db.query('SELECT * FROM partner_address WHERE id=$1 FOR UPDATE', [i.addressId])).rows[0];
  if (!a) throw notFound('Address');
  await ctx.db.query('UPDATE partner_address SET is_default=false WHERE partner_id=$1 AND kind=$2', [a.partner_id, a.kind]);
  await ctx.db.query('UPDATE partner_address SET is_default=true WHERE id=$1', [i.addressId]);
  await audit(ctx, { action: 'partner.address.default', entityType: 'partner', entityId: a.partner_id, after: { id: a.id, kind: a.kind } });
}
export async function removeAddress(ctx: Ctx, i: { addressId: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'partner.edit', ANY);
  const a = (await ctx.db.query('DELETE FROM partner_address WHERE id=$1 RETURNING *', [i.addressId])).rows[0];
  if (!a) throw notFound('Address');
  if (a.is_default) await ctx.db.query(`UPDATE partner_address SET is_default=true WHERE id=(SELECT id FROM partner_address WHERE partner_id=$1 AND kind=$2 ORDER BY created_at LIMIT 1)`, [a.partner_id, a.kind]);
  await audit(ctx, { action: 'partner.address.remove', entityType: 'partner', entityId: a.partner_id, before: a });
}

export async function suspendParty(ctx: Ctx, i: { partnerId: string; expectedVersion: number; reason: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'partner.suspend', ANY);
  const p = (await ctx.db.query('SELECT * FROM partner WHERE id=$1 FOR UPDATE', [i.partnerId])).rows[0];
  if (!p) throw notFound('Party');
  if (p.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, p.version);
  if (p.status !== 'active') throw invalidState(`Only active parties can be suspended (this one is ${p.status})`);
  if (!i.reason?.trim()) throw badRequest('Say why');
  const r = await ctx.db.query(`UPDATE partner SET status='suspended', version=version+1 WHERE id=$1 RETURNING *`, [i.partnerId]);
  await audit(ctx, { action: 'partner.suspend', entityType: 'partner', entityId: p.id, before: { status: p.status }, after: { status: 'suspended' }, reason: i.reason });
  return r.rows[0];
}
export async function reactivateParty(ctx: Ctx, i: { partnerId: string; expectedVersion: number }) {
  await assertCan(ctx.db, ctx.actor.id, 'partner.suspend', ANY);
  const p = (await ctx.db.query('SELECT * FROM partner WHERE id=$1 FOR UPDATE', [i.partnerId])).rows[0];
  if (!p) throw notFound('Party');
  if (p.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, p.version);
  if (p.status !== 'suspended') throw invalidState(`Party is ${p.status}, not suspended`);
  const r = await ctx.db.query(`UPDATE partner SET status='active', version=version+1 WHERE id=$1 RETURNING *`, [i.partnerId]);
  await audit(ctx, { action: 'partner.reactivate', entityType: 'partner', entityId: p.id, before: { status: 'suspended' }, after: { status: 'active' } });
  return r.rows[0];
}

export async function listParties(db: Db, userId: string, f: { role: 'vendor' | 'customer'; q?: string; status?: string }) {
  if (!(await can(db, userId, 'partner.view', ANY)) && !(f.role === 'customer' && await can(db, userId, 'so.view', ANY))) return null;
  const q = f.q?.trim() ? `%${f.q.trim().toLowerCase()}%` : null;
  return (await db.query(
    `SELECT p.id, p.code, p.name, p.status, p.version, p.gstin, p.city, p.state, p.phone, p.email, p.payment_days, p.is_vendor, p.is_customer,
            (SELECT name FROM partner_contact c WHERE c.partner_id=p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS contact,
            (SELECT count(*) FROM purchase_order o WHERE o.partner_id=p.id)::int AS pos,
            COALESCE((SELECT sum(total) FROM purchase_order o WHERE o.partner_id=p.id AND o.status NOT IN ('draft','cancelled')),0)::text AS po_value,
            (SELECT count(*) FROM sales_order s WHERE s.customer_id=p.id)::int AS orders,
            COALESCE((SELECT sum(total) FROM sales_order s WHERE s.customer_id=p.id AND s.status NOT IN ('draft','cancelled')),0)::text AS order_value
       FROM partner p
      WHERE ${f.role === 'vendor' ? 'p.is_vendor' : 'p.is_customer'}
        AND ($1::text IS NULL OR lower(p.name) LIKE $1 OR lower(p.code) LIKE $1 OR lower(COALESCE(p.gstin,'')) LIKE $1 OR lower(COALESCE(p.city,'')) LIKE $1)
        AND ($2::text IS NULL OR p.status=$2) ORDER BY p.name`, [q, f.status || null])).rows;
}

export async function getParty(db: Db, userId: string, id: string) {
  const p = await (await import('./masters.js')).getPartner(db, userId, id).catch(() => null);
  if (!p) return null;
  const contacts = (await db.query('SELECT * FROM partner_contact WHERE partner_id=$1 ORDER BY is_primary DESC, created_at', [id])).rows;
  const addresses = (await db.query('SELECT * FROM partner_address WHERE partner_id=$1 ORDER BY kind, is_default DESC, created_at', [id])).rows;
  const rates = (await db.query(
    `SELECT r.id, r.rate::text, r.unit, r.min_qty::text, r.effective_from, r.effective_to, r.status, r.proposed_by, i.code AS item_code, i.name AS item_name
       FROM rate r JOIN item i ON i.id=r.item_id WHERE r.partner_id=$1 ORDER BY i.code, r.effective_from DESC`, [id])).rows;
  const pos = (await db.query(`SELECT id, number, status, total::text, created_at FROM purchase_order WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 8`, [id])).rows;
  const orders = (await db.query(`SELECT id, number, status, total::text, created_at FROM sales_order WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 8`, [id])).rows;
  const terms = (await db.query('SELECT credit_limit::text, payment_days FROM customer_terms WHERE partner_id=$1', [id])).rows[0] ?? null;
  const history = (await db.query(`SELECT a.at, a.action, a.reason, u.display_name AS who FROM audit_log a LEFT JOIN app_user u ON u.id=a.actor_id WHERE a.entity_type='partner' AND a.entity_id=$1 ORDER BY a.id DESC LIMIT 12`, [id])).rows;
  const creator = (await db.query('SELECT display_name FROM app_user WHERE id=$1', [p.created_by])).rows[0]?.display_name ?? '';
  return { p, contacts, addresses, rates, pos, orders, terms, history, creator };
}

// ───────────────────────── Bulk add (CSV paste) ─────────────────────────
function parseCsv(text: string): { head: string[]; rows: string[][] } {
  const rows: string[][] = []; let cur: string[] = []; let f = ''; let q = false;
  const s = text.replace(/\r/g, '');
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (q) { if (ch === '"') { if (s[k + 1] === '"') { f += '"'; k++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { cur.push(f.trim()); f = ''; }
    else if (ch === '\n') { cur.push(f.trim()); rows.push(cur); cur = []; f = ''; }
    else f += ch;
  }
  cur.push(f.trim()); rows.push(cur);
  const all = rows.filter((r) => r.some((x) => x));
  if (!all.length) throw badRequest('Nothing to import — paste a header line and at least one row');
  return { head: all[0].map((h) => h.toLowerCase().replace(/\s+/g, '_')), rows: all.slice(1) };
}
export const MATERIAL_CSV = 'type,name,description,hsn,gst,reorder_level,unit';
export const PARTY_CSV = 'role,name,gstin,pan,city,state,phone,email,payment_days,contact_name,contact_phone';

type ImportResult = { created: number; errors: { row: number; message: string }[]; dryRun: boolean };

/** Every row is checked; nothing is saved unless all rows are good (so a bad paste never half-loads). */
export async function importMaterials(ctx: Ctx, csv: string, dryRun = false): Promise<ImportResult> {
  await assertCan(ctx.db, ctx.actor.id, 'item.create', ANY);
  const { head, rows } = parseCsv(csv);
  for (const need of ['type', 'name']) if (!head.includes(need)) throw badRequest(`Header must include "${need}". Expected: ${MATERIAL_CSV} (plus attr_<name> columns)`);
  const types = (await ctx.db.query('SELECT * FROM material_type')).rows;
  const errors: ImportResult['errors'] = []; const seen = new Set<string>(); let created = 0;
  await ctx.db.query('SAVEPOINT imp_all');
  for (let n = 0; n < rows.length; n++) {
    const g = (k: string) => rows[n][head.indexOf(k)] ?? '';
    const t = types.find((x) => x.code.toLowerCase() === g('type').toLowerCase() || x.name.toLowerCase() === g('type').toLowerCase());
    try {
      if (!t) throw badRequest(`Unknown material type "${g('type')}"`);
      const key = t.id + g('name').toLowerCase(); if (seen.has(key)) throw badRequest('Listed twice in this paste'); seen.add(key);
      const attributes: Record<string, unknown> = {};
      head.forEach((h, c) => { if (h.startsWith('attr_') && rows[n][c]) attributes[h.slice(5).replace(/_(.)/g, (_, x) => x.toUpperCase())] = rows[n][c]; });
      await ctx.db.query('SAVEPOINT imp');
      await createMaterial(ctx, { typeId: t.id, name: g('name'), description: g('description'), hsnCode: g('hsn'), gstRate: g('gst'), reorderLevel: g('reorder_level'), unit: g('unit') || undefined, attributes });
      await ctx.db.query(dryRun ? 'ROLLBACK TO SAVEPOINT imp' : 'RELEASE SAVEPOINT imp'); created++;
    } catch (e) { await ctx.db.query('ROLLBACK TO SAVEPOINT imp').catch(() => {}); errors.push({ row: n + 2, message: (e as Error).message }); }
  }
  if (errors.length || dryRun) await ctx.db.query('ROLLBACK TO SAVEPOINT imp_all');
  return { created: errors.length ? 0 : created, errors, dryRun };
}

export async function importParties(ctx: Ctx, csv: string, dryRun = false): Promise<ImportResult> {
  await assertCan(ctx.db, ctx.actor.id, 'partner.create', ANY);
  const { head, rows } = parseCsv(csv);
  for (const need of ['role', 'name']) if (!head.includes(need)) throw badRequest(`Header must include "${need}". Expected: ${PARTY_CSV}`);
  const errors: ImportResult['errors'] = []; let created = 0;
  await ctx.db.query('SAVEPOINT imp_all');
  for (let n = 0; n < rows.length; n++) {
    const g = (k: string) => rows[n][head.indexOf(k)] ?? '';
    try {
      const role = g('role').toLowerCase();
      if (!['vendor', 'customer', 'client', 'both'].includes(role)) throw badRequest(`Role must be vendor, customer or both (got "${g('role')}")`);
      await ctx.db.query('SAVEPOINT imp');
      await createParty(ctx, { name: g('name'), role: role === 'client' ? 'customer' : (role as 'vendor'), gstin: g('gstin'), pan: g('pan'), city: g('city'), state: g('state'), phone: g('phone'), email: g('email'),
        paymentDays: g('payment_days') ? Number(g('payment_days')) : undefined, contact: g('contact_name') ? { name: g('contact_name'), phone: g('contact_phone') } : undefined });
      await ctx.db.query(dryRun ? 'ROLLBACK TO SAVEPOINT imp' : 'RELEASE SAVEPOINT imp'); created++;
    } catch (e) { await ctx.db.query('ROLLBACK TO SAVEPOINT imp').catch(() => {}); errors.push({ row: n + 2, message: (e as Error).message }); }
  }
  if (errors.length || dryRun) await ctx.db.query('ROLLBACK TO SAVEPOINT imp_all');
  return { created: errors.length ? 0 : created, errors, dryRun };
}
