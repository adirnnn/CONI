import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { freshDatabase, seedSynthetic } from './db.ts';
import { withActor } from '../src/db/tx.ts';
import {
  approveEntry, createEntry, draftReversal, postEntry, postReversal, type NewLine,
} from '../src/ledger/ledger.ts';

// Integration tests against a real PostgreSQL (docker compose `db`).
// Expected amounts are fixed values worked out by hand, not recomputed by the code under test.

let pool: pg.Pool;
let ref: Awaited<ReturnType<typeof seedSynthetic>>;
const OCT = '2026-10-15';

const gtq = (accountId: number, side: 'debit' | 'credit', amount: string, projectId?: number): NewLine => ({
  accountId, currency: 'GTQ', [side]: amount, rate: '1', rateSource: 'FUNCTIONAL', rateDate: OCT, projectId,
});

async function balanced(desc: string, amount = '1000.00', source?: { type: string; id: string }) {
  return run((c) => createEntry(c, {
    entryDate: OCT, periodId: ref.period['2026-10']!, description: desc, createdBy: 'u.contador', source,
    lines: [gtq(ref.account['5101']!, 'debit', amount, ref.project['P-A']), gtq(ref.account['1101']!, 'credit', amount)],
  }), 'u.contador');
}

// Invariant tests run as the database owner (no RLS) to isolate the ledger rules.
function run<T>(fn: (c: pg.PoolClient) => Promise<T>, actor = 'u.contador'): Promise<T> {
  return withActor(pool, actor, fn, { restricted: false });
}

async function approveAndPost(id: string) {
  await run((c) => approveEntry(c, id, 'u.gerente'), 'u.gerente');
  await run((c) => postEntry(c, id, 'u.gerente'), 'u.gerente');
}

beforeAll(async () => {
  pool = await freshDatabase();
  ref = await seedSynthetic(pool);
});
afterAll(async () => { await pool?.end(); });

describe('journal posting invariants (M01-ACC-003)', () => {
  it('posts a balanced entry', async () => {
    const id = await balanced('Compra de insumos');
    await approveAndPost(id);
    const { rows } = await pool.query('SELECT status, posted_at FROM journal_entry WHERE id = $1', [id]);
    expect(rows[0].status).toBe('POSTED');
    expect(rows[0].posted_at).not.toBeNull();
  });

  it('rejects approving an unbalanced entry', async () => {
    const id = await run((c) => createEntry(c, {
      entryDate: OCT, periodId: ref.period['2026-10']!, description: 'Descuadrada', createdBy: 'u.contador',
      lines: [gtq(ref.account['5101']!, 'debit', '100.00', ref.project['P-A']), gtq(ref.account['1101']!, 'credit', '99.99')],
    }));
    await expect(run((c) => approveEntry(c, id, 'u.gerente'))).rejects.toThrow(/unbalanced in GTQ by 0.01/);
  });

  it('rejects an entry with a single line', async () => {
    const id = await run((c) => createEntry(c, {
      entryDate: OCT, periodId: ref.period['2026-10']!, description: 'Una línea', createdBy: 'u.contador',
      lines: [gtq(ref.account['1101']!, 'debit', '10.00')],
    }));
    await expect(run((c) => approveEntry(c, id, 'u.gerente'))).rejects.toThrow(/at least two lines/);
  });

  it('forbids the creator from approving their own entry', async () => {
    const id = await balanced('Autoaprobación');
    await expect(run((c) => approveEntry(c, id, 'u.contador'))).rejects.toThrow(/creator cannot approve/);
  });

  it('cannot post without approval', async () => {
    const id = await balanced('Sin aprobar');
    await expect(run((c) => postEntry(c, id, 'u.gerente'))).rejects.toThrow(/not APPROVED/);
  });

  it('rejects a line on an account that requires a project when none is given', async () => {
    await expect(run((c) => createEntry(c, {
      entryDate: OCT, periodId: ref.period['2026-10']!, description: 'Sin proyecto', createdBy: 'u.contador',
      lines: [gtq(ref.account['5101']!, 'debit', '5.00'), gtq(ref.account['1101']!, 'credit', '5.00')],
    }))).rejects.toThrow(/requires a project/);
  });

  it('rejects posting to a non-postable (header) account', async () => {
    await expect(run((c) => createEntry(c, {
      entryDate: OCT, periodId: ref.period['2026-10']!, description: 'Cuenta de mayor', createdBy: 'u.contador',
      lines: [gtq(ref.account['1']!, 'debit', '5.00'), gtq(ref.account['1101']!, 'credit', '5.00')],
    }))).rejects.toThrow(/not postable/);
  });
});

