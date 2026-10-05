/**
 * Daily BANGUAT synchronization, run by the server's scheduler (cron/systemd timer).
 * Fetches from the day after the last stored official rate (or RATES_START_DATE)
 * through today in America/Guatemala, for every enabled currency with a verified
 * BANGUAT mapping. Idempotent; each run is recorded in rate_sync_run.
 *
 *   DATABASE_URL=... npm run rates:sync -w @coni/api
 */
import pg from 'pg';
import '../db/types.ts';
import { syncRates } from '../integrations/banguat.ts';

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala' }).format(new Date());
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
let failed = false;
try {
  const currencies = (await pool.query<{ code: string; last: string | null }>(
    `SELECT c.code, (SELECT max(rate_date)::text FROM exchange_rate r WHERE r.currency_code = c.code AND r.source = 'BANGUAT') AS last
       FROM currency c WHERE c.enabled AND c.banguat_code IS NOT NULL ORDER BY c.code`)).rows;
  for (const c of currencies) {
    const start = c.last
      ? new Date(Date.parse(c.last) + 86_400_000).toISOString().slice(0, 10)
      : process.env.RATES_START_DATE ?? today;
    if (start > today) { console.log(`${c.code}: up to date (${c.last})`); continue; }
    try {
      const r = await syncRates(pool, c.code, start, today);
      console.log(`${c.code} ${start}..${today}: inserted ${r.inserted}, unchanged ${r.unchanged}, conflicts ${r.conflicts}`);
      if (r.conflicts > 0) failed = true;
    } catch (err) {
      failed = true;
      console.error(`${c.code} ${start}..${today}: ${(err as Error).message}`);
    }
  }
} finally {
  await pool.end();
}
// Non-zero exit lets the scheduler/monitoring alert on failures or conflicts.
process.exitCode = failed ? 1 : 0;
