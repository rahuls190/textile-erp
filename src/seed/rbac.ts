import type { Pool } from '../db/pool.js';

/**
 * Role → permission catalogue for the foundation + stock-core slice.
 * Permission keys follow the blueprint (§08): <area>.<action>. A trailing "~" marks an approval-banded key.
 * Separation of duties is enforced in code on top of this (creator ≠ approver).
 */
export const ROLES: Record<string, { description: string; perms: string[] }> = {
  ADM: { description: 'System / access administrator (no business approval power)',
         perms: ['user.manage', 'user.view', 'access.assign', 'role.manage', 'site.provision', 'audit.view', 'ai.manage', 'barcode.view', 'barcode.layout', 'barcode.series'] },
  PLN: { description: 'Production planner: plans six months ahead and raises purchase requests',
         perms: ['plan.view', 'plan.manage', 'bom.view', 'item.view', 'inventory.view', 'partner.view', 'po.view', 'production.view', 'production.create'] },
  MD: { description: 'Master-data steward / managing director',
        perms: ['org.create', 'org.edit', 'unit.create', 'item.create', 'item.edit', 'item.submit', 'item.view',
                'partner.create', 'partner.submit', 'partner.view', 'partner.edit', 'mtype.manage', 'bom.view', 'plan.view', 'bom.create', 'barcode.view', 'barcode.issue', 'barcode.print', 'barcode.layout', 'barcode.series', 'inventory.view', 'po.view', 'hr.salary.propose', 'hr.salary.approve', 'escalation.raise', 'escalation.senior', 'escalation.view'] },
  ENG: { description: 'Engineer / technical approver',
         perms: ['item.create', 'item.edit', 'item.submit', 'item.approve', 'item.deactivate', 'item.view', 'inventory.view', 'partner.view', 'bom.view', 'plan.view', 'bom.approve'] },
  BUY: { description: 'Buyer',
         perms: ['bom.view', 'plan.view', 'po.create', 'po.edit', 'po.submit', 'po.amend', 'po.view', 'partner.create', 'partner.submit',
                 'partner.view', 'partner.edit', 'rate.propose', 'item.view', 'inventory.view', 'receipt.view'] },
  COM: { description: 'Commercial approver',
         perms: ['po.approve~', 'po.release~', 'po.cancel~', 'po.view', 'partner.trade.approve', 'partner.view', 'partner.suspend',
                 'rate.approve', 'item.view'] },
  STO: { description: 'Storekeeper',
         perms: ['bom.view', 'plan.view', 'receipt.post', 'receipt.view', 'putaway.execute', 'reservation.allocate', 'inventory.view', 'barcode.view', 'barcode.issue', 'barcode.print',
                 'item.view', 'po.view', 'qc.view', 'dispatch.post', 'so.view', 'production.view', 'production.issue', 'production.complete'] },
  INV: { description: 'Inventory controller',
         perms: ['bom.view', 'receipt.exception.approve', 'adjustment.propose', 'adjustment.approve~', 'adjustment.post', 'barcode.view', 'barcode.issue', 'barcode.print', 'barcode.void',
                 'reservation.allocate', 'reservation.override.approve', 'location.configure', 'inventory.view',
                 'receipt.view', 'qc.view', 'item.view', 'po.view'] },
  QCI: { description: 'Quality inspector',
         perms: ['qc.inspect', 'qc.submit', 'qc.view', 'receipt.view', 'inventory.view', 'item.view'] },
  QCM: { description: 'Quality manager',
         perms: ['qc.inspect', 'qc.submit', 'qc.release', 'qc.reject', 'qc.view', 'receipt.view', 'inventory.view', 'item.view'] },
  PPC: { description: 'Production planner',
         perms: ['reservation.allocate', 'inventory.view', 'item.view', 'po.view'] },
  FC: { description: 'Finance controller',
        perms: ['hr.salary.approve', 'hr.salary.view', 'hr.payroll.approve', 'hr.payroll.view', 'hr.employee.view', 'hr.bank.view', 'escalation.raise', 'escalation.senior', 'escalation.view', 'org.approve', 'partner.bank.approve', 'partner.bank.view', 'partner.view', 'po.view', 'inventory.view', 'audit.view', 'so.view', 'sales.view', 'crm.view'] },
  AUD: { description: 'Auditor (read-only)',
         perms: ['audit.view', 'user.view', 'hr.employee.view', 'hr.attendance.view', 'hr.leave.view', 'inventory.view', 'po.view', 'item.view', 'partner.view', 'receipt.view', 'qc.view', 'so.view', 'crm.view', 'sales.view'] },
  HRM: { description: 'HR manager',
         perms: ['hr.org.manage', 'hr.employee.view', 'hr.employee.create', 'hr.employee.edit', 'hr.employee.exit', 'hr.bank.view',
                 'hr.attendance.view', 'hr.attendance.mark', 'hr.attendance.correct', 'hr.shift.manage',
                 'hr.leave.view', 'hr.leave.approve', 'hr.leave.approve.any', 'hr.leave.grant',
                 'hr.salary.propose', 'hr.salary.view', 'hr.payroll.create', 'hr.payroll.view'] },
  HRE: { description: 'HR executive (no salary access)',
         perms: ['hr.employee.view', 'hr.employee.create', 'hr.employee.edit', 'hr.attendance.view', 'hr.attendance.mark', 'hr.leave.view'] },
  OWN: { description: 'Business owner (sees everything, can override approvals)',
         perms: ['ai.manage', 'bom.view', 'plan.view', 'production.view', 'barcode.view', 'owner.view', 'owner.override', 'escalation.raise', 'escalation.senior', 'escalation.view', 'audit.view', 'user.view',
                 'inventory.view', 'po.view', 'item.view', 'partner.view', 'receipt.view', 'qc.view',
                 'hr.employee.view', 'hr.attendance.view', 'hr.leave.view', 'hr.payroll.view', 'hr.salary.view', 'crm.view', 'sales.view', 'so.view'] },
  SAL: { description: 'Sales executive',
         perms: ['bom.view', 'plan.view', 'crm.view', 'crm.manage', 'sales.view', 'partner.create', 'partner.submit', 'partner.view', 'partner.edit', 'quote.create', 'quote.send', 'so.create', 'so.submit', 'so.view', 'item.view', 'inventory.view'] },
  SLM: { description: 'Sales manager',
         perms: ['crm.view', 'crm.manage', 'sales.view', 'partner.view', 'quote.create', 'quote.send', 'quote.discount.over', 'so.create', 'so.submit', 'so.view', 'so.approve~', 'so.cancel', 'customer.terms', 'item.view', 'inventory.view', 'reservation.allocate'] },
  SUP: { description: 'Line supervisor (own team)',
         perms: ['hr.employee.view', 'hr.attendance.view', 'hr.attendance.mark', 'hr.leave.view', 'hr.leave.approve'] },
};

