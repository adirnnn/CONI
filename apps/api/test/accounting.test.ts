import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRangeResponse, type RateFetcher } from '../src/integrations/banguat.ts';
import { withActor } from '../src/db/tx.ts';
import { createHarness } from './harness.ts';

// Chart of accounts, periods, exchange rates and multi-currency pricing
// (M01-COA-001, M01-ACC-003, M01-CUR-001, M01-CUR-002). Expected values are hand-computed.

// Real response captured from BANGUAT on 2026-10-04 (public data).
const FIXTURE = readFileSync(new URL('./fixtures/banguat-rango-2026-09-25_2026-10-01.xml', import.meta.url), 'utf8');

describe('BANGUAT response parsing', () => {
  it('parses one rate per calendar day, weekends included', () => {
    const rates = parseRangeResponse(FIXTURE, 2);
    expect(rates).toHaveLength(7);
    expect(rates[0]).toEqual({ date: '2026-09-25', rate: '7.63682' });
    expect(rates[1]).toEqual({ date: '2026-09-26', rate: '7.63682' }); // Saturday carries Friday's rate
    expect(rates[6]).toEqual({ date: '2026-10-01', rate: '7.64028' });
  });

  it('rejects a response for a different currency', () => {
    expect(() => parseRangeResponse(FIXTURE, 24)).toThrow(/expected 24/);
  });

  it('rejects a truncated response', () => {
    expect(() => parseRangeResponse(FIXTURE.replace('<TotalItems>7</TotalItems>', '<TotalItems>8</TotalItems>'), 2))
      .toThrow(/TotalItems=8/);
  });
});

let fetcherRates = parseRangeResponse(FIXTURE, 2);
let fetchCalls = 0;
const fakeFetcher: RateFetcher = async (code, from, to) => {
  fetchCalls++;
  return fetcherRates.filter((r) => code === 2 && r.date >= from && r.date <= to);
};

let h: Awaited<ReturnType<typeof createHarness>>;
let conta: string; let gerente: string;

const usdEntry = (date: string, amount = '100.00') => ({
  entryDate: date, description: 'Donación en USD (sintética)',
  lines: [
    { accountId: h.ref.account['1102'], currency: 'USD', debit: amount },
    { accountId: h.ref.account['4101'], currency: 'USD', credit: amount, projectId: h.ref.project['P-A'] },
  ],
});

beforeAll(async () => {
  h = await createHarness({ rateFetcher: fakeFetcher });
  await h.createUser('conta', ['CONTADOR'], ['P-A'], { mfa: true });
  await h.createUser('gerente', ['GERENTE_FINANCIERO'], ['P-A'], { mfa: true });
  conta = await h.loginWithMfa('conta');
  gerente = await h.loginWithMfa('gerente');
});
afterAll(async () => { await h?.close(); });

describe('rate synchronization', () => {
  it('stores official rates idempotently and records each run', async () => {
    const first = await h.call('POST', '/rates/sync', conta, { currency: 'USD', from: '2026-09-25', to: '2026-10-01' });
    expect(first.json()).toMatchObject({ inserted: 7, unchanged: 0, conflicts: 0 });
    const again = await h.call('POST', '/rates/sync', conta, { currency: 'USD', from: '2026-09-25', to: '2026-10-01' });
    expect(again.json()).toMatchObject({ inserted: 0, unchanged: 7, conflicts: 0 });
    const runs = (await h.call('GET', '/rates/sync-runs', conta)).json();
    expect(runs.slice(0, 2).map((r: { status: string }) => r.status)).toEqual(['OK', 'OK']);
  });

  it('never overwrites a stored official rate with a different value', async () => {
    fetcherRates = fetcherRates.map((r) => (r.date === '2026-10-01' ? { ...r, rate: '9.99999' } : r));
    const res = await h.call('POST', '/rates/sync', conta, { currency: 'USD', from: '2026-10-01', to: '2026-10-01' });
    expect(res.json()).toMatchObject({ inserted: 0, conflicts: 1 });
    const stored = (await h.call('GET', '/rates?currency=USD&from=2026-10-01&to=2026-10-01', conta)).json();
    expect(stored).toEqual([expect.objectContaining({ rate: '7.640280', source: 'BANGUAT' })]);
    fetcherRates = parseRangeResponse(FIXTURE, 2);
  });

  it('refuses currencies without a verified BANGUAT mapping', async () => {
    await h.pool.query(`INSERT INTO currency (code, name) VALUES ('EUR', 'Euro')`);
    const calls = fetchCalls;
    const res = await h.call('POST', '/rates/sync', conta, { currency: 'EUR', from: '2026-10-01', to: '2026-10-01' });
    expect(res.statusCode).toBe(422);
    expect(fetchCalls).toBe(calls);
  });

  it('requires accounting.config permission', async () => {
    expect((await h.call('POST', '/rates/sync', gerente, { from: '2026-10-01', to: '2026-10-01' })).statusCode).toBe(403);
  });

  it('the application role cannot write rates directly', async () => {
    await expect(withActor(h.pool, 'conta', (c) => c.query(
      `INSERT INTO exchange_rate (currency_code, rate_date, rate, source) VALUES ('USD','2026-10-02',1,'BANGUAT')`)))
      .rejects.toThrow(/row-level security/);
  });
});

