import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { hashPassword } from '../src/auth/crypto.ts';
import { withActor } from '../src/db/tx.ts';
import { freshDatabase, seedSynthetic, TEST_DB_URL } from './db.ts';

// Security and project-isolation tests through the HTTP API (M07-SEC-001/002, M07-AUD-001, SG-004).
// All users and data are synthetic.

const PASSWORD = 'clave-de-prueba-123';
const OCT = '2026-10-15';
let pool: pg.Pool;
let app: FastifyInstance;
let ref: Awaited<ReturnType<typeof seedSynthetic>>;

const config: Config = {
  databaseUrl: TEST_DB_URL,
  encryptionKey: randomBytes(32),
  cookieSecure: false,
  sessionIdleMinutes: 30,
  sessionMaxHours: 12,
  loginMaxAttempts: 5,
  loginLockMinutes: 15,
  passwordMinLength: 12,
};

async function createUser(username: string, roles: string[], projects: string[], opts: { mfa?: boolean; allProjects?: boolean; mustChange?: boolean } = {}) {
  await withActor(pool, 'test:setup', async (c) => {
    await c.query(
      `INSERT INTO app_user (username, full_name, password_hash, mfa_required, all_projects, must_change_password)
       VALUES ($1, $1, $2, $3, $4, $5)`,
      [username, await hashPassword(PASSWORD), opts.mfa ?? false, opts.allProjects ?? false, opts.mustChange ?? false]);
    for (const r of roles) await c.query('INSERT INTO user_role VALUES ($1,$2)', [username, r]);
    for (const p of projects) await c.query('INSERT INTO user_project VALUES ($1,$2)', [username, ref.project[p]]);
  }, { restricted: false });
}

type Res = Awaited<ReturnType<FastifyInstance['inject']>>;

async function call(method: 'GET' | 'POST', url: string, cookie?: string, payload?: unknown, csrf = true): Promise<Res> {
  return app.inject({
    method, url, payload: payload as object | undefined,
    headers: { ...(csrf ? { [CSRF_HEADER]: '1' } : {}), ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}) },
  });
}

async function login(username: string, password = PASSWORD): Promise<string> {
  const res = await call('POST', '/auth/login', undefined, { username, password });
  expect(res.statusCode, res.body).toBe(200);
  return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
}

/** Logs in and completes TOTP enrollment + verification. */
async function loginWithMfa(username: string): Promise<string> {
  const sid = await login(username);
  const enroll = await call('POST', '/auth/mfa/enroll', sid);
  expect(enroll.statusCode, enroll.body).toBe(200);
  const code = OTPAuth.URI.parse(enroll.json().otpauthUri).generate();
  expect((await call('POST', '/auth/mfa/verify', sid, { code })).statusCode).toBe(200);
  return sid;
}

const entryBody = (project: string, amount = '1000.00') => ({
  entryDate: OCT, periodId: ref.period['2026-10'], description: `Gasto ${project}`,
  lines: [
    { accountId: ref.account['5101'], currency: 'GTQ', debit: amount, rate: '1', rateSource: 'FUNCTIONAL', rateDate: OCT, projectId: ref.project[project] },
    { accountId: ref.account['1101'], currency: 'GTQ', credit: amount, rate: '1', rateSource: 'FUNCTIONAL', rateDate: OCT },
  ],
});

let conta: string; let gerenteA: string; let gerenteB: string; let consultaB: string;
let postedA: string;

