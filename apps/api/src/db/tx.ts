import type { Pool, PoolClient } from 'pg';

export interface TxOptions {
  /** Run as the restricted application role so row-level security applies. Default true. */
  restricted?: boolean;
}

/**
 * Runs `fn` in a transaction with `app.user_id` set to `actor` for auditing and
 * row-level security. Every request-scoped database access goes through here.
 */
export async function withActor<T>(
  pool: Pool, actor: string, fn: (client: PoolClient) => Promise<T>, opts: TxOptions = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (opts.restricted ?? true) await client.query('SET LOCAL ROLE coni_app');
    await client.query("SELECT set_config('app.user_id', $1, true)", [actor]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