describe('multi-currency entries priced by the server', () => {
  it('converts USD at the BANGUAT rate of the entry date', async () => {
    // 100.00 × 7.64028 = 764.028 → 764.03 (HALF_UP, setting still PROPUESTA)
    const created = await h.call('POST', '/journal-entries', conta, usdEntry('2026-10-01'));
    expect(created.statusCode, created.body).toBe(201);
    const { lines } = (await h.call('GET', `/journal-entries/${created.json().id}`, conta)).json();
    expect(lines.map((l: Record<string, string>) => [l.rate, l.rate_source, l.rate_date, l.debit_gtq, l.credit_gtq])).toEqual([
      ['7.640280', 'BANGUAT', '2026-10-01', '764.03', '0.00'],
      ['7.640280', 'BANGUAT', '2026-10-01', '0.00', '764.03'],
    ]);
  });

  it('ignores any rate or GTQ amount sent by the client', async () => {
    const body = usdEntry('2026-10-01', '10.00');
    const tampered = { ...body, lines: body.lines.map((l) => ({ ...l, rate: '1', rateSource: 'FUNCTIONAL', debitGtq: '10.00' })) };
    const id = (await h.call('POST', '/journal-entries', conta, tampered)).json().id;
    const { lines } = (await h.call('GET', `/journal-entries/${id}`, conta)).json();
    expect(lines[0].debit_gtq).toBe('76.40'); // 10 × 7.64028 = 76.4028
  });

  it('blocks an entry when no rate exists for the date', async () => {
    const res = await h.call('POST', '/journal-entries', conta, usdEntry('2026-10-20'));
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/No hay tipo de cambio para USD del 2026-10-20/);
  });

  it('accepts an authorized manual rate with justification, and only from authorized users', async () => {
    const body = { currency: 'USD', date: '2026-10-20', rate: '7.650000', justification: 'Servicio BANGUAT no disponible (prueba)' };
    expect((await h.call('POST', '/rates/manual', conta, body)).statusCode).toBe(403);
    expect((await h.call('POST', '/rates/manual', gerente, { ...body, justification: 'corta' })).statusCode).toBe(400);
    expect((await h.call('POST', '/rates/manual', gerente, body)).statusCode).toBe(201);
    const id = (await h.call('POST', '/journal-entries', conta, usdEntry('2026-10-20'))).json().id;
    const { lines } = (await h.call('GET', `/journal-entries/${id}`, conta)).json();
    // 100.00 × 7.65 = 765.00
    expect([lines[0].rate_source, lines[0].debit_gtq]).toEqual(['MANUAL', '765.00']);
  });

  it('the database rejects a foreign line citing a rate that is not stored', async () => {
    const entry = (await h.pool.query(
      `INSERT INTO journal_entry (entry_date, period_id, description, created_by)
       VALUES ('2026-10-15', $1, 'x', 'test') RETURNING id`, [h.ref.period['2026-10']])).rows[0].id;
    await expect(h.pool.query(
      `INSERT INTO journal_line (entry_id, line_no, account_id, currency_code, debit_tx, rate, rate_source, rate_date, debit_gtq)
       VALUES ($1, 1, $2, 'USD', 1, 8.1, 'BANGUAT', '2026-10-15', 8.1)`, [entry, h.ref.account['1102']]))
      .rejects.toThrow(/no BANGUAT rate/);
  });
});