beforeAll(async () => {
  pool = await freshDatabase();
  ref = await seedSynthetic(pool);
  app = buildApp({ pool, config });
  await createUser('admin', ['ADMIN_SISTEMA'], [], { mfa: true });
  await createUser('conta.a', ['CONTADOR'], ['P-A'], { mfa: true });
  await createUser('conta.ab', ['CONTADOR'], ['P-A', 'P-B'], { mfa: true });
  await createUser('gerente.a', ['GERENTE_FINANCIERO'], ['P-A'], { mfa: true });
  await createUser('gerente.b', ['GERENTE_FINANCIERO'], ['P-B'], { mfa: true });
  await createUser('consulta.b', ['CONSULTA'], ['P-B']);
  await createUser('auditor', ['AUDITOR'], [], { allProjects: true });
  await createUser('bloqueo', ['CONSULTA'], ['P-A']);

  conta = await loginWithMfa('conta.a');
  gerenteA = await loginWithMfa('gerente.a');
  gerenteB = await loginWithMfa('gerente.b');
  consultaB = await login('consulta.b');

  const created = await call('POST', '/journal-entries', conta, entryBody('P-A'));
  expect(created.statusCode, created.body).toBe(201);
  postedA = created.json().id;
  expect((await call('POST', `/journal-entries/${postedA}/approve`, gerenteA)).statusCode).toBe(200);
  expect((await call('POST', `/journal-entries/${postedA}/post`, conta)).statusCode).toBe(200);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('authentication', () => {
  it('rejects state-changing requests without the CSRF header', async () => {
    const res = await call('POST', '/auth/login', undefined, { username: 'conta.a', password: PASSWORD }, false);
    expect(res.statusCode).toBe(403);
  });

  it('returns the same response for a wrong password and an unknown user', async () => {
    const wrong = await call('POST', '/auth/login', undefined, { username: 'conta.a', password: 'incorrecta-123456' });
    const unknown = await call('POST', '/auth/login', undefined, { username: 'nadie', password: 'incorrecta-123456' });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('locks the account after 5 consecutive failures, even for the correct password', async () => {
    for (let i = 0; i < 5; i++) {
      await call('POST', '/auth/login', undefined, { username: 'bloqueo', password: 'incorrecta-123456' });
    }
    const res = await call('POST', '/auth/login', undefined, { username: 'bloqueo', password: PASSWORD });
    expect(res.statusCode).toBe(401);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE actor = 'bloqueo' AND action = 'LOGIN_FAILED'`);
    expect(rows[0].n).toBe(6);
  });

  it('requires authentication', async () => {
    expect((await call('GET', '/projects')).statusCode).toBe(401);
    expect((await call('GET', '/projects', 'token-falso')).statusCode).toBe(401);
  });

  it('revokes the session on logout', async () => {
    const sid = await login('consulta.b');
    expect((await call('POST', '/auth/logout', sid)).statusCode).toBe(200);
    expect((await call('GET', '/me', sid)).statusCode).toBe(401);
  });
});

describe('MFA for privileged permissions (SG-004)', () => {
  it('blocks approval until the second factor is verified', async () => {
    await createUser('gerente.mfa', ['GERENTE_FINANCIERO'], ['P-A'], { mfa: true });
    const sid = await login('gerente.mfa');
    const draft = (await call('POST', '/journal-entries', conta, entryBody('P-A', '5.00'))).json().id;

    const blocked = await call('POST', `/journal-entries/${draft}/approve`, sid);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('MFA_REQUIRED');

    const enroll = await call('POST', '/auth/mfa/enroll', sid);
    expect((await call('POST', '/auth/mfa/verify', sid, { code: '000000' })).statusCode).toBe(401);
    const code = OTPAuth.URI.parse(enroll.json().otpauthUri).generate();
    expect((await call('POST', '/auth/mfa/verify', sid, { code })).statusCode).toBe(200);
    expect((await call('POST', `/journal-entries/${draft}/approve`, sid)).statusCode).toBe(200);
  });

  it('does not allow re-enrolling an existing second factor', async () => {
    expect((await call('POST', '/auth/mfa/enroll', gerenteA)).statusCode).toBe(409);
  });
});

describe('project isolation (M07-SEC-002)', () => {
  it('lists only assigned projects', async () => {
    const res = await call('GET', '/projects', consultaB);
    expect(res.json().map((p: { code: string }) => p.code)).toEqual(['P-B']);
  });

  it('hides an entry of an unassigned project behind a direct request', async () => {
    expect((await call('GET', `/journal-entries/${postedA}`, consultaB)).statusCode).toBe(404);
    expect((await call('GET', `/journal-entries/${postedA}`, conta)).statusCode).toBe(200);
  });

  it('prevents approving or reversing an entry of an unassigned project', async () => {
    const draft = (await call('POST', '/journal-entries', conta, entryBody('P-A', '7.00'))).json().id;
    expect((await call('POST', `/journal-entries/${draft}/approve`, gerenteB)).statusCode).toBe(404);
    expect((await call('POST', `/journal-entries/${postedA}/reverse`, gerenteB,
      { entryDate: OCT, periodId: ref.period['2026-10'] })).statusCode).toBe(403); // lacks ledger.post
  });

  it('refuses a report filtered by an unassigned project', async () => {
    const res = await call('GET', `/reports/trial-balance?from=2026-10-01&to=2026-10-31&projectId=${ref.project['P-A']}`, consultaB);
    expect(res.statusCode).toBe(403);
  });

  it('excludes unassigned projects from an unfiltered report', async () => {
    const res = await call('GET', '/reports/trial-balance?from=2026-10-01&to=2026-10-31', consultaB);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ scope: 'ASSIGNED_PROJECTS', rows: [] });
  });

  it('refuses creating lines in an unassigned project', async () => {
    const res = await call('POST', '/journal-entries', conta, entryBody('P-B'));
    expect(res.statusCode).toBe(403);
  });

  it('hides and refuses an entry that is only partly visible', async () => {
    const both = await loginWithMfa('conta.ab');
    // Moves a cost from P-B to P-A: visible in full only to users assigned to both.
    const draft = (await call('POST', '/journal-entries', both, {
      ...entryBody('P-A', '20.00'),
      lines: [
        { accountId: ref.account['5101'], currency: 'GTQ', debit: '20.00', rate: '1', rateSource: 'FUNCTIONAL', rateDate: OCT, projectId: ref.project['P-A'] },
        { accountId: ref.account['5101'], currency: 'GTQ', credit: '20.00', rate: '1', rateSource: 'FUNCTIONAL', rateDate: OCT, projectId: ref.project['P-B'] },
      ],
    })).json().id;
    expect((await call('POST', `/journal-entries/${draft}/approve`, gerenteA)).statusCode).toBe(404);
    expect((await call('GET', `/journal-entries/${draft}`, gerenteA)).statusCode).toBe(404);
    expect((await call('GET', `/journal-entries/${draft}`, both)).statusCode).toBe(200);
  });

  it('enforces isolation in the database even if the API were bypassed (RLS)', async () => {
    const counts = await withActor(pool, 'consulta.b', async (c) => ({
      lines: (await c.query('SELECT count(*)::int AS n FROM journal_line WHERE project_id = $1', [ref.project['P-A']])).rows[0].n,
      entries: (await c.query('SELECT count(*)::int AS n FROM journal_entry WHERE id = $1', [postedA])).rows[0].n,
      audit: (await c.query('SELECT count(*)::int AS n FROM audit_event')).rows[0].n,
    }));
    expect(counts).toEqual({ lines: 0, entries: 0, audit: 0 });
  });

  it('the app role cannot read password hashes', async () => {
    await expect(withActor(pool, 'consulta.b', (c) => c.query('SELECT password_hash FROM app_user')))
      .rejects.toThrow(/permission denied/);
  });
});

describe('authorization by permission', () => {
  it('a read-only user cannot create entries', async () => {
    expect((await call('POST', '/journal-entries', consultaB, entryBody('P-B'))).statusCode).toBe(403);
  });

  it('the accountant who created an entry cannot approve it', async () => {
    const draft = (await call('POST', '/journal-entries', conta, entryBody('P-A', '3.00'))).json().id;
    expect((await call('POST', `/journal-entries/${draft}/approve`, conta)).statusCode).toBe(403); // no ledger.approve
  });
});

describe('ledger flow through the API', () => {
  it('reports the posted P-A entry in the project trial balance', async () => {
    const res = await call('GET', `/reports/trial-balance?from=2026-10-01&to=2026-10-31&projectId=${ref.project['P-A']}`, conta);
    expect(res.statusCode).toBe(200);
    // Only the P-A expense line carries the project; the bank line is institutional.
    expect(res.json().rows).toEqual([{ code: '5101', name: 'Gastos de proyecto', debit: '1000.00', credit: '0.00' }]);
  });

  it('reverses a posted entry through draft → approve → post', async () => {
    const created = (await call('POST', '/journal-entries', conta, entryBody('P-A', '40.00'))).json().id;
    await call('POST', `/journal-entries/${created}/approve`, gerenteA);
    await call('POST', `/journal-entries/${created}/post`, conta);
    const rev = await call('POST', `/journal-entries/${created}/reverse`, conta, { entryDate: OCT, periodId: ref.period['2026-10'] });
    expect(rev.statusCode, rev.body).toBe(201);
    expect((await call('POST', `/journal-entries/${rev.json().id}/approve`, gerenteA)).statusCode).toBe(200);
    expect((await call('POST', `/journal-entries/${rev.json().id}/post`, conta)).statusCode).toBe(200);
    const orig = await call('GET', `/journal-entries/${created}`, conta);
    expect(orig.json().entry.status).toBe('REVERSED');
  });

  it('maps ledger rule violations to 422', async () => {
    const body = entryBody('P-A');
    body.lines[1]!.credit = '999.99';
    const draft = (await call('POST', '/journal-entries', conta, body)).json().id;
    const res = await call('POST', `/journal-entries/${draft}/approve`, gerenteA);
    expect(res.statusCode).toBe(422);
  });

  it('rejects a duplicate source document with 409', async () => {
    const body = { ...entryBody('P-A', '1.00'), source: { type: 'AP_INVOICE', id: 'FEL-TEST-1' } };
    expect((await call('POST', '/journal-entries', conta, body)).statusCode).toBe(201);
    expect((await call('POST', '/journal-entries', conta, body)).statusCode).toBe(409);
  });
});

describe('administration', () => {
  let admin: string;
  beforeAll(async () => { admin = await loginWithMfa('admin'); });

  it('creates a user who must change password, with MFA forced for privileged roles', async () => {
    const res = await call('POST', '/admin/users', admin, {
      username: 'nuevo.gerente', fullName: 'Nuevo', roles: ['GERENTE_FINANCIERO'],
      projectIds: [ref.project['P-A']], temporaryPassword: 'temporal-segura-1',
    });
    expect(res.statusCode, res.body).toBe(201);
    const sid = await login('nuevo.gerente', 'temporal-segura-1');
    const me = (await call('GET', '/me', sid)).json();
    expect(me).toMatchObject({ mustChangePassword: true, mfaRequired: true });
    expect((await call('GET', '/projects', sid)).json().error).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await call('POST', '/auth/password', sid, { current: 'temporal-segura-1', next: 'otra-clave-segura-2' })).statusCode).toBe(200);
    expect((await call('GET', '/projects', sid)).statusCode).toBe(200);
  });

  it('only administrators can create users', async () => {
    const res = await call('POST', '/admin/users', conta, {
      username: 'intruso', fullName: 'X', roles: ['ADMIN_SISTEMA'], temporaryPassword: 'temporal-segura-1',
    });
    expect(res.statusCode).toBe(403);
  });

  it('disabling a user revokes their sessions immediately', async () => {
    await createUser('saliente', ['CONSULTA'], ['P-A']);
    const sid = await login('saliente');
    expect((await call('POST', '/admin/users/saliente/disable', admin)).statusCode).toBe(200);
    expect((await call('GET', '/me', sid)).statusCode).toBe(401);
    expect((await call('POST', '/auth/login', undefined, { username: 'saliente', password: PASSWORD })).statusCode).toBe(401);
  });
});

describe('audit trail', () => {
  it('auditor can verify the chain; others cannot', async () => {
    const auditor = await login('auditor');
    const res = await call('GET', '/audit/verify', auditor);
    expect(res.json()).toEqual({ intact: true, firstBrokenId: null });
    expect((await call('GET', '/audit/verify', consultaB)).statusCode).toBe(403);
  });

  it('never stores password hashes or TOTP secrets in the audit trail', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE data::text LIKE '%argon2%' OR data ? 'totp_secret_enc' OR data ? 'password_hash'`);
    expect(rows[0].n).toBe(0);
  });

  it('records who approved and posted', async () => {
    const { rows } = await pool.query(
      `SELECT actor FROM audit_event WHERE entity_type = 'journal_entry' AND entity_id = $1 AND action = 'UPDATE' ORDER BY id`,
      [String(postedA)]);
    expect(rows.map((r) => r.actor)).toEqual(['gerente.a', 'conta.a']);
  });
});
