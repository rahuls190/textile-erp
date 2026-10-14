import { html, raw, when, chip, type Raw } from './lib.js';
import { K, S, uid, read, val, act, head, kv, denied, toast, R, todayIso, addDays } from './ctx.js';
import * as admin from '../src/domain/admin.js';
import * as q from '../src/domain/queries.js';
import { can } from '../src/core/permissions.js';
import { changeOwnPassword } from '../src/core/auth.js';

// ───────────── Users ─────────────
type Grant = { id: string; role_key: string; site: string | null; max_amount: string | null; valid_until: string | null };
export async function usersView(): Promise<Raw> {
  const d = await read(async (db) => {
    const users = await admin.listUsers(db, uid());
    if (!users) return null;
    return {
      users, roles: await admin.listRoles(db),
      sites: (await db.query('SELECT id, code, name FROM site ORDER BY code')).rows as { id: string; code: string; name: string }[],
      mgr: await can(db, uid(), 'user.manage', { anySite: true }), asg: await can(db, uid(), 'access.assign', { anySite: true }),
    };
  });
  if (!d) return denied('Users', 'Who can sign in, and what they hold.', 'Your role cannot see the user list. Sign in as the System administrator or the Auditor.');
  const sel = d.users.find((u) => u.id === S.userSel);
  const status = (u: (typeof d.users)[number]) => !u.active ? chip('suspended') : u.locked ? chip('locked', 'locked out') : u.must_change_password ? chip('proposed', 'must change password') : chip('active');
  const form = S.open.has('newuser') ? html`
    <form class="card form" data-form="newuser"><h2>New user</h2>
      <label>Username<input id="nu-name" placeholder="e.g. rekha" autocomplete="off" /></label>
      <label>Full name<input id="nu-full" /></label>
      <label>Temporary password<input id="nu-pw" value="Temp-${Math.floor(Math.random() * 9000 + 1000)}-Pass" autocomplete="off" /></label>
      <p class="note">They must replace this at first sign-in. A new user holds no role and can see nothing until one is assigned.</p>
      <div class="row"><button class="primary" type="submit">Create user</button><button type="button" data-act="toggle-newuser">Close</button></div></form>` : html``;
  const detail = !sel ? html`<p class="empty">Select a person to see their access and actions.</p>` : html`
    <div class="dh"><h2>${sel.display_name}</h2>${status(sel)}</div>
    ${kv('Username', raw(`<span class="mono">${sel.username}</span>`))}${kv('Last sign-in', sel.last_login_at ? when(sel.last_login_at) : 'never')}${kv('Open sessions', sel.sessions)}
    <h3>Roles held</h3>
    ${sel.grants.length ? html`<ul class="plain">${(sel.grants as Grant[]).map((g) => html`<li><b>${g.role_key}</b> · ${g.site ?? 'all sites'}${g.max_amount ? ` · limit ${Number(g.max_amount).toLocaleString('en-IN')}` : ''}${g.valid_until ? ` · until ${String(g.valid_until).slice(0, 10)}` : ''}
      ${d.asg ? html`<button class="link" data-act="u-revoke" data-id="${g.id}">revoke</button>` : ''}</li>`)}</ul>` : html`<p class="empty">No roles. This person can sign in but sees nothing.</p>`}
    ${d.asg ? html`<form class="form" data-form="assign"><h3>Assign a role</h3>
      <label>Role<select id="as-role">${d.roles.map((r) => html`<option value="${r.key}">${r.key} · ${r.description}</option>`)}</select></label>
      <label>Where<select id="as-site"><option value="">All sites (company-wide)</option>${d.sites.map((s) => html`<option value="${s.id}" ${s.code === 'KLY' ? raw('selected') : ''}>${s.code} · ${s.name}</option>`)}</select></label>
      <label>Approval limit (₹ or metres, only for roles that approve)<input id="as-limit" inputmode="decimal" placeholder="none" /></label>
      <label>Valid until (optional)<input id="as-until" type="date" min="${addDays(todayIso(), 1)}" /></label>
      <button type="submit">Assign</button></form>` : ''}
    ${d.mgr ? html`<h3>Account actions</h3>
      <label class="stack">Reason (needed to suspend or reactivate)<input id="u-reason" placeholder="e.g. left the company" /></label>
      <div class="row">${sel.active ? html`<button data-act="u-suspend">Suspend</button>` : html`<button data-act="u-react">Reactivate</button>`}${sel.locked ? html`<button data-act="u-unlock">Unlock</button>` : ''}</div>
      <label class="stack">Temporary password<input id="u-temp" value="Temp-${Math.floor(Math.random() * 9000 + 1000)}-Pass" autocomplete="off" /></label>
      <div class="row"><button data-act="u-reset">Reset password</button></div>
      <p class="note">A reset ends all their sessions and forces a new password at next sign-in. You cannot change your own access or suspend yourself.</p>` : ''}`;
  return html`
  ${head('Users', 'Create people, give them roles at a site with limits and an end date, and suspend them instantly. Everything here is recorded in the audit trail.', d.mgr ? html`<button class="primary" data-act="toggle-newuser">New user</button>` : undefined)}
  ${form}
  <section class="split">
    <div class="card flush"><div class="tablewrap"><table>
      <thead><tr><th>Person</th><th>Status</th><th>Roles</th><th>Last sign-in</th></tr></thead>
      <tbody>${d.users.map((u) => html`<tr class="pick ${u.id === S.userSel ? 'on' : ''}" data-pick-user="${u.id}" tabindex="0"><td><b>${u.display_name}</b><br><span class="mono muted">${u.username}</span></td><td>${status(u)}</td>
        <td>${u.grants.length ? (u.grants as Grant[]).map((g) => html`<span class="tag">${g.role_key}</span> `) : html`<span class="muted">none</span>`}</td><td class="muted">${u.last_login_at ? when(u.last_login_at) : 'never'}</td></tr>`)}</tbody>
    </table></div></div>
    <aside class="card detail">${detail}</aside>
  </section>`;
}

