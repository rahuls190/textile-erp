import init from '../../src/db/migrations/001_init.sql';
import adminHr from '../../src/db/migrations/002_admin_hr.sql';
import ownerSql from '../../src/db/migrations/004_owner_escalation.sql';
import customSql from '../../src/db/migrations/005_custom_reports.sql';
import prefsSql from '../../src/db/migrations/003_preferences.sql';
export async function migrate(pool: { query(t: string): Promise<unknown> }): Promise<string[]> {
  await pool.query(init as string);
  await pool.query(adminHr as string);
  await pool.query(prefsSql as string);
  await pool.query(ownerSql as string);
  await pool.query(customSql as string);
  return ['001_init.sql', '002_admin_hr.sql', '003_preferences.sql', '004_owner_escalation.sql', '005_custom_reports.sql'];
}
