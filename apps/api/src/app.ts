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
  LedgerError, approveEntry, createEntry, draftReversal, periodFor, postEntry, postReversal, priceLines, trialBalance,
} from './ledger/ledger.ts';
import { RateSyncError, syncRates, type RateFetcher } from './integrations/banguat.ts';

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

const positive = (v: string) => /[1-9]/.test(v);

// Rates and GTQ equivalents are computed by the server (priceLines), never taken from the client.
const lineSchema = z.object({
  accountId: id,
  currency: z.string().regex(/^[A-Z]{3}$/),
  debit: amount.optional(),
  credit: amount.optional(),
  projectId: id.nullish(),
  fundId: id.nullish(),
  donorId: id.nullish(),
  agreementId: id.nullish(),
  memo: z.string().max(500).optional(),
}).refine((l) => !(l.debit && l.credit) && Boolean(l.debit && positive(l.debit)) !== Boolean(l.credit && positive(l.credit)),
  { message: 'Cada línea lleva un monto positivo en Debe o en Haber, no en ambos' });

const entrySchema = z.object({
  entryDate: date,
  description: z.string().min(1).max(500),
  source: z.object({ type: z.string().min(1).max(40), id: z.string().min(1).max(100) }).optional(),
  lines: z.array(lineSchema).min(2).max(500),
});

