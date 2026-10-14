import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshWorld, rejects } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as prefs from '../src/domain/prefs.js';

describe('per-user appearance settings', () => {
  let w: World;
  beforeAll(async () => { w = await freshWorld('prefs'); });
  afterAll(async () => { await w.pool.end(); });

  it('defaults, saves per user, and does not leak between users', async () => {
    expect(await prefs.getPreferences(w.pool, w.actors.admin.id)).toEqual(prefs.DEFAULT_PREFS);
    await w.as('admin', (c) => prefs.setPreferences(c, { theme: 'dark', accent: 'ocean', layout: 'topbar' }));
    await w.as('buy', (c) => prefs.setPreferences(c, { density: 'compact' }));
    const a = await prefs.getPreferences(w.pool, w.actors.admin.id), b = await prefs.getPreferences(w.pool, w.actors.buy.id);
    expect(a).toMatchObject({ theme: 'dark', accent: 'ocean', layout: 'topbar', density: 'comfortable' });
    expect(b).toMatchObject({ theme: 'system', accent: 'kalyani', density: 'compact' });
  });
  it('refuses unknown settings or values, and can reset', async () => {
    await rejects(w.as('admin', (c) => prefs.setPreferences(c, { theme: 'neon' } as never)), 'BAD_REQUEST');
    await rejects(w.as('admin', (c) => prefs.setPreferences(c, { fontSize: 'big' } as never)), 'BAD_REQUEST');
    await w.as('admin', (c) => prefs.setPreferences(c, { reset: true }));
    expect(await prefs.getPreferences(w.pool, w.actors.admin.id)).toEqual(prefs.DEFAULT_PREFS);
  });
});