describe('immutability of posted entries', () => {
  let postedId: string;
  beforeAll(async () => {
    postedId = await balanced('Inmutable');
    await approveAndPost(postedId);
  });

  it('rejects updating a posted line', async () => {
    await expect(pool.query('UPDATE journal_line SET debit_tx = 1, debit_gtq = 1 WHERE entry_id = $1 AND line_no = 1', [postedId]))
      .rejects.toThrow(/POSTED entry cannot be changed/);
  });

  it('rejects adding a line to a posted entry', async () => {
    await expect(pool.query(
      `INSERT INTO journal_line (entry_id, line_no, account_id, currency_code, debit_tx, rate, rate_source, rate_date, debit_gtq)
       VALUES ($1, 99, $2, 'GTQ', 1, 1, 'FUNCTIONAL', $3, 1)`, [postedId, ref.account['1101'], OCT],
    )).rejects.toThrow(/cannot be changed/);
  });

  it('rejects deleting a posted entry or its lines', async () => {
    await expect(pool.query('DELETE FROM journal_line WHERE entry_id = $1', [postedId])).rejects.toThrow(/cannot be changed/);
    await expect(pool.query('DELETE FROM journal_entry WHERE id = $1', [postedId])).rejects.toThrow(/only DRAFT/);
  });

  it('rejects editing posted header fields', async () => {
    await expect(pool.query(`UPDATE journal_entry SET description = 'x' WHERE id = $1`, [postedId]))
      .rejects.toThrow(/immutable/);
  });

  it('rejects marking REVERSED without a reversal changing other fields', async () => {
    await expect(pool.query(`UPDATE journal_entry SET status = 'REVERSED', description = 'x' WHERE id = $1`, [postedId]))
      .rejects.toThrow(/immutable/);
  });
});

describe('periods', () => {
  it('rejects an entry dated in a closed period', async () => {
    await expect(run((c) => createEntry(c, {
      entryDate: '2026-09-20', periodId: ref.period['2026-09']!, description: 'Periodo cerrado', createdBy: 'u.contador',
      lines: [gtq(ref.account['1101']!, 'debit', '1.00'), gtq(ref.account['1102']!, 'credit', '1.00')],
    }))).rejects.toThrow(/period 2026-09 is closed/);
  });

  it('rejects an entry date outside its period', async () => {
    await expect(run((c) => createEntry(c, {
      entryDate: '2026-11-01', periodId: ref.period['2026-10']!, description: 'Fuera', createdBy: 'u.contador',
      lines: [],
    }))).rejects.toThrow(/outside period/);
  });

  it('rejects overlapping periods', async () => {
    await expect(pool.query(`INSERT INTO fiscal_period (code, start_date, end_date) VALUES ('X','2026-10-15','2026-11-15')`))
      .rejects.toThrow(/conflicting key|exclusion/);
  });
});

describe('reversal', () => {
  it('reverses a posted entry so balances net to zero', async () => {
    const id = await balanced('A revertir', '250.00', { type: 'TEST', id: 'rev-1' });
    await approveAndPost(id);
    const revId = await run((c) => draftReversal(c, id, OCT, ref.period['2026-10']!, 'u.contador'));
    await run((c) => approveEntry(c, revId, 'u.gerente'));
    await run((c) => postReversal(c, revId, 'u.gerente'));

    const { rows } = await pool.query(
      `SELECT a.code, sum(l.debit_gtq) - sum(l.credit_gtq) AS net
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id IN ($1, $2) GROUP BY a.code ORDER BY a.code`, [id, revId]);
    expect(rows).toEqual([{ code: '1101', net: '0.00' }, { code: '5101', net: '0.00' }]);
    const st = await pool.query('SELECT id, status FROM journal_entry WHERE id IN ($1,$2) ORDER BY id', [id, revId]);
    expect(st.rows.map((r) => r.status)).toEqual(['REVERSED', 'POSTED']);
  });

  it('cannot reverse the same entry twice', async () => {
    const id = await balanced('Doble reversión', '10.00');
    await approveAndPost(id);
    await run((c) => draftReversal(c, id, OCT, ref.period['2026-10']!, 'u.contador'));
    await expect(run((c) => draftReversal(c, id, OCT, ref.period['2026-10']!, 'u.contador')))
      .rejects.toThrow(/duplicate key/);
  });
});

