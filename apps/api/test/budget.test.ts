import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db/tx.ts';
import { createHarness } from './harness.ts';

// Budgets, ceilings and overspend control (M01-BUD-001/002/003).
// Every expected amount below is worked out by hand from the inputs of each test.

let h: Awaited<ReturnType<typeof createHarness>>;
let conta: string; let ger1: string; let ger2: string; let gerB: string;
const acc: Record<string, number> = {};
let budgetA: number; let budgetB: number;

const expense = (project: string, amount: string, account = '5101', date = '2026-10-15') => ({
  entryDate: date, description: `Gasto ${project} ${account} ${amount}`,
  lines: [
    { accountId: acc[account], currency: 'GTQ', debit: amount, projectId: h.ref.project[project] },
    { accountId: acc['1101'], currency: 'GTQ', credit: amount },
  ],
});
const draft = async (project: string, amount: string, account = '5101') => {
  const res = await h.call('POST', '/journal-entries', conta, expense(project, amount, account));
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().id as string;
};

beforeAll(async () => {
  h = await createHarness();
  await h.pool.query(`
    INSERT INTO account (code, name, type, is_postable, requires_project) VALUES
      ('5102', 'Viáticos (sintética)', 'EXPENSE', true, true),
      ('5103', 'Gasto no presupuestado (sintética)', 'EXPENSE', true, true)`);
  Object.assign(acc, Object.fromEntries((await h.pool.query('SELECT code, id FROM account')).rows.map((r) => [r.code, r.id])));
  await h.createUser('conta', ['CONTADOR'], ['P-A', 'P-B'], { mfa: true });
  await h.createUser('ger1', ['GERENTE_FINANCIERO'], ['P-A'], { mfa: true });
  await h.createUser('ger2', ['GERENTE_FINANCIERO'], ['P-A'], { mfa: true });
  await h.createUser('gerb', ['GERENTE_FINANCIERO'], ['P-B'], { mfa: true });
  [conta, ger1, ger2, gerB] = (await Promise.all(['conta', 'ger1', 'ger2', 'gerb'].map((u) => h.loginWithMfa(u)))) as [string, string, string, string];
});
afterAll(async () => { await h?.close(); });

describe('budget lifecycle', () => {
  it('rejects non-expense accounts', async () => {
    const res = await h.call('POST', '/budgets', conta, {
      projectId: h.ref.project['P-A'], name: 'x', startDate: '2026-10-01', endDate: '2026-12-31', enforcement: 'BLOCK',
      lines: [{ accountId: acc['4101'], amount: '10.00' }],
    });
    expect(res.statusCode).toBe(422);
  });

  it('creates a draft and has it approved by a different, authorized user', async () => {
    const res = await h.call('POST', '/budgets', conta, {
      projectId: h.ref.project['P-A'], name: 'Presupuesto P-A Q4', startDate: '2026-10-01', endDate: '2026-12-31',
      enforcement: 'BLOCK',
      lines: [{ accountId: acc['5101'], amount: '1000.00' }, { accountId: acc['5102'], amount: '100.00' }],
    });
    expect(res.statusCode, res.body).toBe(201);
    budgetA = res.json().id;
    expect((await h.call('POST', `/budgets/${budgetA}/approve`, conta)).statusCode).toBe(403); // lacks budget.approve
    expect((await h.call('POST', `/budgets/${budgetA}/approve`, ger1)).statusCode).toBe(200);
  });

  it('the database refuses self-approval of a budget', async () => {
    const bid = (await h.pool.query(
      `INSERT INTO budget (project_id, name, start_date, end_date, enforcement, created_by)
       VALUES ($1, 'x', '2027-01-01', '2027-01-31', 'WARN', 'alguien') RETURNING id`, [h.ref.project['P-A']])).rows[0].id;
    await h.pool.query('INSERT INTO budget_line (budget_id, account_id, amount) VALUES ($1, $2, 1)', [bid, acc['5101']]);
    await expect(h.pool.query(`UPDATE budget SET status = 'APPROVED', approved_by = 'alguien' WHERE id = $1`, [bid]))
      .rejects.toThrow(/other than its creator/);
  });

  it('approved budgets are frozen and cannot overlap', async () => {
    expect((await h.call('PUT', `/budgets/${budgetA}/lines`, conta, [{ accountId: acc['5101'], amount: '5000.00' }])).statusCode).toBe(422);
    const dup = (await h.call('POST', '/budgets', conta, {
      projectId: h.ref.project['P-A'], name: 'Traslape', startDate: '2026-12-01', endDate: '2027-03-31', enforcement: 'WARN',
      lines: [{ accountId: acc['5101'], amount: '1.00' }],
    })).json().id;
    expect((await h.call('POST', `/budgets/${dup}/approve`, ger1)).statusCode).toBe(422);
  });
});

