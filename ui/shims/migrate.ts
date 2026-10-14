import init from '../../src/db/migrations/001_init.sql';
import adminHr from '../../src/db/migrations/002_admin_hr.sql';
import ownerSql from '../../src/db/migrations/004_owner_escalation.sql';
import customSql from '../../src/db/migrations/005_custom_reports.sql';
import salesSql from '../../src/db/migrations/006_crm_sales.sql';
import mastersSql from '../../src/db/migrations/007_masters.sql';
import aiSql from '../../src/db/migrations/008_ai_models.sql';
import prefsSql from '../../src/db/migrations/003_preferences.sql';
export async function migrate(pool: { query(t: string): Promise<unknown> }): Promise<string[]> {
  await pool.query(init as string);
  await pool.query(adminHr as string);
  await pool.query(prefsSql as string);
  await pool.query(ownerSql as string);
  await pool.query(customSql as string);
  await pool.query(salesSql as string);
  await pool.query(mastersSql as string);
  await pool.query(aiSql as string);
  return ['001_init.sql', '002_admin_hr.sql', '003_preferences.sql', '004_owner_escalation.sql', '005_custom_reports.sql', '006_crm_sales.sql', '007_masters.sql', '008_ai_models.sql'];
}