// ───────────── Roles & permissions ─────────────
export async function rolesView(): Promise<Raw> {
  const d = await read(async (db) => ({
    roles: await admin.listRoles(db), cat: await admin.permissionCatalogueRows(db),
    edit: await can(db, uid(), 'role.manage', { anySite: true }),
  }));
  const role = d.roles.find((r) => r.key === S.roleSel) ?? d.roles[0];
  if (S.roleSel !== role.key) { S.roleSel = role.key; S.roleDraft = null; }
  const saved = new Set(role.permissions);
  const draft = S.roleDraft ?? saved;
  const locked = !d.edit || role.key === 'ADM';
  const added = [...draft].filter((p) => !saved.has(p)), removed = [...saved].filter((p) => !draft.has(p));
  const areas = [...new Set(d.cat.map((p) => p.area))];
  const form = S.open.has('newrole') ? html`
    <form class="card form" data-form="newrole"><h2>New role</h2>
      <label>Key (capital letters)<input id="nr-key" placeholder="e.g. GATE" autocomplete="off" /></label>
      <label>What is it for?<input id="nr-desc" placeholder="e.g. Gate clerk" /></label>
      <p class="note">The role starts with the permissions of the one currently selected, so you only tick the differences.</p>
      <div class="row"><button class="primary" type="submit">Create role</button><button type="button" data-act="toggle-newrole">Close</button></div></form>` : html``;
  return html`
  ${head('Roles & permissions', 'A role is a named set of permissions. Tick or untick, give a reason, save: it applies to everyone holding that role at once. Business approvals stay with business roles.', d.edit ? html`<button class="primary" data-act="toggle-newrole">New role</button>` : undefined)}
  ${form}
  <section class="split rolesplit">
    <div class="card flush"><div class="tablewrap"><table>
      <thead><tr><th>Role</th><th class="r">Permissions</th><th class="r">Holders</th></tr></thead>
      <tbody>${d.roles.map((r) => html`<tr class="pick ${r.key === role.key ? 'on' : ''}" data-pick-role="${r.key}" tabindex="0"><td><b>${r.key}</b>${r.is_system ? '' : html` <span class="chip info">custom</span>`}<br><small>${r.description}</small></td><td class="r num">${r.permissions.length}</td><td class="r num">${r.holders}</td></tr>`)}</tbody>
    </table></div></div>
    <aside class="card detail wide">
      <div class="dh"><h2>${role.key}</h2><span class="muted">${role.holders} holder${role.holders === 1 ? '' : 's'}</span></div>
      <p class="sub">${role.description}</p>
      ${role.key === 'ADM' ? html`<p class="note">The administrator role is fixed so the system can never be locked out. It carries no business approvals by design.</p>` : !d.edit ? html`<p class="note">You can read roles but not change them. Sign in as the System administrator to edit.</p>` : ''}
      ${areas.map((a) => html`<fieldset><legend>${a}</legend><div class="checks">${d.cat.filter((p) => p.area === a).map((p) => html`
        <label class="check ${draft.has(p.key) ? 'on' : ''}"><input type="checkbox" data-perm="${p.key}" ${draft.has(p.key) ? raw('checked') : ''} ${locked ? raw('disabled') : ''}><span>${p.label}${p.bandable ? html` <em>limit</em>` : ''}<small class="mono">${p.key}</small></span></label>`)}</div></fieldset>`)}
      ${!locked ? html`<div class="savebar"><span>${added.length || removed.length ? html`<b>${added.length}</b> to add, <b>${removed.length}</b> to remove` : 'No changes'}</span>
        <input id="role-reason" placeholder="Reason for this change" aria-label="Reason" />
        <button class="primary" data-act="role-save" ${added.length || removed.length ? '' : raw('disabled')}>Save</button>
        ${role.is_system ? '' : html`<button data-act="role-delete">Delete role</button>`}</div>` : ''}
    </aside>
  </section>`;
}