describe('chart of accounts governance (M01-COA-001)', () => {
  let header: number;

  it('creates a header account and a postable child', async () => {
    const h6 = await h.call('POST', '/accounts', conta, { code: '6', name: 'Otros gastos', type: 'EXPENSE', isPostable: false });
    expect(h6.statusCode, h6.body).toBe(201);
    header = h6.json().id;
    const child = await h.call('POST', '/accounts', conta, { code: '6101', name: 'Otros', type: 'EXPENSE', parentId: header, isPostable: true });
    expect(child.statusCode).toBe(201);
  });

  it('rejects children of postable accounts, type mismatches and codes outside the parent', async () => {
    const postableParent = await h.call('POST', '/accounts', conta, { code: '11019', name: 'x', type: 'ASSET', parentId: h.ref.account['1101'], isPostable: true });
    expect(postableParent.statusCode).toBe(422);
    const typeMismatch = await h.call('POST', '/accounts', conta, { code: '6102', name: 'x', type: 'INCOME', parentId: header, isPostable: true });
    expect(typeMismatch.statusCode).toBe(422);
    const wrongPrefix = await h.call('POST', '/accounts', conta, { code: '7101', name: 'x', type: 'EXPENSE', parentId: header, isPostable: true });
    expect(wrongPrefix.statusCode).toBe(422);
  });

  it('only users with accounting.config can change the catalogue', async () => {
    expect((await h.call('POST', '/accounts', gerente, { code: '6199', name: 'x', type: 'EXPENSE', parentId: header, isPostable: true })).statusCode).toBe(403);
    await expect(withActor(h.pool, 'gerente', (c) => c.query(`UPDATE account SET name = 'x' WHERE code = '1101'`)))
      .resolves.toMatchObject({ rowCount: 0 }); // RLS hides the row from writers without permission
  });

  it('allows renaming but forbids structural changes once an account has movements', async () => {
    expect((await h.call('PATCH', `/accounts/${h.ref.account['1102']}`, conta, { name: 'Bancos USD (renombrada)' })).statusCode).toBe(200);
    await expect(h.pool.query(`UPDATE account SET code = '1199' WHERE id = $1`, [h.ref.account['1102']]))
      .rejects.toThrow(/has movements/);
    await expect(h.pool.query('DELETE FROM account WHERE id = $1', [h.ref.account['1102']])).rejects.toThrow(/deactivate/);
  });

  it('a deactivated account cannot receive new lines', async () => {
    const acc = (await h.call('POST', '/accounts', conta, { code: '6102', name: 'Temporal', type: 'EXPENSE', parentId: header, isPostable: true })).json().id;
    expect((await h.call('PATCH', `/accounts/${acc}`, conta, { active: false })).statusCode).toBe(200);
    const res = await h.call('POST', '/journal-entries', conta, {
      entryDate: '2026-10-15', description: 'x',
      lines: [
        { accountId: acc, currency: 'GTQ', debit: '1.00' },
        { accountId: h.ref.account['1101'], currency: 'GTQ', credit: '1.00' },
      ],
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('period close and reopen', () => {
  let dec: number;
  const gtqEntry = (date: string) => ({
    entryDate: date, description: 'Gasto diciembre',
    lines: [
      { accountId: h.ref.account['5101'], currency: 'GTQ', debit: '50.00', projectId: h.ref.project['P-A'] },
      { accountId: h.ref.account['1101'], currency: 'GTQ', credit: '50.00' },
    ],
  });

  it('creates periods without overlaps', async () => {
    const res = await h.call('POST', '/periods', conta, { code: '2026-12', startDate: '2026-12-01', endDate: '2026-12-31' });
    expect(res.statusCode).toBe(201);
    dec = res.json().id;
    expect((await h.call('POST', '/periods', conta, { code: 'X', startDate: '2026-12-15', endDate: '2027-01-15' })).statusCode).toBe(422);
  });

  it('cannot close a period with pending entries', async () => {
    const id = (await h.call('POST', '/journal-entries', conta, gtqEntry('2026-12-10'))).json().id;
    const res = await h.call('POST', `/periods/${dec}/close`, gerente);
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/1 pending entries/);
    await h.call('POST', `/journal-entries/${id}/approve`, gerente);
    await h.call('POST', `/journal-entries/${id}/post`, conta);
  });

  it('closes, blocks new entries, and reopens only with a recorded reason', async () => {
    expect((await h.call('POST', `/periods/${dec}/close`, conta)).statusCode).toBe(403); // lacks period.close
    expect((await h.call('POST', `/periods/${dec}/close`, gerente)).statusCode).toBe(200);
    expect((await h.call('POST', '/journal-entries', conta, gtqEntry('2026-12-11'))).statusCode).toBe(422);
    expect((await h.call('POST', `/periods/${dec}/reopen`, gerente, { reason: 'corto' })).statusCode).toBe(400);
    const reason = 'Ajuste solicitado por auditoría externa (prueba)';
    expect((await h.call('POST', `/periods/${dec}/reopen`, gerente, { reason })).statusCode).toBe(200);
    const { rows } = await h.pool.query(
      `SELECT actor, data->>'reason' AS reason FROM audit_event WHERE action = 'PERIOD_OPEN' AND entity_id = $1`, [String(dec)]);
    expect(rows).toEqual([{ actor: 'gerente', reason }]);
    expect((await h.call('POST', '/journal-entries', conta, gtqEntry('2026-12-11'))).statusCode).toBe(201);
  });

  it('the application role cannot change period status directly', async () => {
    const r = await withActor(h.pool, 'gerente', (c) => c.query(`UPDATE fiscal_period SET status = 'OPEN' WHERE code = '2026-09'`));
    expect(r.rowCount).toBe(0);
  });

  it('rejects entries with no period for the date', async () => {
    const res = await h.call('POST', '/journal-entries', conta, gtqEntry('2030-01-01'));
    expect(res.statusCode).toBe(422);
  });
});
