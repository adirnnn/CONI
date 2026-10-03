export interface Config {
  databaseUrl: string;
  /** 32-byte key, base64. Encrypts TOTP secrets at rest. */
  encryptionKey: Buffer;
  cookieSecure: boolean;
  sessionIdleMinutes: number;
  sessionMaxHours: number;
  loginMaxAttempts: number;
  loginLockMinutes: number;
  passwordMinLength: number;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

/**
 * Security defaults are engineering safeguards (docs/05-permisos.md) and can be
 * tightened by CONI's policy without code changes.
 */
export function loadConfig(env = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const keyB64 = env.APP_ENCRYPTION_KEY;
  if (!keyB64) throw new Error('APP_ENCRYPTION_KEY is required');
  const encryptionKey = Buffer.from(keyB64, 'base64');
  if (encryptionKey.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes (base64)');
  return {
    databaseUrl,
    encryptionKey,
    cookieSecure: env.COOKIE_SECURE !== 'false',
    sessionIdleMinutes: int('SESSION_IDLE_MINUTES', 30),
    sessionMaxHours: int('SESSION_MAX_HOURS', 12),
    loginMaxAttempts: int('LOGIN_MAX_ATTEMPTS', 5),
    loginLockMinutes: int('LOGIN_LOCK_MINUTES', 15),
    passwordMinLength: int('PASSWORD_MIN_LENGTH', 12),
  };
}