describe('BLOCK enforcement', () => {
  it('allows spending up to exactly the available amount and blocks one cent more', async () => {
    // 1,000.00 budgeted: 600.00 + 400.00 = 1,000.00 → allowed; then 0.01 → blocked.
    const e1 = await draft('P-A', '600.00');
    const e2 = await draft('P-A', '400.00');
    const e3 = await draft('P-A', '0.01');
    expect((await h.call('POST', `/journal-entries/${e1}/approve`, ger1)).json()).toEqual({ ok: true, budgetAlerts: [] });
    expect((await h.call('POST', `/journal-entries/${e2}/approve`, ger1)).statusCode).toBe(200);
    const blocked = await h.call('POST', `/journal-entries/${e3}/approve`, ger1);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().message).toMatch(/presupuesto excedido: proyecto P-A, cuenta 5101, solicitado 0.01, disponible 0/);
    await h.call('POST', `/journal-entries/${e1}/post`, conta);
  });

  it('serializes concurrent approvals competing for the same remaining amount', async () => {
    // 100.00 available on 5102; two approvals of 60.00 overlap. The first holds its transaction
    // open; the second must wait for it and then be rejected (40.00 left < 60.00).
    // Deterministic: without the budget lock the second approval would not wait and both would pass.
    const a = await draft('P-A', '60.00', '5102');
    const b = await draft('P-A', '60.00', '5102');
    const c1 = await h.pool.connect();
    const c2 = await h.pool.connect();
    const begin = async (c: typeof c1, user: string) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE coni_app');
      await c.query("SELECT set_config('app.user_id', $1, true)", [user]);
    };
    try {
      await begin(c1, 'ger1');
      await begin(c2, 'ger2');
      await c1.query(`UPDATE journal_entry SET status = 'APPROVED', approved_by = 'ger1' WHERE id = $1`, [a]);
      const second = c2.query(`UPDATE journal_entry SET status = 'APPROVED', approved_by = 'ger2' WHERE id = $1`, [b])
        .then(() => 'approved', (e: Error) => e.message);
      const early = await Promise.race([second, new Promise((r) => setTimeout(() => r('waiting'), 500))]);
      expect(early).toBe('waiting');
      await c1.query('COMMIT');
      expect(await second).toMatch(/presupuesto excedido: proyecto P-A, cuenta 5102, solicitado 60.00, disponible 40.00/);
      await c2.query('ROLLBACK');
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined);
      await c2.query('ROLLBACK').catch(() => undefined);
      c1.release();
      c2.release();
    }
    expect((await h.call('POST', `/journal-entries/${a}/post`, conta)).statusCode).toBe(200);
  });

  it('a reversal releases the consumed budget', async () => {
    // 5102 now has 60.00 posted → 40.00 available; 100.00 is blocked until the 60.00 is reversed.
    const big = await draft('P-A', '100.00', '5102');
    expect((await h.call('POST', `/journal-entries/${big}/approve`, ger1)).statusCode).toBe(422);
    const posted = (await h.pool.query(
      `SELECT e.id FROM journal_entry e JOIN journal_line l ON l.entry_id = e.id
        WHERE e.status = 'POSTED' AND l.account_id = $1 LIMIT 1`, [acc['5102']])).rows[0].id;
    const rev = (await h.call('POST', `/journal-entries/${posted}/reverse`, conta, { entryDate: '2026-10-16' })).json().id;
    expect((await h.call('POST', `/journal-entries/${rev}/approve`, ger1)).statusCode).toBe(200);
    expect((await h.call('POST', `/journal-entries/${rev}/post`, conta)).statusCode).toBe(200);
    expect((await h.call('POST', `/journal-entries/${big}/approve`, ger1)).statusCode).toBe(200);
  });

  it('blocks expenses on accounts that are not in the approved budget', async () => {
    const e = await draft('P-A', '1.00', '5103');
    const res = await h.call('POST', `/journal-entries/${e}/approve`, ger1);
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/cuenta 5103, solicitado 1.00, disponible 0/);
  });
});