// ───────────── Sign-in log ─────────────
export async function signinsView(): Promise<Raw> {
  const rows = await read((db) => admin.listLoginEvents(db, uid(), 100));
  if (!rows) return denied('Sign-in log', 'Every sign-in attempt.', 'Your role cannot read the sign-in log.');
  return html`
  ${head('Sign-in log', 'Every attempt, successful or not. Five wrong passwords in a row lock the account for 15 minutes until an administrator unlocks it.')}
  <div class="card flush"><div class="tablewrap"><table><thead><tr><th>When</th><th>Username</th><th>Result</th><th>Detail</th></tr></thead>
  <tbody>${rows.length ? rows.map((r) => html`<tr><td>${when(r.at)}</td><td class="mono">${r.username}</td><td>${r.ok ? chip('active', 'signed in') : chip('suspended', 'refused')}</td><td class="muted">${r.reason ?? ''}</td></tr>`) : html`<tr><td colspan="4" class="empty">No attempts yet.</td></tr>`}</tbody></table></div></div>`;
}

// ───────────── My account ─────────────
export async function accountView(): Promise<Raw> {
  const d = await read(async (db) => ({ access: await q.myAccess(db, uid()), me: (await db.query('SELECT username, display_name, last_login_at FROM app_user WHERE id=$1', [uid()])).rows[0] }));
  return html`
  ${head('My account', S.mustChange ? 'You are signing in with a temporary password. Choose your own to continue.' : 'Your sign-in and what you are allowed to do.')}
  <section class="cols">
    <form class="card form" data-form="password"><h2>Change password</h2>
      <label>Current password<input id="pw-cur" type="password" autocomplete="current-password" /></label>
      <label>New password (10+ characters, letters and a digit)<input id="pw-new" type="password" autocomplete="new-password" /></label>
      <label>New password again<input id="pw-new2" type="password" autocomplete="new-password" /></label>
      <p class="note">Changing it signs you out everywhere else. In this demo every account starts with the password shown on the sign-in page.</p>
      <button class="primary" type="submit">Change password</button></form>
    <div class="card"><h2>${d.me.display_name}</h2><p class="sub">${d.me.username} · last sign-in ${d.me.last_login_at ? when(d.me.last_login_at) : 'first time'}</p>
      <h3>What I hold</h3>${d.access.length ? html`<ul class="plain">${d.access.map((a) => html`<li><b>${a.role}</b> · ${a.site ?? 'all sites'}${a.max_amount ? ` · limit ${Number(a.max_amount).toLocaleString('en-IN')}` : ''}${a.valid_until ? ` · until ${String(a.valid_until).slice(0, 10)}` : ''}</li>`)}</ul>` : html`<p class="empty">No roles. You can sign in, and see only your own HR record.</p>`}</div>
  </section>`;
}

