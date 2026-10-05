import type { Pool } from 'pg';

/**
 * BANGUAT reference exchange rate (docs/08-integraciones.md, INT-BANGUAT).
 * Public SOAP service; verified 2026-10-04:
 *  - operation TipoCambioRangoMoneda(fechainit, fechafin, moneda) with dd/mm/yyyy dates
 *  - one <Var> per calendar day, weekends and holidays included
 *  - USD is moneda 2, quoted in GTQ with up to 5 decimals; venta = compra
 */
export const BANGUAT_URL = 'https://www.banguat.gob.gt/variables/ws/TipoCambio.asmx';

export interface DailyRate { date: string; rate: string }
export type RateFetcher = (banguatCode: number, from: string, to: string) => Promise<DailyRate[]>;

const toDmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const toIso = (dmy: string) => `${dmy.slice(6, 10)}-${dmy.slice(3, 5)}-${dmy.slice(0, 2)}`;

export function parseRangeResponse(xml: string, banguatCode: number): DailyRate[] {
  const out: DailyRate[] = [];
  for (const m of xml.matchAll(/<Var>([\s\S]*?)<\/Var>/g)) {
    const body = m[1]!;
    const field = (name: string) => body.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]?.trim();
    const moneda = Number(field('moneda'));
    const fecha = field('fecha');
    const venta = field('venta');
    const compra = field('compra');
    if (moneda !== banguatCode) throw new Error(`BANGUAT returned currency ${moneda}, expected ${banguatCode}`);
    if (!fecha || !/^\d{2}\/\d{2}\/\d{4}$/.test(fecha)) throw new Error(`BANGUAT returned invalid date "${fecha}"`);
    if (!venta || !/^\d{1,6}(\.\d{1,6})?$/.test(venta)) throw new Error(`BANGUAT returned invalid rate "${venta}"`);
    // The reference rate is a single value; a buy/sell spread would need a policy decision.
    if (compra !== venta) throw new Error(`BANGUAT buy (${compra}) and sell (${venta}) differ on ${fecha}`);
    out.push({ date: toIso(fecha), rate: venta });
  }
  const total = xml.match(/<TotalItems>(\d+)<\/TotalItems>/)?.[1];
  if (total !== undefined && Number(total) !== out.length) {
    throw new Error(`BANGUAT TotalItems=${total} but parsed ${out.length} rates`);
  }
  return out;
}

export const fetchBanguat: RateFetcher = async (banguatCode, from, to) => {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
<TipoCambioRangoMoneda xmlns="http://www.banguat.gob.gt/variables/ws/">
<fechainit>${toDmy(from)}</fechainit><fechafin>${toDmy(to)}</fechafin><moneda>${banguatCode}</moneda>
</TipoCambioRangoMoneda></soap:Body></soap:Envelope>`;
  const res = await fetch(BANGUAT_URL, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset=utf-8',
      soapaction: '"http://www.banguat.gob.gt/variables/ws/TipoCambioRangoMoneda"',
    },
    body: envelope,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`BANGUAT HTTP ${res.status}`);
  return parseRangeResponse(await res.text(), banguatCode);
};

export class RateSyncError extends Error {}

export interface SyncResult { runId: string; inserted: number; unchanged: number; conflicts: number }

/**
 * Stores official rates for a currency and range. Idempotent: existing equal
 * rates are left alone; a different value for an existing date is NOT
 * overwritten but counted as a conflict for review. Runs as the database owner
 * (scheduled job or permission-checked endpoint).
 */
export async function syncRates(
  pool: Pool, currency: string, from: string, to: string, fetcher: RateFetcher = fetchBanguat,
): Promise<SyncResult> {
  const c = await pool.connect();
  try {
    const ccy = (await c.query<{ banguat_code: number | null }>(
      'SELECT banguat_code FROM currency WHERE code = $1 AND enabled', [currency])).rows[0];
    if (!ccy?.banguat_code) throw new RateSyncError(`La moneda ${currency} no tiene correspondencia BANGUAT verificada`);
    const runId = (await c.query<{ id: string }>(
      'INSERT INTO rate_sync_run (currency_code, date_from, date_to) VALUES ($1,$2,$3) RETURNING id',
      [currency, from, to])).rows[0]!.id;
    try {
      const rates = await fetcher(ccy.banguat_code, from, to);
      let inserted = 0, unchanged = 0, conflicts = 0;
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.user_id', 'system:banguat-sync', true)");
      for (const r of rates) {
        const ins = await c.query(
          `INSERT INTO exchange_rate (currency_code, rate_date, rate, source) VALUES ($1,$2,$3,'BANGUAT')
           ON CONFLICT (currency_code, rate_date, source) DO NOTHING`, [currency, r.date, r.rate]);
        if (ins.rowCount === 1) { inserted++; continue; }
        const same = (await c.query(
          `SELECT 1 FROM exchange_rate WHERE currency_code = $1 AND rate_date = $2 AND source = 'BANGUAT' AND rate = $3`,
          [currency, r.date, r.rate])).rowCount === 1;
        if (same) unchanged++; else conflicts++;
      }
      await c.query(
        `UPDATE rate_sync_run SET finished_at = now(), inserted = $2, unchanged = $3, conflicts = $4, status = 'OK'
          WHERE id = $1`, [runId, inserted, unchanged, conflicts]);
      await c.query('COMMIT');
      return { runId, inserted, unchanged, conflicts };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.query(`UPDATE rate_sync_run SET finished_at = now(), status = 'ERROR', error = $2 WHERE id = $1`,
        [runId, (err as Error).message.slice(0, 1000)]);
      throw err;
    }
  } finally {
    c.release();
  }
}
