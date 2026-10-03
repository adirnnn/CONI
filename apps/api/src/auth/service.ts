import type { Pool } from 'pg';
import * as OTPAuth from 'otpauth';
import type { Config } from '../config.ts';
import { withActor } from '../db/tx.ts';
import { decrypt, encrypt, hashToken, newSessionToken, verifyPassword } from './crypto.ts';

export interface AuthUser {
  username: string;
  fullName: string;
  permissions: Set<string>;
  privileged: Set<string>;
  allProjects: boolean;
  mfaRequired: boolean;
  mfaEnrolled: boolean;
  mfaVerified: boolean;
  mustChangePassword: boolean;
  tokenHash: Buffer;
}

const ANON = 'anonymous';

export class AuthService {
  constructor(private readonly pool: Pool, private readonly config: Config) {}

  /** Returns a session token, or null for any failure (no detail, to avoid enumeration). */
  async login(username: string, password: string, meta: { ip?: string; userAgent?: string }): Promise<string | null> {
    const u = username.trim().toLowerCase();
    return withActor(this.pool, ANON, async (c) => {
      const cred = (await c.query<{ password_hash: string; status: string; locked_until: Date | null }>(
        'SELECT * FROM auth_get_credentials($1)', [u])).rows[0];
      const passwordOk = await verifyPassword(cred?.password_hash, password);
      const locked = cred?.locked_until != null && cred.locked_until > new Date();
      const ok = cred !== undefined && passwordOk && cred.status === 'ACTIVE' && !locked;
      await c.query('SELECT auth_record_login($1, $2, $3, $4)',
        [u, ok, this.config.loginMaxAttempts, this.config.loginLockMinutes]);
      if (!ok) return null;
      const { token, tokenHash } = newSessionToken();
      await c.query(
        `INSERT INTO app_session (token_hash, username, expires_at, ip, user_agent)
         VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
        [tokenHash, u, this.config.sessionMaxHours, meta.ip ?? null, meta.userAgent ?? null]);
      return token;
    });
  }

  async resolve(token: string): Promise<AuthUser | null> {
    const tokenHash = hashToken(token);
    return withActor(this.pool, ANON, async (c) => {
      const s = (await c.query<{
        username: string; full_name: string; all_projects: boolean; mfa_required: boolean;
        mfa_enrolled: boolean; mfa_verified: boolean; must_change_password: boolean;
      }>(
        `UPDATE app_session s SET last_seen_at = now()
           FROM app_user u
          WHERE s.token_hash = $1 AND u.username = s.username AND u.status = 'ACTIVE'
            AND s.revoked_at IS NULL AND s.expires_at > now()
            AND s.last_seen_at > now() - make_interval(mins => $2)
        RETURNING u.username, u.full_name, u.all_projects, u.mfa_required, s.mfa_verified,
                  u.must_change_password,
                  (SELECT totp_secret_enc IS NOT NULL FROM auth_get_credentials(u.username)) AS mfa_enrolled`,
        [tokenHash, this.config.sessionIdleMinutes])).rows[0];
      if (!s) return null;
      const perms = (await c.query<{ code: string; privileged: boolean }>(
        `SELECT DISTINCT p.code, p.privileged FROM user_role ur
           JOIN role_permission rp ON rp.role_code = ur.role_code
           JOIN permission p ON p.code = rp.permission_code
          WHERE ur.username = $1`, [s.username])).rows;
      return {
        username: s.username,
        fullName: s.full_name,
        permissions: new Set(perms.map((p) => p.code)),
        privileged: new Set(perms.filter((p) => p.privileged).map((p) => p.code)),
        allProjects: s.all_projects,
        mfaRequired: s.mfa_required,
        mfaEnrolled: s.mfa_enrolled,
        mfaVerified: s.mfa_verified,
        mustChangePassword: s.must_change_password,
        tokenHash,
      };
    });
  }

  async logout(user: AuthUser): Promise<void> {
    await withActor(this.pool, user.username, (c) =>
      c.query('UPDATE app_session SET revoked_at = now() WHERE token_hash = $1', [user.tokenHash]));
  }

  /** Starts TOTP enrollment; returns the otpauth:// URI to show as a QR code. */
  async enrollTotp(user: AuthUser): Promise<string | null> {
    const secret = new OTPAuth.Secret({ size: 20 });
    const stored = await withActor(this.pool, user.username, async (c) =>
      (await c.query<{ ok: boolean }>('SELECT user_enroll_totp($1) AS ok',
        [encrypt(this.config.encryptionKey, secret.base32)])).rows[0]!.ok);
    if (!stored) return null;
    return this.totp(user.username, secret).toString();
  }

  async verifyTotp(user: AuthUser, code: string): Promise<boolean> {
    return withActor(this.pool, user.username, async (c) => {
      const enc = (await c.query<{ totp_secret_enc: string | null }>(
        'SELECT totp_secret_enc FROM auth_get_credentials($1)', [user.username])).rows[0]?.totp_secret_enc;
      if (!enc) return false;
      const secret = OTPAuth.Secret.fromBase32(decrypt(this.config.encryptionKey, enc));
      const ok = this.totp(user.username, secret).validate({ token: code, window: 1 }) !== null;
      await c.query(`INSERT INTO audit_event (actor, action, entity_type, entity_id, hash)
                     VALUES ($1, $2, 'app_user', $1, ''::bytea)`, [user.username, ok ? 'MFA_OK' : 'MFA_FAILED']);
      if (ok) {
        await c.query('UPDATE app_session SET mfa_verified = true WHERE token_hash = $1', [user.tokenHash]);
      } else {
        await c.query('SELECT auth_record_login($1, false, $2, $3)',
          [user.username, this.config.loginMaxAttempts, this.config.loginLockMinutes]);
      }
      return ok;
    });
  }

  private totp(username: string, secret: OTPAuth.Secret): OTPAuth.TOTP {
    return new OTPAuth.TOTP({ issuer: 'CONI', label: username, secret, digits: 6, period: 30, algorithm: 'SHA1' });
  }
}
