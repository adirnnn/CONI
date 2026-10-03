import pg from 'pg';
import { migrate } from '../src/db/migrate.ts';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://coni:coni_local_only@localhost:54360/coni_test';

/** Recreates the test database from scratch and applies all migrations. */
export async function freshDatabase(): Promise<pg.Pool> {
  const url = new URL(TEST_DB_URL);
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to reset non-test database "${dbName}"`);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  await migrate(TEST_DB_URL);
  return new pg.Pool({ connectionString: TEST_DB_URL });
}

/** Synthetic reference data only — never real client data. */
export async function seedSynthetic(pool: pg.Pool) {
  await pool.query(`
    INSERT INTO currency (code, name, is_functional) VALUES ('GTQ','Quetzal',true), ('USD','Dólar',false);
    INSERT INTO fiscal_period (code, start_date, end_date, status) VALUES
      ('2026-09','2026-09-01','2026-09-30','CLOSED'),
      ('2026-10','2026-10-01','2026-10-31','OPEN');
    INSERT INTO account (code, name, type, is_postable, requires_project) VALUES
      ('1','Activo','ASSET',false,false),
      ('1101','Bancos GTQ','ASSET',true,false),
      ('1102','Bancos USD','ASSET',true,false),
      ('5101','Gastos de proyecto','EXPENSE',true,true),
      ('4101','Donaciones recibidas','INCOME',true,true);
    INSERT INTO project (code, name) VALUES ('P-A','Proyecto A sintético'), ('P-B','Proyecto B sintético');
  `);
  const ids = async (sql: string) =>
    Object.fromEntries((await pool.query<{ code: string; id: number }>(sql)).rows.map((r) => [r.code, r.id]));
  return {
    account: await ids('SELECT code, id FROM account'),
    period: await ids('SELECT code, id FROM fiscal_period'),
    project: await ids('SELECT code, id FROM project'),
  };
}
