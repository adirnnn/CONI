import pg from 'pg';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
const app = buildApp({ pool, config });
const port = Number.parseInt(process.env.PORT ?? '3000', 10);

await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
console.log(`API listening on ${port}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
