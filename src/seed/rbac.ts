import type { Pool } from '../db/pool.js';

/**
 * Role → permission catalogue for the foundation + stock-core slice.
 * Permission keys follow the blueprint (§08): <area>.<action>. A trailing "~" marks an approval-banded key.
 * Separation of duties is enforced in code on top of this (creator ≠ approver).
 */
export const ROLES: Record<string, { description: string; perms: string[] }> = {
  ADM: { description: 'System / access administrator (no business approval power)',
         perms: ['user.manage', 'user.view', 'access.assign', 'role.manage', 'site.provision', 'audit.view'] },
  MD: { description: 'Master-data steward / managing director',
        perms: ['org.create', 'org.edit', 'unit.create', 'item.create', 'item.edit', 'item.submit', 'item.view',
                'partner.create', 'partner.submit', 'partner.view', 'inventory.view', 'po.view', 'hr.salary.propose', 'hr.salary.approve', 'escalation.raise', 'escalation.senior', 'escalation.view'] },
  ENG: { description: 'Engineer / technical approver',
         perms: ['item.create', 'item.edit', 'item.submit', 'item.approve', 'item.view', 'inventory.view'] },
  BUY: { description: 'Buyer',
         perms: ['po.create', 'po.edit', 'po.submit', 'po.amend', 'po.view', 'partner.create', 'partner.submit',
                 'partner.view', 'rate.propose', 'item.view', 'inventory.view', 'receipt.view'] },
  COM: { description: 'Commercial approver',
         perms: ['po.approve~', 'po.release~', 'po.cancel~', 'po.view', 'partner.trade.approve', 'partner.view',
                 'rate.approve', 'item.view'] },
  STO: { description: 'Storekeeper',
         perms: ['receipt.post', 'receipt.view', 'putaway.execute', 'reservation.allocate', 'inventory.view',
                 'item.view', 'po.view', 'qc.view'] },
  INV: { description: 'Inventory controller',
         perms: ['receipt.exception.approve', 'adjustment.propose', 'adjustment.approve~', 'adjustment.post',
                 'reservation.allocate', 'reservation.override.approve', 'location.configure', 'inventory.view',
                 'receipt.view', 'qc.view', 'item.view', 'po.view'] },
  QCI: { description: 'Quality inspector',
         perms: ['qc.inspect', 'qc.submit', 'qc.view', 'receipt.view', 'inventory.view', 'item.view'] },
  QCM: { description: 'Quality manager',
         perms: ['qc.inspect', 'qc.submit', 'qc.release', 'qc.reject', 'qc.view', 'receipt.view', 'inventory.view', 'item.view'] },
  PPC: { description: 'Production planner',
         perms: ['reservation.allocate', 'inventory.view', 'item.view', 'po.view'] },
  FC: { description: 'Finance controller',
        perms: ['hr.salary.approve', 'hr.salary.view', 'hr.payroll.approve', 'hr.payroll.view', 'hr.employee.view', 'hr.bank.view', 'escalation.raise', 'escalation.senior', 'escalation.view', 'org.approve', 'partner.bank.approve', 'partner.bank.view', 'partner.view', 'po.view', 'inventory.view', 'audit.view'] },
  AUD: { description: 'Auditor (read-only)',
         perms: ['audit.view', 'user.view', 'hr.employee.view', 'hr.attendance.view', 'hr.leave.view', 'inventory.view', 'po.view', 'item.view', 'partner.view', 'receipt.view', 'qc.view'] },
  HRM: { description: 'HR manager',
         perms: ['hr.org.manage', 'hr.employee.view', 'hr.employee.create', 'hr.employee.edit', 'hr.employee.exit', 'hr.bank.view',
                 'hr.attendance.view', 'hr.attendance.mark', 'hr.attendance.correct', 'hr.shift.manage',
                 'hr.leave.view', 'hr.leave.approve', 'hr.leave.approve.any', 'hr.leave.grant',
                 'hr.salary.propose', 'hr.salary.view', 'hr.payroll.create', 'hr.payroll.view'] },
  HRE: { description: 'HR executive (no salary access)',
         perms: ['hr.employee.view', 'hr.employee.create', 'hr.employee.edit', 'hr.attendance.view', 'hr.attendance.mark', 'hr.leave.view'] },
  OWN: { description: 'Business owner (sees everything, can override approvals)',
         perms: ['owner.view', 'owner.override', 'escalation.raise', 'escalation.senior', 'escalation.view', 'audit.view', 'user.view',
                 'inventory.view', 'po.view', 'item.view', 'partner.view', 'receipt.view', 'qc.view',
                 'hr.employee.view', 'hr.attendance.view', 'hr.leave.view', 'hr.payroll.view', 'hr.salary.view'] },
  SUP: { description: 'Line supervisor (own team)',
         perms: ['hr.employee.view', 'hr.attendance.view', 'hr.attendance.mark', 'hr.leave.view', 'hr.leave.approve'] },
};

/** Everyone who works in the business can raise an urgent-approval escalation and follow the ones they raised. */
for (const [k, def] of Object.entries(ROLES)) {
  if (k === 'ADM' || k === 'AUD') continue;
  for (const p of ['escalation.raise', 'escalation.view']) if (!def.perms.includes(p)) def.perms.push(p);
}

/** Display name for a permission key's area, used by the admin console. */
export const AREAS: Record<string, string> = {
  user: 'Users', access: 'Access', role: 'Roles', site: 'Sites', audit: 'Audit', org: 'Organisation', unit: 'Units', item: 'Items',
  partner: 'Partners', rate: 'Rates', po: 'Purchase orders', receipt: 'Receiving', qc: 'Quality', putaway: 'Putaway',
  owner: 'Owner', escalation: 'Escalations', reservation: 'Reservations', adjustment: 'Adjustments', location: 'Locations', inventory: 'Inventory', hr: 'HR & payroll',
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
