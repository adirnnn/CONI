import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import type { Pool } from 'pg';
import { z, ZodError } from 'zod';
import type { Config } from './config.ts';
import { AuthService, type AuthUser } from './auth/service.ts';
import { hashPassword, verifyPassword } from './auth/crypto.ts';
import './db/types.ts';
import { withActor } from './db/tx.ts';
import {
  LedgerError, approveEntry, createEntry, draftReversal, postEntry, postReversal, trialBalance,
} from './ledger/ledger.ts';

declare module 'fastify' {
  interface FastifyRequest { user: AuthUser | null }
}

export const SESSION_COOKIE = 'coni_sid';
export const CSRF_HEADER = 'x-coni-csrf';

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const amount = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/);
const rate = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);
const id = z.coerce.number().int().positive();

const lineSchema = z.object({
  accountId: id,
  currency: z.string().regex(/^[A-Z]{3}$/),
  debit: amount.optional(),
  credit: amount.optional(),
  rate,
  rateSource: z.enum(['FUNCTIONAL', 'BANGUAT', 'MANUAL']),
  rateDate: date,
  debitGtq: amount.optional(),
  creditGtq: amount.optional(),
  projectId: id.nullish(),
  fundId: id.nullish(),
  donorId: id.nullish(),
  agreementId: id.nullish(),
  memo: z.string().max(500).optional(),
});

const entrySchema = z.object({
  entryDate: date,
  periodId: id,
  description: z.string().min(1).max(500),
  source: z.object({ type: z.string().min(1).max(40), id: z.string().min(1).max(100) }).optional(),
  lines: z.array(lineSchema).min(2).max(500),
});

