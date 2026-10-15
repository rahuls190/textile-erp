import type { Pool } from '../db/pool.js';
import { runCommand } from '../core/command.js';
import * as plan from '../domain/planning.js';

/** Runs the plan once per calendar day as the named planner. Safe to call as often as you like: the second call on the same day is a replay and changes nothing. */
export async function runDailyPlan(pool: Pool, username: string, withinDays = 30) {
  const u = (await pool.query('SELECT id, username FROM app_user WHERE username=$1 AND active', [username])).rows[0];
  if (!u) throw new Error(`Daily plan: no active user "${username}"`);
  const day = (await pool.query('SELECT CURRENT_DATE::text AS d')).rows[0].d as string;
  return runCommand(pool, { requestId: `daily-plan-${day}-${u.id}`, actor: { id: u.id, username: u.username }, action: 'plan.daily' }, (c) => plan.runPlan(c, { withinDays }));
}

/** Checks every 15 minutes; after the chosen hour (server time) it makes sure today's run has happened. */
export function startDailyPlan(pool: Pool, log: { info: (m: string) => void; error: (m: string) => void }) {
  const user = process.env.PLAN_AUTORUN_USER; if (!user) return null;
  const hour = Number(process.env.PLAN_AUTORUN_HOUR ?? 6);
  const tick = async () => {
    if (new Date().getHours() < hour) return;
    try { const r = await runDailyPlan(pool, user); if (!r.replayed) log.info(`Daily plan: ${r.result.requests.length} request(s), ${r.result.cutting.length} cutting order(s)`); }
    catch (e) { log.error(`Daily plan failed: ${(e as Error).message}`); }
  };
  void tick(); return setInterval(tick, 15 * 60 * 1000);
}
