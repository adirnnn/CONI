import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { hashPassword } from '../src/auth/crypto.ts';
import { withActor } from '../src/db/tx.ts';
import type { RateFetcher } from '../src/integrations/banguat.ts';
import { freshDatabase, seedSynthetic, TEST_DB_URL } from './db.ts';

export const PASSWORD = 'clave-de-prueba-123';

export type Res = Awaited<ReturnType<FastifyInstance['inject']>>;

/** Fresh database + app + helpers for HTTP-level tests. All data is synthetic. */
export async function createHarness(opts: { rateFetcher?: RateFetcher } = {}) {
  const pool: pg.Pool = await freshDatabase();
  const ref = await seedSynthetic(pool);
  const config: Config = {
    databaseUrl: TEST_DB_URL, encryptionKey: randomBytes(32), cookieSecure: false,
    sessionIdleMinutes: 30, sessionMaxHours: 12, loginMaxAttempts: 5, loginLockMinutes: 15, passwordMinLength: 12,
  };
  const app = buildApp({ pool, config, rateFetcher: opts.rateFetcher });
  let passwordHash: string | undefined;

  async function createUser(username: string, roles: string[], projects: string[],
    o: { mfa?: boolean; allProjects?: boolean } = {}) {
    passwordHash ??= await hashPassword(PASSWORD);
    await withActor(pool, 'test:setup', async (c) => {
      await c.query(
        `INSERT INTO app_user (username, full_name, password_hash, mfa_required, all_projects, must_change_password)
         VALUES ($1, $1, $2, $3, $4, false)`, [username, passwordHash, o.mfa ?? false, o.allProjects ?? false]);
      for (const r of roles) await c.query('INSERT INTO user_role VALUES ($1,$2)', [username, r]);
      for (const p of projects) await c.query('INSERT INTO user_project VALUES ($1,$2)', [username, ref.project[p]]);
    }, { restricted: false });
  }

  async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, cookie?: string, payload?: unknown): Promise<Res> {
    return app.inject({
      method, url, payload: payload as object | undefined,
      headers: { [CSRF_HEADER]: '1', ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}) },
    });
  }

  async function login(username: string): Promise<string> {
    const res = await call('POST', '/auth/login', undefined, { username, password: PASSWORD });
    if (res.statusCode !== 200) throw new Error(`login ${username}: ${res.body}`);
    return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }

  async function loginWithMfa(username: string): Promise<string> {
    const sid = await login(username);
    const uri = (await call('POST', '/auth/mfa/enroll', sid)).json().otpauthUri;
    const verify = await call('POST', '/auth/mfa/verify', sid, { code: OTPAuth.URI.parse(uri).generate() });
    if (verify.statusCode !== 200) throw new Error(`mfa ${username}: ${verify.body}`);
    return sid;
  }

  return {
    pool, app, ref, createUser, call, login, loginWithMfa,
    close: async () => { await app.close(); await pool.end(); },
  };
}
