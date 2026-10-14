import type { Pool } from '../db/pool.js';

/**
 * Role → permission catalogue for the foundation + stock-core slice.
 * Permission keys follow the blueprint (§08): <area>.<action>. A trailing "~" marks an approval-banded key.
 * Separation of duties is enforced in code on top of this (creator ≠ approver).
 */
export const ROLES: Record<string, { description: string; perms: string[] }> = {
  ADM: { description: 'System / access administrator (no business approval power)',
         perms: ['user.manage', 'access.assign', 'site.provision', 'audit.view'] },
  MD: { description: 'Master-data steward / managing director',
        perms: ['org.create', 'org.edit', 'unit.create', 'item.create', 'item.edit', 'item.submit', 'item.view',
                'partner.create', 'partner.submit', 'partner.view', 'inventory.view', 'po.view'] },
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
        perms: ['org.approve', 'partner.bank.approve', 'partner.bank.view', 'partner.view', 'po.view', 'inventory.view', 'audit.view'] },
  AUD: { description: 'Auditor (read-only)',
         perms: ['audit.view', 'inventory.view', 'po.view', 'item.view', 'partner.view', 'receipt.view', 'qc.view'] },
};

export async function seedRbac(pool: Pool): Promise<void> {
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