/** Everyone who works in the business can raise an urgent-approval escalation and follow the ones they raised. */
for (const [k, def] of Object.entries(ROLES)) {
  if (k === 'ADM' || k === 'AUD') continue;
  for (const p of ['escalation.raise', 'escalation.view', 'ai.use']) if (!def.perms.includes(p)) def.perms.push(p);
}

/** Display name for a permission key's area, used by the admin console. */
export const AREAS: Record<string, string> = {
  user: 'Users', access: 'Access', role: 'Roles', site: 'Sites', audit: 'Audit', org: 'Organisation', unit: 'Units', item: 'Items',
  partner: 'Vendors & clients', mtype: 'Material types', rate: 'Rates', po: 'Purchase orders', receipt: 'Receiving', qc: 'Quality', putaway: 'Putaway',
  owner: 'Owner', plan: 'Production planning', production: 'Production', bom: 'Products & BOM', barcode: 'Barcodes & labels', ai: 'AI models & assistant', crm: 'CRM', sales: 'Sales', quote: 'Quotations', so: 'Sales orders', customer: 'Customers', dispatch: 'Dispatch', escalation: 'Escalations', reservation: 'Reservations', adjustment: 'Adjustments', location: 'Locations', inventory: 'Inventory', hr: 'HR & payroll',
};

/** Every known permission, derived from the role catalogue (plus anything the console adds later). */
export function permissionCatalogue(): { key: string; area: string; label: string; bandable: boolean }[] {
  const seen = new Map<string, boolean>();
  for (const def of Object.values(ROLES)) for (const p of def.perms) seen.set(p.replace('~', ''), p.endsWith('~') || (seen.get(p.replace('~', '')) ?? false));
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, bandable]) => {
    const [area, ...rest] = key.split('.');
    return { key, area: AREAS[area] ?? area, label: rest.join(' ').replace(/\./g, ' '), bandable };
  });
}

export async function seedRbac(pool: Pool): Promise<void> {
  for (const p of permissionCatalogue())
    await pool.query(`INSERT INTO permission_def(key, area, label, bandable) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO UPDATE SET area=EXCLUDED.area, label=EXCLUDED.label, bandable=EXCLUDED.bandable`, [p.key, p.area, p.label, p.bandable]);
  for (const [key, def] of Object.entries(ROLES)) {
    await pool.query(
      `INSERT INTO role(key, description) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET description=EXCLUDED.description`,
      [key, def.description]);
    for (const p of def.perms) {
      const banded = p.endsWith('~');
      await pool.query(
        `INSERT INTO role_permission(role_key, permission, banded) VALUES ($1,$2,$3)
         ON CONFLICT (role_key, permission) DO UPDATE SET banded=EXCLUDED.banded`,
        [key, banded ? p.slice(0, -1) : p, banded]);
    }
  }
}
