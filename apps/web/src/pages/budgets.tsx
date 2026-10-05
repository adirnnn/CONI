import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sum } from '@coni/shared';
import { api, type Account, type Me, type Project } from '../lib/api.ts';
import { formatMoney } from '../lib/format.ts';
import { Button, Card, ErrorBox, Field, Input, Select } from '../ui.tsx';

const th = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted';
const td = 'px-3 py-2 text-sm';
const AMOUNT = /^\d{1,16}(\.\d{1,2})?$/;

interface BudgetSummary {
  id: number; project_code: string; name: string; start_date: string; end_date: string;
  enforcement: 'BLOCK' | 'WARN'; status: 'DRAFT' | 'APPROVED' | 'CLOSED'; created_by: string; approved_by: string | null; total: string;
}
interface BudgetDetail {
  budget: BudgetSummary;
  rows: { account_id: number; code: string; name: string; budgeted: string; executed: string; committed: string; available: string }[];
  alerts: { id: number; created_at: string; entry_id: string; account_code: string; kind: 'OVERSPEND' | 'UNBUDGETED'; requested: string; available: string; approved_by: string }[];
}

const STATUS = { DRAFT: 'Borrador', APPROVED: 'Aprobado', CLOSED: 'Cerrado' } as const;
const MODE = { BLOCK: 'Bloquea el sobregiro', WARN: 'Permite con alerta' } as const;

export function BudgetsPage({ me }: { me: Me }) {
  const budgets = useQuery({ queryKey: ['budgets'], queryFn: () => api<BudgetSummary[]>('/budgets') });
  return (
    <Card title="Presupuestos por proyecto"
      actions={me.permissions.includes('budget.manage') && <Link to="/presupuestos/nuevo"><Button>Nuevo presupuesto</Button></Link>}>
      <ErrorBox error={budgets.error} />
      <table className="w-full border-collapse">
        <thead className="border-b border-line"><tr><th className={th}>Proyecto</th><th className={th}>Nombre</th><th className={th}>Vigencia</th><th className={th}>Control</th><th className={th}>Estado</th><th className={`${th} text-right`}>Total</th></tr></thead>
        <tbody>
          {budgets.data?.map((b) => (
            <tr key={b.id} className="border-b border-line/60 hover:bg-canvas">
              <td className={td}>{b.project_code}</td>
              <td className={td}><Link className="text-brand hover:underline" to={`/presupuestos/${b.id}`}>{b.name}</Link></td>
              <td className={`${td} num`}>{b.start_date} → {b.end_date}</td>
              <td className={td}>{MODE[b.enforcement]}</td>
              <td className={td}>{STATUS[b.status]}</td>
              <td className={`${td} num text-right`}>{formatMoney(b.total)}</td>
            </tr>
          ))}
          {budgets.data?.length === 0 && <tr><td colSpan={6} className={`${td} text-muted`}>No hay presupuestos.</td></tr>}
        </tbody>
      </table>
    </Card>
  );
}

