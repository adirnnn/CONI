import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sum } from '@coni/shared';
import {
  api, type Account, type Currency, type EntryDetail, type EntryStatus, type EntrySummary, type Me, type Period,
  type Project, type TrialBalance,
} from '../lib/api.ts';
import { formatMoney, SCOPE_LABEL, STATUS_LABEL } from '../lib/format.ts';
import { Button, Card, ErrorBox, Field, Input, Select, StatusBadge } from '../ui.tsx';

const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/projects') });
const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') });
const usePeriods = () => useQuery({ queryKey: ['periods'], queryFn: () => api<Period[]>('/periods') });
const useCurrencies = () => useQuery({ queryKey: ['currencies'], queryFn: () => api<Currency[]>('/currencies') });
const todayGt = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala' }).format(new Date());

const th = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted';
const td = 'px-3 py-2 text-sm';

export function EntriesPage({ me }: { me: Me }) {
  const [status, setStatus] = useState<EntryStatus | ''>('');
  const [projectId, setProjectId] = useState('');
  const projects = useProjects();
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (projectId) params.set('projectId', projectId);
  const entries = useQuery({
    queryKey: ['entries', status, projectId],
    queryFn: () => api<EntrySummary[]>(`/journal-entries?${params}`),
  });

  return (
    <Card
      title="Partidas contables"
      actions={me.permissions.includes('ledger.write') && <Link to="/partidas/nueva"><Button>Nueva partida</Button></Link>}
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field label="Estado">
          <Select value={status} onChange={(e) => setStatus(e.target.value as EntryStatus | '')}>
            <option value="">Todos</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Proyecto">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Todos los asignados</option>
            {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </Select>
        </Field>
      </div>
      <ErrorBox error={entries.error} />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="border-b border-line">
            <tr><th className={th}>No.</th><th className={th}>Fecha</th><th className={th}>Descripción</th><th className={th}>Estado</th><th className={`${th} text-right`}>Total (GTQ)</th></tr>
          </thead>
          <tbody>
            {entries.data?.map((e) => (
              <tr key={e.id} className="border-b border-line/60 hover:bg-canvas">
                <td className={td}><Link className="text-brand underline-offset-2 hover:underline" to={`/partidas/${e.id}`}>{e.id}</Link></td>
                <td className={`${td} num`}>{e.entry_date}</td>
                <td className={td}>{e.description}</td>
                <td className={td}><StatusBadge status={e.status} /></td>
                <td className={`${td} num text-right`}>{formatMoney(e.total_gtq)}</td>
              </tr>
            ))}
            {entries.data?.length === 0 && <tr><td colSpan={5} className={`${td} text-muted`}>No hay partidas para los filtros seleccionados.</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

interface BudgetAlert { project_code: string; account_code: string; kind: 'OVERSPEND' | 'UNBUDGETED'; requested: string; available: string }

interface DraftLine { accountId: string; projectId: string; currency: string; debit: string; credit: string; memo: string }
const emptyLine = (currency = 'GTQ'): DraftLine => ({ accountId: '', projectId: '', currency, debit: '', credit: '', memo: '' });
const AMOUNT = /^\d{1,16}(\.\d{1,2})?$/;

/** Manual journal entry. Foreign-currency lines are converted by the server at the BANGUAT rate of the date. */
export function NewEntryPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const projects = useProjects();
  const periods = usePeriods();
  const currencies = useCurrencies();
  const [entryDate, setEntryDate] = useState(todayGt());
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);

  const postable = accounts.data?.filter((a) => a.is_postable && a.active) ?? [];
  const period = periods.data?.find((p) => p.start_date <= entryDate && entryDate <= p.end_date);
  // Balance check per currency; with mixed currencies the GTQ balance is verified by the server.
  const byCurrency = useMemo(() => {
    const valid = (v: string) => (AMOUNT.test(v) ? v : '0');
    const codes = [...new Set(lines.map((l) => l.currency))];
    return codes.map((code) => {
      const ls = lines.filter((l) => l.currency === code);
      return { code, debit: sum(ls.map((l) => valid(l.debit))), credit: sum(ls.map((l) => valid(l.credit))) };
    });
  }, [lines]);
  const mixed = byCurrency.length > 1;
  const balanced = mixed
    ? byCurrency.every((t) => t.debit !== '0.00' || t.credit !== '0.00')
    : byCurrency[0]!.debit === byCurrency[0]!.credit && byCurrency[0]!.debit !== '0.00';
  const foreign = lines.some((l) => l.currency !== 'GTQ');

  const update = (i: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const create = useMutation({
    mutationFn: () => {
      if (!period) throw new Error('No existe un periodo contable para esa fecha');
      if (period.status === 'CLOSED') throw new Error(`El periodo ${period.code} está cerrado`);
      return api<{ id: string }>('/journal-entries', {
        method: 'POST',
        body: {
          entryDate, description,
          lines: lines.map((l) => ({
            accountId: Number(l.accountId), currency: l.currency,
            ...(l.debit ? { debit: l.debit } : { credit: l.credit }),
            projectId: l.projectId ? Number(l.projectId) : null,
            memo: l.memo || undefined,
          })),
        },
      });
    },
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: ['entries'] }); navigate(`/partidas/${r.id}`); },
  });

  return (
    <Card title="Nueva partida">
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <Field label="Fecha" hint={period ? `Periodo ${period.code} (${period.status === 'OPEN' ? 'abierto' : 'cerrado'})` : 'Sin periodo'}>
            <Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} required />
          </Field>
          <Field label="Descripción"><Input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} required /></Field>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="border-b border-line">
              <tr><th className={th}>Cuenta</th><th className={th}>Proyecto</th><th className={th}>Moneda</th><th className={`${th} text-right`}>Debe</th><th className={`${th} text-right`}>Haber</th><th className={th}>Detalle</th><th /></tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const acc = postable.find((a) => String(a.id) === l.accountId);
                return (
                  <tr key={i} className="border-b border-line/60 align-top">
                    <td className="py-2 pr-2">
                      <Select aria-label={`Cuenta línea ${i + 1}`} value={l.accountId} onChange={(e) => update(i, { accountId: e.target.value })} required>
                        <option value="">Seleccione…</option>
                        {postable.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                      </Select>
                    </td>
                    <td className="py-2 pr-2">
                      <Select aria-label={`Proyecto línea ${i + 1}`} value={l.projectId} onChange={(e) => update(i, { projectId: e.target.value })} required={acc?.requires_project}>
                        <option value="">{acc?.requires_project ? 'Requerido…' : 'Institucional'}</option>
                        {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
                      </Select>
                    </td>
                    <td className="w-24 py-2 pr-2">
                      <Select aria-label={`Moneda línea ${i + 1}`} value={l.currency} onChange={(e) => update(i, { currency: e.target.value })}>
                        {currencies.data?.filter((c) => c.enabled).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
                      </Select>
                    </td>
                    <td className="w-36 py-2 pr-2"><Input aria-label={`Debe línea ${i + 1}`} className="num" inputMode="decimal" pattern={AMOUNT.source} value={l.debit} disabled={!!l.credit} onChange={(e) => update(i, { debit: e.target.value })} /></td>
                    <td className="w-36 py-2 pr-2"><Input aria-label={`Haber línea ${i + 1}`} className="num" inputMode="decimal" pattern={AMOUNT.source} value={l.credit} disabled={!!l.debit} onChange={(e) => update(i, { credit: e.target.value })} /></td>
                    <td className="py-2 pr-2"><Input aria-label={`Detalle línea ${i + 1}`} value={l.memo} onChange={(e) => update(i, { memo: e.target.value })} /></td>
                    <td className="py-2">
                      {lines.length > 2 && <Button type="button" variant="secondary" aria-label={`Quitar línea ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</Button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} className="py-2"><Button type="button" variant="secondary" onClick={() => setLines((ls) => [...ls, emptyLine(ls.at(-1)?.currency)])}>Agregar línea</Button></td>
                <td className="num py-2 pr-2 text-right text-sm font-semibold">{byCurrency.map((t) => <div key={t.code}>{formatMoney(t.debit, t.code)}</div>)}</td>
                <td className="num py-2 pr-2 text-right text-sm font-semibold">{byCurrency.map((t) => <div key={t.code}>{formatMoney(t.credit, t.code)}</div>)}</td>
                <td colSpan={2} className={`py-2 text-sm font-medium ${mixed ? 'text-muted' : balanced ? 'text-ok' : 'text-danger'}`}>
                  {mixed ? 'Monedas mixtas: el cuadre en GTQ se verifica al aprobar' : balanced ? 'Cuadrada' : 'Descuadrada'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        {foreign && <p className="text-sm text-muted">Las líneas en moneda extranjera se convierten a GTQ con el tipo de cambio de referencia BANGUAT del {entryDate} al guardar. Si no existe tasa para esa fecha, la partida no se registra.</p>}
        <ErrorBox error={create.error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={create.isPending || !balanced}>Guardar borrador</Button>
          <Link to="/partidas"><Button type="button" variant="secondary">Cancelar</Button></Link>
        </div>
      </form>
    </Card>
  );
}

export function EntryPage({ me }: { me: Me }) {
  const { id } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const accounts = useAccounts();
  const projects = useProjects();
  const detail = useQuery({ queryKey: ['entry', id], queryFn: () => api<EntryDetail>(`/journal-entries/${id}`) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['entry'] }), qc.invalidateQueries({ queryKey: ['entries'] })]);

  const [alerts, setAlerts] = useState<BudgetAlert[]>([]);
  const action = useMutation({
    mutationFn: (a: 'approve' | 'post') => api<{ budgetAlerts?: BudgetAlert[] }>(`/journal-entries/${id}/${a}`, { method: 'POST' }),
    onSuccess: async (r) => { setAlerts(r.budgetAlerts ?? []); await refresh(); },
  });
  const reverse = useMutation({
    mutationFn: () => {
      return api<{ id: string }>(`/journal-entries/${id}/reverse`, { method: 'POST', body: { entryDate: todayGt() } });
    },
    onSuccess: async (r) => { await refresh(); navigate(`/partidas/${r.id}`); },
  });

  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!detail.data) return <p className="text-sm text-muted">Cargando…</p>;
  const { entry, lines } = detail.data;
  const can = (p: string) => me.permissions.includes(p);
  const accountName = (aid: number) => { const a = accounts.data?.find((x) => x.id === aid); return a ? `${a.code} · ${a.name}` : aid; };
  const projectCode = (pid: number | null) => (pid === null ? 'Institucional' : projects.data?.find((p) => p.id === pid)?.code ?? pid);

  return (
    <Card
      title={`Partida ${entry.id}`}
      actions={
        <div className="flex gap-2">
          {entry.status === 'DRAFT' && can('ledger.approve') && entry.created_by !== me.username &&
            <Button onClick={() => action.mutate('approve')} disabled={action.isPending}>Aprobar</Button>}
          {entry.status === 'APPROVED' && can('ledger.post') &&
            <Button onClick={() => action.mutate('post')} disabled={action.isPending}>Contabilizar</Button>}
          {entry.status === 'POSTED' && !entry.reverses_entry_id && can('ledger.post') &&
            <Button variant="danger" onClick={() => { if (confirm('¿Crear la partida de reversión en borrador?')) reverse.mutate(); }} disabled={reverse.isPending}>Revertir</Button>}
        </div>
      }
    >
      <dl className="mb-5 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div><dt className="text-muted">Fecha</dt><dd className="num">{entry.entry_date.slice(0, 10)}</dd></div>
        <div><dt className="text-muted">Estado</dt><dd><StatusBadge status={entry.status} /></dd></div>
        <div><dt className="text-muted">Creada por</dt><dd>{entry.created_by}</dd></div>
        <div><dt className="text-muted">Aprobada / contabilizada por</dt><dd>{entry.approved_by ?? '—'} / {entry.posted_by ?? '—'}</dd></div>
        <div className="sm:col-span-4"><dt className="text-muted">Descripción</dt><dd>{entry.description}</dd></div>
        {entry.reverses_entry_id && <div className="sm:col-span-4"><dt className="text-muted">Revierte</dt><dd><Link className="text-brand" to={`/partidas/${entry.reverses_entry_id}`}>Partida {entry.reverses_entry_id}</Link></dd></div>}
      </dl>
      <ErrorBox error={action.error ?? reverse.error} />
      {alerts.length > 0 && (
        <div role="status" className="mb-4 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          Aprobada con alertas de presupuesto:
          <ul className="list-disc pl-5">
            {alerts.map((a) => (
              <li key={`${a.project_code}-${a.account_code}`}>
                {a.project_code} · cuenta {a.account_code}: {a.kind === 'OVERSPEND' ? 'sobregiro' : 'sin presupuesto'} — solicitado {formatMoney(a.requested)}, disponible {formatMoney(a.available)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="border-b border-line"><tr><th className={th}>#</th><th className={th}>Cuenta</th><th className={th}>Proyecto</th><th className={`${th} text-right`}>Moneda original</th><th className={`${th} text-right`}>Tasa</th><th className={`${th} text-right`}>Debe (GTQ)</th><th className={`${th} text-right`}>Haber (GTQ)</th><th className={th}>Detalle</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-line/60">
                <td className={td}>{l.line_no}</td>
                <td className={td}>{accountName(l.account_id)}</td>
                <td className={td}>{projectCode(l.project_id)}</td>
                <td className={`${td} num text-right`}>{l.currency_code === 'GTQ' ? '' : formatMoney(l.debit_tx !== '0.00' ? l.debit_tx : `-${l.credit_tx}`, l.currency_code)}</td>
                <td className={`${td} num text-right`} title={l.rate_source === 'FUNCTIONAL' ? '' : `${l.rate_source} ${l.rate_date}`}>{l.currency_code === 'GTQ' ? '' : `${l.rate} (${l.rate_source === 'BANGUAT' ? 'BANGUAT' : 'manual'})`}</td>
                <td className={`${td} num text-right`}>{l.debit_gtq !== '0.00' ? formatMoney(l.debit_gtq) : ''}</td>
                <td className={`${td} num text-right`}>{l.credit_gtq !== '0.00' ? formatMoney(l.credit_gtq) : ''}</td>
                <td className={td}>{l.memo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function TrialBalancePage() {
  const projects = useProjects();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [projectId, setProjectId] = useState('');
  const qs = new URLSearchParams({ from, to, ...(projectId ? { projectId } : {}) });
  const report = useQuery({ queryKey: ['trial-balance', from, to, projectId], queryFn: () => api<TrialBalance>(`/reports/trial-balance?${qs}`) });
  const totals = report.data && { debit: sum(report.data.rows.map((r) => r.debit)), credit: sum(report.data.rows.map((r) => r.credit)) };

  return (
    <Card title="Balance de comprobación">
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field label="Desde"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Hasta"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Proyecto">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Todos los asignados</option>
            {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </Select>
        </Field>
      </div>
      <ErrorBox error={report.error} />
      {report.data && (
        <>
          <p className="mb-3 text-sm text-muted">Alcance: {SCOPE_LABEL[report.data.scope]}. Incluye partidas contabilizadas y revertidas (con su reversión).
            {report.data.scope === 'PROJECT' && ' Por proyecto solo se muestran las líneas imputadas al proyecto; si la contrapartida es institucional, los totales no cuadran.'}</p>
          <table className="w-full border-collapse">
            <thead className="border-b border-line"><tr><th className={th}>Cuenta</th><th className={th}>Nombre</th><th className={`${th} text-right`}>Debe</th><th className={`${th} text-right`}>Haber</th></tr></thead>
            <tbody>
              {report.data.rows.map((r) => (
                <tr key={r.code} className="border-b border-line/60">
                  <td className={`${td} num`}>{r.code}</td><td className={td}>{r.name}</td>
                  <td className={`${td} num text-right`}>{formatMoney(r.debit)}</td><td className={`${td} num text-right`}>{formatMoney(r.credit)}</td>
                </tr>
              ))}
              {report.data.rows.length === 0 && <tr><td colSpan={4} className={`${td} text-muted`}>Sin movimientos en el rango.</td></tr>}
            </tbody>
            {totals && (
              <tfoot><tr className="font-semibold">
                <td className={td} colSpan={2}>Totales</td>
                <td className={`${td} num text-right`}>{formatMoney(totals.debit)}</td><td className={`${td} num text-right`}>{formatMoney(totals.credit)}</td>
              </tr></tfoot>
            )}
          </table>
        </>
      )}
    </Card>
  );
}
