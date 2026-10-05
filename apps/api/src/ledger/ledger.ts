import { toFunctional, type RoundingMode } from '@coni/shared';
import type { PoolClient } from 'pg';

/**
 * Ledger service. Business invariants are enforced by the database
 * (migrations/001_ledger_core.sql); this layer sequences the operations.
 * Every function expects to run inside `withActor` (db/tx.ts), which sets the
 * acting user and the transaction.
 */

export interface NewLine {
  accountId: number;
  currency: string;
  debit?: string;
  credit?: string;
  rate: string;
  rateSource: 'FUNCTIONAL' | 'BANGUAT' | 'MANUAL';
  rateDate: string;
  debitGtq?: string;
  creditGtq?: string;
  projectId?: number | null;
  fundId?: number | null;
  donorId?: number | null;
  agreementId?: number | null;
  memo?: string;
}

export interface NewEntry {
  entryDate: string;
  periodId: number;
  description: string;
  createdBy: string;
  source?: { type: string; id: string; purpose?: string };
  lines: NewLine[];
}

export class LedgerError extends Error {
  constructor(message: string, readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'RULE') {
    super(message);
  }
}

async function insertLines(client: PoolClient, entryId: string, lines: NewLine[]): Promise<void> {
  let lineNo = 1;
  for (const l of lines) {
    await client.query(
      `INSERT INTO journal_line (entry_id, line_no, account_id, currency_code, debit_tx, credit_tx,
         rate, rate_source, rate_date, debit_gtq, credit_gtq, project_id, fund_id, donor_id, agreement_id, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        entryId, lineNo++, l.accountId, l.currency, l.debit ?? '0', l.credit ?? '0',
        l.rate, l.rateSource, l.rateDate,
        l.debitGtq ?? (l.rateSource === 'FUNCTIONAL' ? l.debit ?? '0' : '0'),
        l.creditGtq ?? (l.rateSource === 'FUNCTIONAL' ? l.credit ?? '0' : '0'),
        l.projectId ?? null, l.fundId ?? null, l.donorId ?? null, l.agreementId ?? null, l.memo ?? null,
      ],
    );
  }
}

export async function createEntry(client: PoolClient, e: NewEntry): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entry (entry_date, period_id, description, created_by, source_type, source_id, source_purpose)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [e.entryDate, e.periodId, e.description, e.createdBy,
     e.source?.type ?? 'MANUAL', e.source?.id ?? null, e.source?.purpose ?? 'MAIN'],
  );
  const id = rows[0]!.id;
  await insertLines(client, id, e.lines);
  return id;
}

/**
 * A user may act on an entry only if they can see every one of its lines.
 * Under RLS hidden lines simply do not appear, so the visible count is compared
 * with the true count from `entry_line_count` (SECURITY DEFINER).
 */
async function assertFullVisibility(client: PoolClient, entryId: string): Promise<void> {
  const { rows } = await client.query<{ visible: string; total: string | null }>(
    `SELECT count(*) AS visible, (SELECT entry_line_count($1)) AS total
       FROM journal_line WHERE entry_id = $1`, [entryId]);
  const r = rows[0]!;
  if (r.total === null) throw new LedgerError(`Entry ${entryId} not found`, 'NOT_FOUND');
  if (r.visible !== r.total) {
    throw new LedgerError(`Entry ${entryId} includes projects outside your assignment`, 'FORBIDDEN');
  }
}

async function transition(
  client: PoolClient, entryId: string, sql: string, params: unknown[], expected: string,
): Promise<void> {
  const exists = await client.query('SELECT 1 FROM journal_entry WHERE id = $1', [entryId]);
  if (exists.rowCount === 0) throw new LedgerError(`Entry ${entryId} not found`, 'NOT_FOUND');
  await assertFullVisibility(client, entryId);
  const r = await client.query(sql, params);
  if (r.rowCount !== 1) throw new LedgerError(`Entry ${entryId} is not ${expected}`, 'CONFLICT');
}

export async function approveEntry(client: PoolClient, entryId: string, approver: string): Promise<void> {
  await transition(client, entryId,
    `UPDATE journal_entry SET status = 'APPROVED', approved_by = $2 WHERE id = $1 AND status = 'DRAFT'`,
    [entryId, approver], 'DRAFT');
}

export async function postEntry(client: PoolClient, entryId: string, poster: string): Promise<void> {
  await transition(client, entryId,
    `UPDATE journal_entry SET status = 'POSTED', posted_by = $2
      WHERE id = $1 AND status = 'APPROVED' AND reverses_entry_id IS NULL`,
    [entryId, poster], 'APPROVED');
}

/**
 * Creates a mirror entry (debits↔credits) dated in an open period and returns
 * its id as a DRAFT. It is then approved and posted with `postReversal`, which
 * marks the original as REVERSED in the same transaction.
 */
export async function draftReversal(
  client: PoolClient, originalId: string, entryDate: string, periodId: number, actor: string,
): Promise<string> {
  await assertFullVisibility(client, originalId);
  const orig = await client.query<{ status: string; description: string }>(
    'SELECT status, description FROM journal_entry WHERE id = $1 FOR UPDATE', [originalId]);
  if (orig.rows[0]?.status !== 'POSTED') throw new LedgerError(`Entry ${originalId} is not POSTED`, 'CONFLICT');
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entry (entry_date, period_id, description, created_by, source_type, source_id, source_purpose, reverses_entry_id)
     VALUES ($1,$2,$3,$4,'REVERSAL',$5,'MAIN',$6) RETURNING id`,
    [entryDate, periodId, `Reversión: ${orig.rows[0].description}`, actor, originalId, originalId],
  );
  const id = rows[0]!.id;
  await client.query(
    `INSERT INTO journal_line (entry_id, line_no, account_id, currency_code, debit_tx, credit_tx, rate,
       rate_source, rate_date, debit_gtq, credit_gtq, project_id, fund_id, donor_id, agreement_id, memo)
     SELECT $2, line_no, account_id, currency_code, credit_tx, debit_tx, rate,
            rate_source, rate_date, credit_gtq, debit_gtq, project_id, fund_id, donor_id, agreement_id, memo
       FROM journal_line WHERE entry_id = $1`,
    [originalId, id],
  );
  return id;
}

export async function postReversal(client: PoolClient, reversalId: string, poster: string): Promise<void> {
  await assertFullVisibility(client, reversalId);
  const r = await client.query<{ reverses_entry_id: string | null }>(
    `UPDATE journal_entry SET status = 'POSTED', posted_by = $2
      WHERE id = $1 AND status = 'APPROVED' AND reverses_entry_id IS NOT NULL RETURNING reverses_entry_id`,
    [reversalId, poster],
  );
  const originalId = r.rows[0]?.reverses_entry_id;
  if (!originalId) throw new LedgerError(`Entry ${reversalId} is not an APPROVED reversal`, 'CONFLICT');
  const u = await client.query(
    `UPDATE journal_entry SET status = 'REVERSED' WHERE id = $1 AND status = 'POSTED'`, [originalId]);
  if (u.rowCount !== 1) throw new LedgerError(`Original entry ${originalId} is not POSTED`, 'CONFLICT');
}

export interface TrialBalanceRow { code: string; name: string; debit: string; credit: string }

/** Trial balance of POSTED/REVERSED entries; scoped by RLS and optionally by project. */
export async function trialBalance(
  client: PoolClient, opts: { from: string; to: string; projectId?: number },
): Promise<TrialBalanceRow[]> {
  const { rows } = await client.query<TrialBalanceRow>(
    `SELECT a.code, a.name, sum(l.debit_gtq)::numeric(18,2)::text AS debit, sum(l.credit_gtq)::numeric(18,2)::text AS credit
       FROM journal_line l
       JOIN journal_entry e ON e.id = l.entry_id
       JOIN account a ON a.id = l.account_id
      WHERE e.status IN ('POSTED', 'REVERSED') AND e.entry_date BETWEEN $1 AND $2
        AND ($3::int IS NULL OR l.project_id = $3)
      GROUP BY a.code, a.name ORDER BY a.code`,
    [opts.from, opts.to, opts.projectId ?? null],
  );
  return rows;
}

export interface InputLine {
  accountId: number;
  currency: string;
  debit?: string;
  credit?: string;
  projectId?: number | null;
  fundId?: number | null;
  donorId?: number | null;
  agreementId?: number | null;
  memo?: string;
}

/** Period containing `date`, or a NOT_FOUND error. */
export async function periodFor(client: PoolClient, date: string): Promise<number> {
  const p = (await client.query<{ id: number }>(
    'SELECT id FROM fiscal_period WHERE $1::date BETWEEN start_date AND end_date', [date])).rows[0];
  if (!p) throw new LedgerError(`No hay periodo contable para la fecha ${date}`, 'RULE');
  return p.id;
}

/**
 * Prices input lines on the server: GTQ lines at rate 1; foreign lines at the
 * applicable stored rate for the entry date (BANGUAT, else authorized manual),
 * converted with the configured rounding mode. A missing rate blocks the entry.
 */
export async function priceLines(client: PoolClient, entryDate: string, lines: InputLine[]): Promise<NewLine[]> {
  const rounding = (await client.query<{ value: RoundingMode }>(
    "SELECT value FROM app_setting WHERE key = 'money.rounding'")).rows[0]?.value;
  if (rounding !== 'HALF_UP' && rounding !== 'HALF_EVEN') throw new Error('money.rounding is not configured');
  const functional = (await client.query<{ code: string }>(
    'SELECT code FROM currency WHERE is_functional')).rows[0]?.code;
  const rates = new Map<string, { rate: string; source: 'BANGUAT' | 'MANUAL'; rate_date: string }>();

  const out: NewLine[] = [];
  for (const l of lines) {
    if (l.currency === functional) {
      out.push({ ...l, rate: '1', rateSource: 'FUNCTIONAL', rateDate: entryDate });
      continue;
    }
    if (!rates.has(l.currency)) {
      const r = (await client.query<{ rate: string; source: 'BANGUAT' | 'MANUAL'; rate_date: string }>(
        'SELECT rate::text, source, rate_date::text FROM rate_for($1, $2)', [l.currency, entryDate])).rows[0];
      if (!r) {
        throw new LedgerError(
          `No hay tipo de cambio para ${l.currency} del ${entryDate}. Sincronice BANGUAT o registre una tasa manual autorizada.`,
          'RULE');
      }
      rates.set(l.currency, r);
    }
    const r = rates.get(l.currency)!;
    out.push({
      ...l, rate: r.rate, rateSource: r.source, rateDate: r.rate_date,
      debitGtq: l.debit ? toFunctional(l.debit, r.rate, rounding) : undefined,
      creditGtq: l.credit ? toFunctional(l.credit, r.rate, rounding) : undefined,
    });
  }
  return out;
}
