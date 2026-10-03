/**
 * Loads SYNTHETIC demonstration data into a local development database.
 * Never run against staging or production: it requires ALLOW_SYNTHETIC_SEED=1,
 * a database whose name ends in "_dev" or equals "coni" on localhost, and
 * DEV_SEED_PASSWORD for the demo users. For local convenience the demo users are
 * not forced to change it; MFA is still required for privileged roles.
 */
import pg from 'pg';
import { hashPassword } from '../auth/crypto.ts';

const url = new URL(process.env.DATABASE_URL ?? '');
const password = process.env.DEV_SEED_PASSWORD;
const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
const dbName = url.pathname.slice(1);
if (process.env.ALLOW_SYNTHETIC_SEED !== '1' || !localHost || !(dbName.endsWith('_dev') || dbName === 'coni')) {
  console.error('Refusing to seed: set ALLOW_SYNTHETIC_SEED=1 and use a local development database.');
  process.exit(1);
}
if (!password || password.length < 12) {
  console.error('DEV_SEED_PASSWORD (12+ characters) is required.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.user_id', 'seed:synthetic', true)");
  await client.query(`
    INSERT INTO currency (code, name, is_functional) VALUES ('GTQ','Quetzal',true), ('USD','Dólar estadounidense',false)
      ON CONFLICT DO NOTHING;
    INSERT INTO fiscal_period (code, start_date, end_date, status) VALUES
      ('2026-09','2026-09-01','2026-09-30','CLOSED'), ('2026-10','2026-10-01','2026-10-31','OPEN'),
      ('2026-11','2026-11-01','2026-11-30','OPEN') ON CONFLICT DO NOTHING;
    INSERT INTO account (code, name, type, is_postable, requires_project) VALUES
      ('1','ACTIVO (DEMO)','ASSET',false,false),
      ('1101','Bancos GTQ (demo)','ASSET',true,false),
      ('1102','Bancos USD (demo)','ASSET',true,false),
      ('2101','Proveedores (demo)','LIABILITY',true,false),
      ('4101','Donaciones recibidas (demo)','INCOME',true,true),
      ('5101','Gastos de programa (demo)','EXPENSE',true,true),
      ('5201','Gastos administrativos (demo)','EXPENSE',true,false)
      ON CONFLICT DO NOTHING;
    INSERT INTO project (code, name) VALUES ('DEMO-A','Proyecto sintético A'), ('DEMO-B','Proyecto sintético B')
      ON CONFLICT DO NOTHING;
  `);
  const hash = await hashPassword(password);
  const users: [string, string, string[], string[]][] = [
    ['demo.admin', 'Admin Demo', ['ADMIN_SISTEMA'], []],
    ['demo.contador', 'Contador Demo', ['CONTADOR'], ['DEMO-A', 'DEMO-B']],
    ['demo.gerente', 'Gerente Demo', ['GERENTE_FINANCIERO'], ['DEMO-A']],
    ['demo.consulta', 'Consulta Demo B', ['CONSULTA'], ['DEMO-B']],
  ];
  for (const [username, name, roles, projects] of users) {
    const privileged = !roles.includes('CONSULTA');
    const r = await client.query(
      `INSERT INTO app_user (username, full_name, password_hash, mfa_required, must_change_password)
       VALUES ($1, $2, $3, $4, false) ON CONFLICT DO NOTHING`, [username, name, hash, privileged]);
    if (r.rowCount === 0) continue;
    for (const role of roles) await client.query('INSERT INTO user_role VALUES ($1,$2)', [username, role]);
    for (const code of projects) {
      await client.query('INSERT INTO user_project SELECT $1, id FROM project WHERE code = $2', [username, code]);
    }
  }
  await client.query('COMMIT');
  console.log(`Synthetic seed loaded: ${users.map((u) => u[0]).join(', ')}`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