describe('duplicate prevention (SG-002)', () => {
  it('rejects a second entry for the same source document and purpose', async () => {
    await balanced('Factura 1', '10.00', { type: 'AP_INVOICE', id: 'INV-001' });
    await expect(balanced('Factura 1 otra vez', '10.00', { type: 'AP_INVOICE', id: 'INV-001' }))
      .rejects.toThrow(/duplicate key/);
  });
});

describe('multi-currency (M01-CUR-001)', () => {
  it('posts a USD receipt with its rate and GTQ equivalent', async () => {
    // USD 100.00 at 7.700000 = GTQ 770.00
    const id = await run((c) => createEntry(c, {
      entryDate: OCT, periodId: ref.period['2026-10']!, description: 'Donación USD', createdBy: 'u.contador',
      lines: [
        { accountId: ref.account['1102']!, currency: 'USD', debit: '100.00', rate: '7.700000', rateSource: 'BANGUAT', rateDate: OCT, debitGtq: '770.00' },
        { accountId: ref.account['4101']!, currency: 'USD', credit: '100.00', rate: '7.700000', rateSource: 'BANGUAT', rateDate: OCT, creditGtq: '770.00', projectId: ref.project['P-B'] },
      ],
    }));
    await approveAndPost(id);
    const { rows } = await pool.query('SELECT sum(debit_gtq) d, sum(credit_gtq) c FROM journal_line WHERE entry_id = $1', [id]);
    expect(rows[0]).toEqual({ d: '770.00', c: '770.00' });
  });

  it('rejects a foreign-currency line that claims the functional rate', async () => {
    await expect(run((c) => createEntry(c, {
      entryDate: OCT, periodId: ref.period['2026-10']!, description: 'Tasa inválida', createdBy: 'u.contador',
      lines: [{ accountId: ref.account['1102']!, currency: 'USD', debit: '1.00', rate: '1', rateSource: 'FUNCTIONAL', rateDate: OCT }],
    }))).rejects.toThrow(/needs a BANGUAT or MANUAL rate/);
  });

  it('rejects a GTQ line whose GTQ amount differs from its transaction amount', async () => {
    await expect(run((c) => createEntry(c, {
      entryDate: OCT, periodId: ref.period['2026-10']!, description: 'GTQ inconsistente', createdBy: 'u.contador',
      lines: [{ accountId: ref.account['1101']!, currency: 'GTQ', debit: '1.00', debitGtq: '2.00', rate: '1', rateSource: 'FUNCTIONAL', rateDate: OCT }],
    }))).rejects.toThrow(/functional-currency line/);
  });

  it('requires justification and approver for a manual rate', async () => {
    await expect(pool.query(`INSERT INTO exchange_rate (currency_code, rate_date, rate, source) VALUES ('USD', $1, 7.7, 'MANUAL')`, [OCT]))
      .rejects.toThrow(/check constraint/);
  });
});

describe('audit trail (M07-AUD-001)', () => {
  it('records the acting user for ledger changes', async () => {
    const id = await balanced('Auditada');
    const { rows } = await pool.query(
      `SELECT actor, action FROM audit_event WHERE entity_type = 'journal_entry' AND entity_id = $1 ORDER BY id`, [String(id)]);
    expect(rows[0]).toEqual({ actor: 'u.contador', action: 'INSERT' });
  });

  it('rejects UPDATE, DELETE and TRUNCATE on the audit table', async () => {
    await expect(pool.query(`UPDATE audit_event SET actor = 'x' WHERE id = 1`)).rejects.toThrow(/not allowed/);
    await expect(pool.query('DELETE FROM audit_event WHERE id = 1')).rejects.toThrow(/not allowed/);
    await expect(pool.query('TRUNCATE audit_event')).rejects.toThrow(/not allowed/);
  });

  it('verifies the hash chain and detects tampering by a privileged user', async () => {
    expect((await pool.query('SELECT audit_verify_chain() AS broken')).rows[0].broken).toBeNull();

    // Simulate a superuser bypassing triggers — the documented residual risk.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`UPDATE audit_event SET actor = 'intruso' WHERE id = 3`);
      const broken = (await c.query('SELECT audit_verify_chain() AS broken')).rows[0].broken;
      expect(broken).toBe('3');
      await c.query('ROLLBACK');
    } finally { c.release(); }
  });

  it('the application role cannot update or delete audit rows', async () => {
    const { rows } = await pool.query(
      `SELECT has_table_privilege('coni_app','audit_event','UPDATE') u,
              has_table_privilege('coni_app','audit_event','DELETE') d,
              has_table_privilege('coni_app','audit_event','INSERT') i`);
    expect(rows[0]).toEqual({ u: false, d: false, i: true });
  });
});