export function buildApp(deps: { pool: Pool; config: Config }): FastifyInstance {
  const { pool, config } = deps;
  const auth = new AuthService(pool, config);
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 1_000_000 });

  app.register(cookie);
  app.decorateRequest('user', null);

  // CSRF: state-changing requests must carry a custom header, which a cross-site
  // form cannot set without a CORS preflight (and no CORS is enabled).
  app.addHook('onRequest', async (req) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers[CSRF_HEADER] !== '1') {
      throw new HttpError(403, 'CSRF', 'Solicitud rechazada');
    }
  });

  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.user = token ? await auth.resolve(token) : null;
  });

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'VALIDATION', issues: err.issues });
    if (err instanceof LedgerError) {
      const status = { NOT_FOUND: 404, CONFLICT: 409, FORBIDDEN: 403 }[err.code];
      return reply.status(status).send({ error: err.code, message: err.message });
    }
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23514') return reply.status(422).send({ error: 'RULE', message: err.message });
    if (pgCode === '23505') return reply.status(409).send({ error: 'DUPLICATE', message: 'Registro duplicado' });
    if (pgCode === '23503') return reply.status(422).send({ error: 'REFERENCE', message: 'Referencia inválida' });
    if (pgCode === '42501') return reply.status(403).send({ error: 'FORBIDDEN', message: 'Acceso denegado' });
    if (pgCode === '22P02' || pgCode === '22007' || pgCode === '22008') {
      return reply.status(400).send({ error: 'VALIDATION', message: 'Dato inválido' });
    }
    const statusCode = (err as Error & { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({ error: 'REQUEST', message: err.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'INTERNAL', message: 'Error interno' });
  });

  /** Authenticated user, with optional permission; privileged permissions need MFA when required. */
  function guard(permission?: string, opts: { allowPasswordChange?: boolean } = {}) {
    return async (req: FastifyRequest) => {
      const u = req.user;
      if (!u) throw new HttpError(401, 'UNAUTHENTICATED', 'Sesión no válida');
      if (u.mustChangePassword && !opts.allowPasswordChange) {
        throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Debe cambiar su contraseña');
      }
      if (!permission) return;
      if (!u.permissions.has(permission)) throw new HttpError(403, 'FORBIDDEN', 'Permiso insuficiente');
      if (u.privileged.has(permission) && u.mfaRequired && !u.mfaVerified) {
        throw new HttpError(403, 'MFA_REQUIRED', 'Se requiere segundo factor');
      }
    };
  }
  const as = <T>(req: FastifyRequest, fn: Parameters<typeof withActor<T>>[2]) => withActor<T>(pool, req.user!.username, fn);

  // ------------------------------------------------------------ auth
  app.post('/auth/login', async (req, reply) => {
    const body = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) }).parse(req.body);
    const token = await auth.login(body.username, body.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    if (!token) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas');
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/',
      maxAge: config.sessionMaxHours * 3600,
    });
    const user = (await auth.resolve(token))!;
    return {
      username: user.username, mfaRequired: user.mfaRequired, mfaEnrolled: user.mfaEnrolled,
      mustChangePassword: user.mustChangePassword,
    };
  });

  app.post('/auth/logout', { preHandler: guard(undefined, { allowPasswordChange: true }) }, async (req, reply) => {
    await auth.logout(req.user!);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', { preHandler: guard(undefined, { allowPasswordChange: true }) }, async (req) => {
    const u = req.user!;
    return {
      username: u.username, fullName: u.fullName, permissions: [...u.permissions].sort(),
      allProjects: u.allProjects, mfaRequired: u.mfaRequired, mfaEnrolled: u.mfaEnrolled,
      mfaVerified: u.mfaVerified, mustChangePassword: u.mustChangePassword,
    };
  });

  app.post('/auth/password', { preHandler: guard(undefined, { allowPasswordChange: true }) }, async (req) => {
    const body = z.object({ current: z.string(), next: z.string().min(config.passwordMinLength).max(200) }).parse(req.body);
    const stored = await as(req, async (c) =>
      (await c.query<{ password_hash: string }>('SELECT password_hash FROM auth_get_credentials($1)',
        [req.user!.username])).rows[0]?.password_hash);
    if (!(await verifyPassword(stored, body.current))) throw new HttpError(403, 'INVALID_CREDENTIALS', 'Contraseña actual incorrecta');
    if (body.next === body.current) throw new HttpError(400, 'VALIDATION', 'La nueva contraseña debe ser distinta');
    const h = await hashPassword(body.next);
    await as(req, (c) => c.query('SELECT user_change_password($1)', [h]));
    return { ok: true };
  });

  app.post('/auth/mfa/enroll', { preHandler: guard(undefined, { allowPasswordChange: true }) }, async (req) => {
    const uri = await auth.enrollTotp(req.user!);
    if (!uri) throw new HttpError(409, 'MFA_ALREADY_ENROLLED', 'El segundo factor ya está configurado');
    return { otpauthUri: uri };
  });

  app.post('/auth/mfa/verify', { preHandler: guard(undefined, { allowPasswordChange: true }) }, async (req) => {
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    if (!(await auth.verifyTotp(req.user!, body.code))) throw new HttpError(401, 'MFA_INVALID', 'Código inválido');
    return { ok: true };
  });

  // ------------------------------------------------------------ administration
  app.post('/admin/users', { preHandler: guard('admin.users') }, async (req, reply) => {
    const body = z.object({
      username: z.string().regex(/^[a-z][a-z0-9._-]{2,40}$/),
      fullName: z.string().min(1).max(200),
      email: z.string().email().optional(),
      roles: z.array(z.string()).min(1),
      projectIds: z.array(id).default([]),
      allProjects: z.boolean().default(false),
      temporaryPassword: z.string().min(config.passwordMinLength).max(200),
    }).parse(req.body);
    const h = await hashPassword(body.temporaryPassword);
    await as(req, async (c) => {
      // MFA is mandatory for any role carrying a privileged permission.
      const priv = (await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM role_permission rp JOIN permission p ON p.code = rp.permission_code
          WHERE rp.role_code = ANY($1) AND p.privileged`, [body.roles])).rows[0]!.n !== '0';
      await c.query('SELECT admin_create_user($1,$2,$3,$4,$5,$6)',
        [body.username, body.fullName, body.email ?? null, h, body.allProjects, priv]);
      for (const r of body.roles) await c.query('INSERT INTO user_role VALUES ($1,$2)', [body.username, r]);
      for (const p of body.projectIds) await c.query('INSERT INTO user_project VALUES ($1,$2)', [body.username, p]);
    });
    return reply.status(201).send({ username: body.username });
  });

  app.post('/admin/users/:username/disable', { preHandler: guard('admin.users') }, async (req) => {
    const { username } = z.object({ username: z.string() }).parse(req.params);
    await as(req, (c) => c.query('SELECT admin_disable_user($1)', [username]));
    return { ok: true };
  });

  app.post('/admin/users/:username/reset-password', { preHandler: guard('admin.users') }, async (req) => {
    const { username } = z.object({ username: z.string() }).parse(req.params);
    const body = z.object({ temporaryPassword: z.string().min(config.passwordMinLength).max(200) }).parse(req.body);
    const h = await hashPassword(body.temporaryPassword);
    await as(req, (c) => c.query('SELECT admin_set_password($1,$2)', [username, h]));
    return { ok: true };
  });

  // ------------------------------------------------------------ ledger
  app.get('/projects', { preHandler: guard('ledger.read') }, async (req) =>
    as(req, async (c) => (await c.query('SELECT id, code, name, active FROM project ORDER BY code')).rows));

  app.get('/accounts', { preHandler: guard('ledger.read') }, async (req) =>
    as(req, async (c) => (await c.query(
      'SELECT id, code, name, type, is_postable, requires_project, active FROM account ORDER BY code')).rows));

  app.get('/periods', { preHandler: guard('ledger.read') }, async (req) =>
    as(req, async (c) => (await c.query(
      `SELECT id, code, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date, status
         FROM fiscal_period ORDER BY start_date DESC`)).rows));

  app.get('/journal-entries', { preHandler: guard('ledger.read') }, async (req) => {
    const q = z.object({
      status: z.enum(['DRAFT', 'APPROVED', 'POSTED', 'REVERSED']).optional(),
      projectId: id.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    return as(req, async (c) => (await c.query(
      `SELECT e.id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.description, e.status, e.created_by,
              e.approved_by, e.posted_by, e.reverses_entry_id,
              (SELECT coalesce(sum(debit_gtq), 0)::numeric(18,2)::text FROM journal_line l WHERE l.entry_id = e.id) AS total_gtq
         FROM journal_entry e
        WHERE ($1::text IS NULL OR e.status = $1)
          AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM journal_line l WHERE l.entry_id = e.id AND l.project_id = $2))
        ORDER BY e.entry_date DESC, e.id DESC LIMIT $3 OFFSET $4`,
      [q.status ?? null, q.projectId ?? null, q.limit, q.offset])).rows);
  });

  app.post('/journal-entries', { preHandler: guard('ledger.write') }, async (req, reply) => {
    const body = entrySchema.parse(req.body);
    const entryId = await as(req, (c) => createEntry(c, { ...body, createdBy: req.user!.username }));
    return reply.status(201).send({ id: entryId });
  });

  app.get('/journal-entries/:id', { preHandler: guard('ledger.read') }, async (req) => {
    const { id: entryId } = z.object({ id }).parse(req.params);
    return as(req, async (c) => {
      const entry = (await c.query('SELECT * FROM journal_entry WHERE id = $1', [entryId])).rows[0];
      if (!entry) throw new LedgerError('Partida no encontrada', 'NOT_FOUND');
      const lines = (await c.query('SELECT * FROM journal_line WHERE entry_id = $1 ORDER BY line_no', [entryId])).rows;
      return { entry, lines };
    });
  });

  const entryAction = (permission: string, action: (c: Parameters<typeof approveEntry>[0], entryId: string, user: string) => Promise<void>) =>
    async (req: FastifyRequest, _reply: FastifyReply) => {
      await guard(permission)(req);
      const { id: entryId } = z.object({ id }).parse(req.params);
      await as(req, (c) => action(c, String(entryId), req.user!.username));
      return { ok: true };
    };

  app.post('/journal-entries/:id/approve', entryAction('ledger.approve', approveEntry));
  app.post('/journal-entries/:id/post', entryAction('ledger.post', async (c, eid, u) => {
    const isReversal = (await c.query('SELECT 1 FROM journal_entry WHERE id = $1 AND reverses_entry_id IS NOT NULL', [eid])).rowCount;
    await (isReversal ? postReversal(c, eid, u) : postEntry(c, eid, u));
  }));
  app.post('/journal-entries/:id/reverse', { preHandler: guard('ledger.post') }, async (req, reply) => {
    const { id: entryId } = z.object({ id }).parse(req.params);
    const body = z.object({ entryDate: date, periodId: id }).parse(req.body);
    const revId = await as(req, (c) => draftReversal(c, String(entryId), body.entryDate, body.periodId, req.user!.username));
    return reply.status(201).send({ id: revId });
  });

  app.get('/reports/trial-balance', { preHandler: guard('ledger.read') }, async (req) => {
    const q = z.object({ from: date, to: date, projectId: id.optional() }).parse(req.query);
    return as(req, async (c) => {
      if (q.projectId !== undefined) {
        const visible = (await c.query<{ ok: boolean }>('SELECT app_can_see_project($1) AS ok', [q.projectId])).rows[0]!.ok;
        if (!visible) throw new HttpError(403, 'FORBIDDEN', 'Proyecto no asignado');
      }
      const scope = q.projectId !== undefined ? 'PROJECT' : req.user!.allProjects ? 'CONSOLIDATED' : 'ASSIGNED_PROJECTS';
      return { scope, from: q.from, to: q.to, projectId: q.projectId ?? null, rows: await trialBalance(c, q) };
    });
  });

  // ------------------------------------------------------------ audit
  app.get('/audit/verify', { preHandler: guard('audit.read') }, async (req) =>
    as(req, async (c) => {
      const broken = (await c.query<{ broken: string | null }>('SELECT audit_verify_chain() AS broken')).rows[0]!.broken;
      return { intact: broken === null, firstBrokenId: broken };
    }));

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  return app;
}