// ───────────── events ─────────────
const tempPw = () => val('u-temp');
export async function onClick(t: HTMLElement): Promise<boolean> {
  const pu = (t.closest('[data-pick-user]') as HTMLElement | null)?.dataset.pickUser; if (pu) { S.userSel = pu; await R.render(); return true; }
  const pr = (t.closest('[data-pick-role]') as HTMLElement | null)?.dataset.pickRole; if (pr) { S.roleSel = pr; S.roleDraft = null; await R.render(); return true; }
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b) return false;
  const a = b.dataset.act!, id = b.dataset.id ?? '';
  switch (a) {
    case 'toggle-newuser': S.open.has('newuser') ? S.open.delete('newuser') : S.open.add('newuser'); await R.render(); return true;
    case 'toggle-newrole': S.open.has('newrole') ? S.open.delete('newrole') : S.open.add('newrole'); await R.render(); return true;
    case 'u-suspend': await act('Account suspended. Sessions ended', (c) => admin.suspendUser(c, { userId: S.userSel, reason: val('u-reason') })); return true;
    case 'u-react': await act('Account reactivated', (c) => admin.reactivateUser(c, { userId: S.userSel, reason: val('u-reason') })); return true;
    case 'u-unlock': await act('Account unlocked', (c) => admin.unlockUser(c, { userId: S.userSel })); return true;
    case 'u-reset': await act('Password reset. They must choose a new one at next sign-in', (c) => admin.resetPassword(c, { userId: S.userSel, temporaryPassword: tempPw() })); return true;
    case 'u-revoke': await act('Role revoked', (c) => admin.revokeRole(c, { userRoleId: id, reason: val('u-reason') || 'Revoked from the users screen' })); return true;
    case 'role-save': {
      const role = S.roleSel, perms = [...(S.roleDraft ?? [])];
      const r = await act('Role saved. It applies to everyone holding it, immediately', (c) => admin.setRolePermissions(c, { roleKey: role, permissions: perms, reason: val('role-reason') }));
      if (r) { S.roleDraft = null; await R.render(); }
      return true;
    }
    case 'role-delete': { const k = S.roleSel; const r = await act('Role deleted', (c) => admin.deleteRole(c, { roleKey: k })); if (r) { S.roleSel = ''; S.roleDraft = null; await R.render(); } return true; }
  }
  return false;
}

export async function onSubmit(form: string): Promise<boolean> {
  switch (form) {
    case 'newuser': {
      const r = await act('User created. They hold no role yet', (c) => admin.createUser(c, { username: val('nu-name'), displayName: val('nu-full'), password: val('nu-pw'), mustChangePassword: true }));
      if (r) { S.open.delete('newuser'); S.userSel = (r as { id: string }).id; K.world.actors[(r as { username: string }).username] = { id: (r as { id: string }).id, username: (r as { username: string }).username }; await R.render(); }
      return true;
    }
    case 'assign': {
      const f = { userId: S.userSel, roleKey: val('as-role'), siteId: val('as-site') || null, maxAmount: val('as-limit') || null, validUntil: val('as-until') || null };
      await act('Role assigned', (c) => admin.assignRole(c, f)); return true;
    }
    case 'newrole': {
      const base = (await read((db) => admin.listRoles(db))).find((r) => r.key === S.roleSel);
      const key = val('nr-key').toUpperCase();
      const r = await act('Role created', (c) => admin.createRole(c, { key, description: val('nr-desc'), permissions: base?.permissions ?? [] }));
      if (r) { S.open.delete('newrole'); S.roleSel = key; S.roleDraft = null; await R.render(); }
      return true;
    }
    case 'password': {
      if (val('pw-new') !== val('pw-new2')) { toast('The two new passwords differ', 'bad'); return true; }
      try {
        await read((db) => changeOwnPassword(db, uid(), val('pw-cur'), val('pw-new'), S.token));
        S.mustChange = false; toast('Password changed. Other sessions were signed out'); await R.render();
      } catch (e) { toast((e as Error).message, 'bad'); }
      return true;
    }
  }
  return false;
}

export async function togglePerm(key: string) {
  if (!S.roleDraft) S.roleDraft = new Set((await read((db) => admin.listRoles(db))).find((r) => r.key === S.roleSel)?.permissions ?? []);
  S.roleDraft.has(key) ? S.roleDraft.delete(key) : S.roleDraft.add(key);
  await R.render();
}