export function buildApp(deps: { pool: Pool; config: Config; rateFetcher?: RateFetcher }): FastifyInstance {
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
      const status = { NOT_FOUND: 404, CONFLICT: 409, FORBIDDEN: 403, RULE: 422 }[err.code];
      return reply.status(status).send({ error: err.code, message: err.message });
    }
    const pgCode = (err as { code?: string }).code;
    if (err instanceof RateSyncError) return reply.status(422).send({ error: 'RATE_SYNC', message: err.message });
    if (pgCode === '23514') return reply.status(422).send({ error: 'RULE', message: err.message });
    if (pgCode === '23P01') return reply.status(422).send({ error: 'RULE', message: 'El rango se traslapa con otro registro' });
    if (pgCode === 'P0002') return reply.status(404).send({ error: 'NOT_FOUND', message: 'No encontrado' });
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
      'SELECT id, code, name, type, parent_id, is_postable, requires_project, active FROM account ORDER BY code')).rows));

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
    const entryId = await as(req, async (c) => createEntry(c, {
      ...body,
      periodId: await periodFor(c, body.entryDate),
      lines: await priceLines(c, body.entryDate, body.lines),
      createdBy: req.user!.username,
    }));
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

  // Approval returns any budget alerts it raised (WARN budgets); BLOCK budgets reject with 422.
  app.post('/journal-entries/:id/approve', async (req) => {
    await guard('ledger.approve')(req);
    const { id: entryId } = z.object({ id }).parse(req.params);
    return as(req, async (c) => {
      await approveEntry(c, String(entryId), req.user!.username);
      const alerts = (await c.query(
        `SELECT p.code AS project_code, ac.code AS account_code, a.kind, a.requested::text, a.available::text
           FROM budget_alert a JOIN project p ON p.id = a.project_id JOIN account ac ON ac.id = a.account_id
          WHERE a.entry_id = $1 ORDER BY a.id`, [entryId])).rows;
      return { ok: true, budgetAlerts: alerts };
    });
  });
  app.post('/journal-entries/:id/post', entryAction('ledger.post', async (c, eid, u) => {
    const isReversal = (await c.query('SELECT 1 FROM journal_entry WHERE id = $1 AND reverses_entry_id IS NOT NULL', [eid])).rowCount;
    await (isReversal ? postReversal(c, eid, u) : postEntry(c, eid, u));
  }));
  app.post('/journal-entries/:id/reverse', { preHandler: guard('ledger.post') }, async (req, reply) => {
    const { id: entryId } = z.object({ id }).parse(req.params);
    const body = z.object({ entryDate: date }).parse(req.body);
    const revId = await as(req, async (c) =>
      draftReversal(c, String(entryId), body.entryDate, await periodFor(c, body.entryDate), req.user!.username));
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

  // ------------------------------------------------------------ accounting configuration
  app.post('/accounts', { preHandler: guard('accounting.config') }, async (req, reply) => {
    const b = z.object({
      code: z.string().regex(/^[0-9A-Za-z.-]{1,30}$/),
      name: z.string().min(1).max(200),
      type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']),
      parentId: id.nullish(),
      isPostable: z.boolean(),
      requiresProject: z.boolean().default(false),
    }).parse(req.body);
    const row = await as(req, async (c) => (await c.query(
      `INSERT INTO account (code, name, type, parent_id, is_postable, requires_project)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.code, b.name, b.type, b.parentId ?? null, b.isPostable, b.requiresProject])).rows[0]);
    return reply.status(201).send(row);
  });

  app.patch('/accounts/:id', { preHandler: guard('accounting.config') }, async (req) => {
    const { id: accountId } = z.object({ id }).parse(req.params);
    const b = z.object({
      name: z.string().min(1).max(200).optional(),
      active: z.boolean().optional(),
      requiresProject: z.boolean().optional(),
    }).parse(req.body);
    const n = await as(req, async (c) => (await c.query(
      `UPDATE account SET name = coalesce($2, name), active = coalesce($3, active),
              requires_project = coalesce($4, requires_project) WHERE id = $1`,
      [accountId, b.name ?? null, b.active ?? null, b.requiresProject ?? null])).rowCount);
    if (n !== 1) throw new HttpError(404, 'NOT_FOUND', 'Cuenta no encontrada');
    return { ok: true };
  });

  app.post('/periods', { preHandler: guard('accounting.config') }, async (req, reply) => {
    const b = z.object({ code: z.string().min(1).max(20), startDate: date, endDate: date }).parse(req.body);
    const row = await as(req, async (c) => (await c.query(
      'INSERT INTO fiscal_period (code, start_date, end_date) VALUES ($1,$2,$3) RETURNING id',
      [b.code, b.startDate, b.endDate])).rows[0]);
    return reply.status(201).send(row);
  });

  app.post('/periods/:id/close', { preHandler: guard('period.close') }, async (req) => {
    const { id: pid } = z.object({ id }).parse(req.params);
    await as(req, (c) => c.query("SELECT period_set_status($1, 'CLOSED', NULL)", [pid]));
    return { ok: true };
  });

  app.post('/periods/:id/reopen', { preHandler: guard('period.close') }, async (req) => {
    const { id: pid } = z.object({ id }).parse(req.params);
    const b = z.object({ reason: z.string().min(10).max(1000) }).parse(req.body);
    await as(req, (c) => c.query("SELECT period_set_status($1, 'OPEN', $2)", [pid, b.reason]));
    return { ok: true };
  });

  app.get('/currencies', { preHandler: guard('ledger.read') }, async (req) =>
    as(req, async (c) => (await c.query(
      'SELECT code, name, is_functional, banguat_code, enabled FROM currency ORDER BY is_functional DESC, code')).rows));

  app.get('/rates', { preHandler: guard('ledger.read') }, async (req) => {
    const q = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), from: date, to: date }).parse(req.query);
    return as(req, async (c) => (await c.query(
      `SELECT currency_code, rate_date, rate::text, source, justification, approved_by
         FROM exchange_rate WHERE currency_code = $1 AND rate_date BETWEEN $2 AND $3
        ORDER BY rate_date DESC, source`, [q.currency, q.from, q.to])).rows);
  });

  app.post('/rates/manual', { preHandler: guard('rates.manual') }, async (req, reply) => {
    const b = z.object({
      currency: z.string().regex(/^[A-Z]{3}$/), date, rate, justification: z.string().min(10).max(1000),
    }).parse(req.body);
    await as(req, (c) => c.query('SELECT rate_set_manual($1,$2,$3,$4)', [b.currency, b.date, b.rate, b.justification]));
    return reply.status(201).send({ ok: true });
  });

  app.post('/rates/sync', { preHandler: guard('accounting.config') }, async (req) => {
    const b = z.object({ currency: z.string().regex(/^[A-Z]{3}$/).default('USD'), from: date, to: date })
      .refine((v) => v.from <= v.to, 'Rango inválido').parse(req.body);
    const days = (Date.parse(b.to) - Date.parse(b.from)) / 86_400_000;
    if (days > 366) throw new HttpError(400, 'VALIDATION', 'El rango máximo es de un año');
    return syncRates(pool, b.currency, b.from, b.to, deps.rateFetcher);
  });

  app.get('/rates/sync-runs', { preHandler: guard('ledger.read') }, async (req) =>
    as(req, async (c) => (await c.query('SELECT * FROM rate_sync_run ORDER BY id DESC LIMIT 50')).rows));

  app.get('/settings', { preHandler: guard('ledger.read') }, async (req) =>
    as(req, async (c) => (await c.query('SELECT key, value, status, description FROM app_setting ORDER BY key')).rows));

  // ------------------------------------------------------------ budgets (M01-BUD)
  const budgetLines = z.array(z.object({ accountId: id, amount })).min(1).max(1000);

  app.get('/budgets', { preHandler: guard('ledger.read') }, async (req) => {
    const q = z.object({ projectId: id.optional() }).parse(req.query);
    return as(req, async (c) => (await c.query(
      `SELECT b.id, b.project_id, p.code AS project_code, b.name, b.start_date, b.end_date, b.enforcement, b.status,
              b.created_by, b.approved_by,
              (SELECT coalesce(sum(amount), 0)::numeric(18,2)::text FROM budget_line WHERE budget_id = b.id) AS total
         FROM budget b JOIN project p ON p.id = b.project_id
        WHERE ($1::int IS NULL OR b.project_id = $1)
        ORDER BY b.start_date DESC, p.code`, [q.projectId ?? null])).rows);
  });

  app.post('/budgets', { preHandler: guard('budget.manage') }, async (req, reply) => {
    const b = z.object({
      projectId: id, name: z.string().min(1).max(200), startDate: date, endDate: date,
      enforcement: z.enum(['BLOCK', 'WARN']), lines: budgetLines,
    }).parse(req.body);
    const budgetId = await as(req, async (c) => {
      const bid = (await c.query<{ id: number }>(
        `INSERT INTO budget (project_id, name, start_date, end_date, enforcement, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [b.projectId, b.name, b.startDate, b.endDate, b.enforcement, req.user!.username])).rows[0]!.id;
      for (const l of b.lines) {
        await c.query('INSERT INTO budget_line (budget_id, account_id, amount) VALUES ($1,$2,$3)', [bid, l.accountId, l.amount]);
      }
      return bid;
    });
    return reply.status(201).send({ id: budgetId });
  });

  app.put('/budgets/:id/lines', { preHandler: guard('budget.manage') }, async (req) => {
    const { id: bid } = z.object({ id }).parse(req.params);
    const lines = budgetLines.parse(req.body);
    await as(req, async (c) => {
      const found = (await c.query('SELECT 1 FROM budget WHERE id = $1', [bid])).rowCount;
      if (!found) throw new HttpError(404, 'NOT_FOUND', 'Presupuesto no encontrado');
      await c.query('DELETE FROM budget_line WHERE budget_id = $1', [bid]);
      for (const l of lines) {
        await c.query('INSERT INTO budget_line (budget_id, account_id, amount) VALUES ($1,$2,$3)', [bid, l.accountId, l.amount]);
      }
    });
    return { ok: true };
  });

  const budgetTransition = (permission: string, sql: string) =>
    async (req: FastifyRequest) => {
      await guard(permission)(req);
      const { id: bid } = z.object({ id }).parse(req.params);
      const n = await as(req, async (c) => {
        if (!(await c.query('SELECT 1 FROM budget WHERE id = $1', [bid])).rowCount) {
          throw new HttpError(404, 'NOT_FOUND', 'Presupuesto no encontrado');
        }
        return (await c.query(sql, [bid, req.user!.username])).rowCount;
      });
      if (n !== 1) throw new HttpError(409, 'CONFLICT', 'Estado del presupuesto no permite la operación');
      return { ok: true };
    };
  app.post('/budgets/:id/approve', budgetTransition('budget.approve',
    `UPDATE budget SET status = 'APPROVED', approved_by = $2 WHERE id = $1 AND status = 'DRAFT'`));
  app.post('/budgets/:id/close', budgetTransition('budget.approve',
    `UPDATE budget SET status = 'CLOSED' WHERE id = $1 AND status = 'APPROVED' AND $2::text IS NOT NULL`));

  app.get('/budgets/:id', { preHandler: guard('ledger.read') }, async (req) => {
    const { id: bid } = z.object({ id }).parse(req.params);
    return as(req, async (c) => {
      const budget = (await c.query(
        `SELECT b.*, p.code AS project_code FROM budget b JOIN project p ON p.id = b.project_id WHERE b.id = $1`, [bid])).rows[0];
      if (!budget) throw new HttpError(404, 'NOT_FOUND', 'Presupuesto no encontrado');
      const rows = (await c.query(
        `SELECT account_id, code, name, budgeted::text, executed::text, committed::text, available::text
           FROM budget_execution($1)`, [bid])).rows;
      const alerts = (await c.query(
        `SELECT a.id, a.created_at, a.entry_id, ac.code AS account_code, a.kind, a.requested::text, a.available::text, a.approved_by
           FROM budget_alert a JOIN account ac ON ac.id = a.account_id
          WHERE a.budget_id = $1 ORDER BY a.id DESC`, [bid])).rows;
      return { budget, rows, alerts };
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