describe('WARN enforcement', () => {
  it('approves overspending but records and returns alerts', async () => {
    budgetB = (await h.call('POST', '/budgets', conta, {
      projectId: h.ref.project['P-B'], name: 'Presupuesto P-B', startDate: '2026-10-01', endDate: '2026-12-31',
      enforcement: 'WARN', lines: [{ accountId: acc['5101'], amount: '200.00' }],
    })).json().id;
    expect((await h.call('POST', `/budgets/${budgetB}/approve`, gerB)).statusCode).toBe(200);

    const over = await draft('P-B', '250.00');
    const res = await h.call('POST', `/journal-entries/${over}/approve`, gerB);
    expect(res.statusCode).toBe(200);
    expect(res.json().budgetAlerts).toEqual([
      { project_code: 'P-B', account_code: '5101', kind: 'OVERSPEND', requested: '250.00', available: '200.00' },
    ]);
    const unbudgeted = await draft('P-B', '5.00', '5103');
    expect((await h.call('POST', `/journal-entries/${unbudgeted}/approve`, gerB)).json().budgetAlerts)
      .toEqual([expect.objectContaining({ kind: 'UNBUDGETED', requested: '5.00', available: '0.00' })]);
  });
});

describe('budget execution report (M01-BUD-003)', () => {
  it('reports budgeted, executed, committed and available per account', async () => {
    const { rows } = (await h.call('GET', `/budgets/${budgetA}`, conta)).json();
    // 5101: 1,000 budgeted; 600 posted; 400 approved not posted → available 0.
    // 5102: 100 budgeted; 60 posted then reversed (net 0); 100 approved → available 0.
    // 5103: not budgeted; nothing approved (its approval was blocked) → not listed.
    expect(rows).toEqual([
      expect.objectContaining({ code: '5101', budgeted: '1000.00', executed: '600.00', committed: '400.00', available: '0.00' }),
      expect.objectContaining({ code: '5102', budgeted: '100.00', executed: '0.00', committed: '100.00', available: '0.00' }),
    ]);
  });

  it('lists unbudgeted spending with a negative available amount', async () => {
    const { rows, alerts } = (await h.call('GET', `/budgets/${budgetB}`, gerB)).json();
    expect(rows).toEqual([
      expect.objectContaining({ code: '5101', budgeted: '200.00', executed: '0.00', committed: '250.00', available: '-50.00' }),
      expect.objectContaining({ code: '5103', budgeted: '0.00', executed: '0.00', committed: '5.00', available: '-5.00' }),
    ]);
    expect(alerts).toHaveLength(2);
  });
});

describe('isolation and integrity', () => {
  it('users only see budgets of their projects', async () => {
    expect((await h.call('GET', `/budgets/${budgetA}`, gerB)).statusCode).toBe(404);
    const list = (await h.call('GET', '/budgets', gerB)).json() as { project_code: string }[];
    expect(new Set(list.map((b) => b.project_code))).toEqual(new Set(['P-B']));
  });

  it('approval and posting cannot be recorded in someone else’s name through SQL', async () => {
    const e = await draft('P-A', '1.00', '5101');
    await expect(withActor(h.pool, 'conta', (c) => c.query(
      `UPDATE journal_entry SET status = 'APPROVED', approved_by = 'ger1' WHERE id = $1`, [e])))
      .rejects.toThrow(/authorized acting user/);
    await expect(withActor(h.pool, 'conta', (c) => c.query(
      `UPDATE budget SET status = 'APPROVED', approved_by = 'ger1' WHERE status = 'DRAFT'`)))
      .rejects.toThrow(/authorized acting user/);
  });
});