export function NewBudgetPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/projects') });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') });
  const expense = accounts.data?.filter((a) => a.type === 'EXPENSE' && a.is_postable && a.active) ?? [];
  const [form, setForm] = useState({ projectId: '', name: '', startDate: '', endDate: '', enforcement: '' });
  const [lines, setLines] = useState([{ accountId: '', amount: '' }]);
  const total = sum(lines.map((l) => (AMOUNT.test(l.amount) ? l.amount : '0')));
  const create = useMutation({
    mutationFn: () => api<{ id: number }>('/budgets', {
      method: 'POST',
      body: { ...form, projectId: Number(form.projectId), lines: lines.map((l) => ({ accountId: Number(l.accountId), amount: l.amount })) },
    }),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: ['budgets'] }); navigate(`/presupuestos/${r.id}`); },
  });
  return (
    <Card title="Nuevo presupuesto (GTQ)">
      <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-5">
          <Field label="Proyecto">
            <Select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })} required>
              <option value="">Seleccione…</option>
              {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
            </Select>
          </Field>
          <div className="sm:col-span-2"><Field label="Nombre"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field></div>
          <Field label="Inicio"><Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} required /></Field>
          <Field label="Fin"><Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} required /></Field>
          <div className="sm:col-span-5">
            <Field label="Control de sobregiro" hint="Decisión de política de CONI: bloquear la aprobación o permitirla registrando una alerta.">
              <Select value={form.enforcement} onChange={(e) => setForm({ ...form, enforcement: e.target.value })} required>
                <option value="">Seleccione…</option>
                <option value="BLOCK">{MODE.BLOCK}</option>
                <option value="WARN">{MODE.WARN}</option>
              </Select>
            </Field>
          </div>
        </div>
        <table className="w-full border-collapse">
          <thead className="border-b border-line"><tr><th className={th}>Cuenta de gasto</th><th className={`${th} text-right`}>Techo (GTQ)</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-b border-line/60">
                <td className="py-2 pr-2">
                  <Select aria-label={`Cuenta renglón ${i + 1}`} value={l.accountId} required
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))}>
                    <option value="">Seleccione…</option>
                    {expense.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                  </Select>
                </td>
                <td className="w-48 py-2 pr-2">
                  <Input aria-label={`Monto renglón ${i + 1}`} className="num text-right" inputMode="decimal" pattern={AMOUNT.source} value={l.amount} required
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                </td>
                <td className="py-2">{lines.length > 1 && <Button type="button" variant="secondary" aria-label={`Quitar renglón ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</Button>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr>
            <td className="py-2"><Button type="button" variant="secondary" onClick={() => setLines((ls) => [...ls, { accountId: '', amount: '' }])}>Agregar renglón</Button></td>
            <td className="num py-2 pr-2 text-right text-sm font-semibold">{formatMoney(total)}</td><td />
          </tr></tfoot>
        </table>
        <ErrorBox error={create.error} />
        <Button type="submit" disabled={create.isPending}>Guardar borrador</Button>
      </form>
    </Card>
  );
}

export function BudgetPage({ me }: { me: Me }) {
  const { id } = useParams();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['budget', id], queryFn: () => api<BudgetDetail>(`/budgets/${id}`) });
  const act = useMutation({
    mutationFn: (a: 'approve' | 'close') => api(`/budgets/${id}/${a}`, { method: 'POST' }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['budget'] }), qc.invalidateQueries({ queryKey: ['budgets'] })]),
  });
  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!detail.data) return <p className="text-sm text-muted">Cargando…</p>;
  const { budget, rows, alerts } = detail.data;
  const totals = (k: 'budgeted' | 'executed' | 'committed' | 'available') => sum(rows.map((r) => r[k]));
  const canApprove = me.permissions.includes('budget.approve');
  const pct = (r: BudgetDetail['rows'][number]) => {
    const used = Number(r.executed) + Number(r.committed); // display only
    return Number(r.budgeted) > 0 ? Math.round((used / Number(r.budgeted)) * 100) : null;
  };

  return (
    <div className="space-y-6">
      <Card title={`${budget.project_code} · ${budget.name}`}
        actions={<div className="flex gap-2">
          {canApprove && budget.status === 'DRAFT' && budget.created_by !== me.username &&
            <Button onClick={() => act.mutate('approve')} disabled={act.isPending}>Aprobar</Button>}
          {canApprove && budget.status === 'APPROVED' &&
            <Button variant="secondary" onClick={() => { if (confirm('¿Cerrar el presupuesto?')) act.mutate('close'); }}>Cerrar</Button>}
        </div>}>
        <dl className="mb-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div><dt className="text-muted">Vigencia</dt><dd className="num">{budget.start_date} → {budget.end_date}</dd></div>
          <div><dt className="text-muted">Estado</dt><dd>{STATUS[budget.status]}</dd></div>
          <div><dt className="text-muted">Control</dt><dd>{MODE[budget.enforcement]}</dd></div>
          <div><dt className="text-muted">Preparó / aprobó</dt><dd>{budget.created_by} / {budget.approved_by ?? '—'}</dd></div>
        </dl>
        <ErrorBox error={act.error} />
        <p className="mb-3 text-sm text-muted">Ejecutado: partidas contabilizadas. Comprometido: partidas aprobadas pendientes de contabilizar. Las cuentas de gasto del proyecto sin techo aparecen con presupuesto cero.</p>
        <table className="w-full border-collapse">
          <thead className="border-b border-line"><tr>
            <th className={th}>Cuenta</th><th className={`${th} text-right`}>Presupuesto</th><th className={`${th} text-right`}>Ejecutado</th>
            <th className={`${th} text-right`}>Comprometido</th><th className={`${th} text-right`}>Disponible</th><th className={`${th} text-right`}>% uso</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const p = pct(r);
              const over = r.available.startsWith('-');
              return (
                <tr key={r.account_id} className="border-b border-line/60">
                  <td className={td}>{r.code} · {r.name}</td>
                  <td className={`${td} num text-right`}>{formatMoney(r.budgeted)}</td>
                  <td className={`${td} num text-right`}>{formatMoney(r.executed)}</td>
                  <td className={`${td} num text-right`}>{formatMoney(r.committed)}</td>
                  <td className={`${td} num text-right ${over ? 'font-semibold text-danger' : ''}`}>{formatMoney(r.available)}</td>
                  <td className={`${td} num text-right ${over ? 'text-danger' : p !== null && p >= 90 ? 'text-warn' : ''}`}>{p === null ? 'Sin techo' : `${p}%`}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot><tr className="font-semibold">
            <td className={td}>Totales</td>
            {(['budgeted', 'executed', 'committed', 'available'] as const).map((k) => <td key={k} className={`${td} num text-right`}>{formatMoney(totals(k))}</td>)}
            <td />
          </tr></tfoot>
        </table>
      </Card>
      {alerts.length > 0 && (
        <Card title="Alertas de sobregiro">
          <table className="w-full border-collapse">
            <thead className="border-b border-line"><tr><th className={th}>Fecha</th><th className={th}>Partida</th><th className={th}>Cuenta</th><th className={th}>Tipo</th><th className={`${th} text-right`}>Solicitado</th><th className={`${th} text-right`}>Disponible</th><th className={th}>Aprobó</th></tr></thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id} className="border-b border-line/60">
                  <td className={`${td} num`}>{new Date(a.created_at).toLocaleString('es-GT')}</td>
                  <td className={td}><Link className="text-brand hover:underline" to={`/partidas/${a.entry_id}`}>{a.entry_id}</Link></td>
                  <td className={td}>{a.account_code}</td>
                  <td className={td}>{a.kind === 'OVERSPEND' ? 'Sobregiro' : 'Sin presupuesto'}</td>
                  <td className={`${td} num text-right`}>{formatMoney(a.requested)}</td>
                  <td className={`${td} num text-right`}>{formatMoney(a.available)}</td>
                  <td className={td}>{a.approved_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
