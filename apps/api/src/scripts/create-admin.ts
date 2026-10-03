/**
 * Bootstraps the first system administrator. Runs as the database owner because
 * no administrator exists yet to authorize the change. The password is read from
 * the ADMIN_PASSWORD environment variable and is never logged.
 *
 *   DATABASE_URL=... ADMIN_PASSWORD=... npm run create-admin -w @coni/api -- <username> "<Full name>"
 */
import pg from 'pg';
import { hashPassword } from '../auth/crypto.ts';

const [username, fullName] = process.argv.slice(2);
const password = process.env.ADMIN_PASSWORD;
if (!username || !fullName || !password) {
  console.error('Usage: ADMIN_PASSWORD=... create-admin <username> "<Full name>"');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Password must be at least 12 characters');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.user_id', 'bootstrap:create-admin', true)");
  await client.query(
    `INSERT INTO app_user (username, full_name, password_hash, mfa_required, must_change_password)
     VALUES ($1, $2, $3, true, true)`, [username, fullName, await hashPassword(password)]);
  await client.query(`INSERT INTO user_role (username, role_code) VALUES ($1, 'ADMIN_SISTEMA')`, [username]);
  await client.query('COMMIT');
  console.log(`Administrator ${username} created. Password change and MFA enrollment are required at first login.`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
