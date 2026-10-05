import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Account, type Me, type Period, type Rate, type Setting, type SyncRun } from '../lib/api.ts';
import { Button, Card, ErrorBox, Field, Input, Select } from '../ui.tsx';

const th = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted';
const td = 'px-3 py-2 text-sm';
const TYPE_LABEL: Record<string, string> = {
  ASSET: 'Activo', LIABILITY: 'Pasivo', EQUITY: 'Patrimonio', INCOME: 'Ingreso', EXPENSE: 'Gasto',
};
const todayGt = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala' }).format(new Date());

export function AccountsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') });
  const canEdit = me.permissions.includes('accounting.config');
  const [form, setForm] = useState({ code: '', name: '', type: 'EXPENSE', parentId: '', isPostable: true, requiresProject: false });
  const headers = accounts.data?.filter((a) => !a.is_postable) ?? [];
  const create = useMutation({
    mutationFn: () => api('/accounts', {
      method: 'POST',
      body: { ...form, parentId: form.parentId ? Number(form.parentId) : null },
    }),
    onSuccess: () => { setForm((f) => ({ ...f, code: '', name: '' })); qc.invalidateQueries({ queryKey: ['accounts'] }); },
  });
  const toggle = useMutation({
    mutationFn: (a: Account) => api(`/accounts/${a.id}`, { method: 'PATCH', body: { active: !a.active } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });
  const depth = (a: Account): number => {
    const parent = accounts.data?.find((p) => p.id === a.parent_id);
    return parent ? depth(parent) + 1 : 0;
  };

  return (
    <div className="space-y-6">
      {canEdit && (
        <Card title="Nueva cuenta">
          <form className="grid gap-3 sm:grid-cols-6" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Field label="Código"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></Field>
            <div className="sm:col-span-2"><Field label="Nombre"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field></div>
            <Field label="Tipo">
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Cuenta padre" hint="El código debe iniciar con el código del padre y ser del mismo tipo.">
                <Select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
                  <option value="">(Raíz)</option>
                  {headers.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </Select>
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isPostable} onChange={(e) => setForm({ ...form, isPostable: e.target.checked })} /> Imputable (recibe movimientos)</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.requiresProject} onChange={(e) => setForm({ ...form, requiresProject: e.target.checked })} /> Exige proyecto</label>
            <div className="sm:col-span-6"><ErrorBox error={create.error} /></div>
            <div><Button type="submit" disabled={create.isPending}>Crear cuenta</Button></div>
          </form>
        </Card>
      )}
      <Card title="Catálogo de cuentas">
        <ErrorBox error={accounts.error ?? toggle.error} />
        <table className="w-full border-collapse">
          <thead className="border-b border-line"><tr><th className={th}>Código</th><th className={th}>Nombre</th><th className={th}>Tipo</th><th className={th}>Imputable</th><th className={th}>Exige proyecto</th><th className={th}>Estado</th></tr></thead>
          <tbody>
            {accounts.data?.map((a) => (
              <tr key={a.id} className={`border-b border-line/60 ${a.active ? '' : 'text-muted'}`}>
                <td className={`${td} num`}>{a.code}</td>
                <td className={td} style={{ paddingLeft: `${0.75 + depth(a) * 1.25}rem` }}>{a.is_postable ? a.name : <strong>{a.name}</strong>}</td>
                <td className={td}>{TYPE_LABEL[a.type]}</td>
                <td className={td}>{a.is_postable ? 'Sí' : 'No'}</td>
                <td className={td}>{a.requires_project ? 'Sí' : 'No'}</td>
                <td className={td}>
                  {canEdit
                    ? <button className="text-brand hover:underline" onClick={() => toggle.mutate(a)}>{a.active ? 'Activa · desactivar' : 'Inactiva · activar'}</button>
                    : a.active ? 'Activa' : 'Inactiva'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function PeriodsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const periods = useQuery({ queryKey: ['periods'], queryFn: () => api<Period[]>('/periods') });
  const [form, setForm] = useState({ code: '', startDate: '', endDate: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['periods'] });
  const create = useMutation({ mutationFn: () => api('/periods', { method: 'POST', body: form }), onSuccess: refresh });
  const close = useMutation({ mutationFn: (p: Period) => api(`/periods/${p.id}/close`, { method: 'POST' }), onSuccess: refresh });
  const reopen = useMutation({
    mutationFn: ({ p, reason }: { p: Period; reason: string }) => api(`/periods/${p.id}/reopen`, { method: 'POST', body: { reason } }),
    onSuccess: refresh,
  });
  const canCreate = me.permissions.includes('accounting.config');
  const canClose = me.permissions.includes('period.close');

  return (
    <div className="space-y-6">
      {canCreate && (
        <Card title="Nuevo periodo">
          <form className="grid gap-3 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Field label="Código"><Input placeholder="2026-11" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></Field>
            <Field label="Inicio"><Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} required /></Field>
            <Field label="Fin"><Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} required /></Field>
            <div className="flex items-end"><Button type="submit" disabled={create.isPending}>Crear</Button></div>
            <div className="sm:col-span-4"><ErrorBox error={create.error} /></div>
          </form>
        </Card>
      )}
      <Card title="Periodos contables">
        <p className="mb-3 text-sm text-muted">Para cerrar un periodo no debe tener partidas en borrador ni aprobadas sin contabilizar. Reabrir exige un motivo, que queda en la bitácora.</p>
        <ErrorBox error={periods.error ?? close.error ?? reopen.error} />
        <table className="w-full border-collapse">
          <thead className="border-b border-line"><tr><th className={th}>Periodo</th><th className={th}>Inicio</th><th className={th}>Fin</th><th className={th}>Estado</th><th /></tr></thead>
          <tbody>
            {periods.data?.map((p) => (
              <tr key={p.id} className="border-b border-line/60">
                <td className={`${td} num`}>{p.code}</td><td className={`${td} num`}>{p.start_date}</td><td className={`${td} num`}>{p.end_date}</td>
                <td className={td}>{p.status === 'OPEN' ? 'Abierto' : 'Cerrado'}</td>
                <td className={`${td} text-right`}>
                  {canClose && p.status === 'OPEN' &&
                    <Button variant="secondary" onClick={() => { if (confirm(`¿Cerrar el periodo ${p.code}?`)) close.mutate(p); }}>Cerrar</Button>}
                  {canClose && p.status === 'CLOSED' &&
                    <Button variant="danger" onClick={() => {
                      const reason = prompt(`Motivo para reabrir ${p.code} (mínimo 10 caracteres):`);
                      if (reason) reopen.mutate({ p, reason });
                    }}>Reabrir</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function RatesPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const today = todayGt();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const rates = useQuery({ queryKey: ['rates', from, to], queryFn: () => api<Rate[]>(`/rates?currency=USD&from=${from}&to=${to}`) });
  const runs = useQuery({ queryKey: ['sync-runs'], queryFn: () => api<SyncRun[]>('/rates/sync-runs') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Setting[]>('/settings') });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['rates'] }), qc.invalidateQueries({ queryKey: ['sync-runs'] })]);
  const sync = useMutation({
    mutationFn: () => api<{ inserted: number; unchanged: number; conflicts: number }>('/rates/sync', { method: 'POST', body: { currency: 'USD', from, to } }),
    onSuccess: refresh,
  });
  const [manual, setManual] = useState({ date: today, rate: '', justification: '' });
  const addManual = useMutation({
    mutationFn: () => api('/rates/manual', { method: 'POST', body: { currency: 'USD', ...manual } }),
    onSuccess: () => { setManual({ ...manual, rate: '', justification: '' }); refresh(); },
  });
  const rounding = settings.data?.find((s) => s.key === 'money.rounding');

  return (
    <div className="space-y-6">
      <Card title="Tipo de cambio de referencia USD (BANGUAT)">
        {rounding && (
          <p className="mb-3 text-sm text-muted">
            Redondeo de conversión: <strong>{rounding.value}</strong>{rounding.status === 'PROPUESTA' && <span className="text-warn"> (propuesta, pendiente de aprobación del contador)</span>}.
            BANGUAT publica una tasa para cada día calendario, incluidos fines de semana.
          </p>
        )}
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Field label="Desde"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Hasta"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          {me.permissions.includes('accounting.config') &&
            <Button onClick={() => sync.mutate()} disabled={sync.isPending}>{sync.isPending ? 'Consultando BANGUAT…' : 'Sincronizar rango'}</Button>}
        </div>
        {sync.data && <p className="mb-3 text-sm">Nuevas: {sync.data.inserted} · Sin cambio: {sync.data.unchanged} · Conflictos: <span className={sync.data.conflicts ? 'font-semibold text-danger' : ''}>{sync.data.conflicts}</span></p>}
        <ErrorBox error={rates.error ?? sync.error} />
        <table className="w-full border-collapse">
          <thead className="border-b border-line"><tr><th className={th}>Fecha</th><th className={`${th} text-right`}>Q por US$</th><th className={th}>Fuente</th><th className={th}>Justificación / autorizó</th></tr></thead>
          <tbody>
            {rates.data?.map((r) => (
              <tr key={`${r.rate_date}-${r.source}`} className="border-b border-line/60">
                <td className={`${td} num`}>{r.rate_date}</td>
                <td className={`${td} num text-right`}>{r.rate}</td>
                <td className={td}>{r.source === 'BANGUAT' ? 'BANGUAT' : 'Manual'}</td>
                <td className={td}>{r.justification ? `${r.justification} — ${r.approved_by}` : ''}</td>
              </tr>
            ))}
            {rates.data?.length === 0 && <tr><td colSpan={4} className={`${td} text-muted`}>Sin tasas en el rango.</td></tr>}
          </tbody>
        </table>
      </Card>

      {me.permissions.includes('rates.manual') && (
        <Card title="Tasa manual autorizada">
          <p className="mb-3 text-sm text-muted">Solo cuando no existe tasa oficial para la fecha. La tasa BANGUAT siempre prevalece.</p>
          <form className="grid gap-3 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); addManual.mutate(); }}>
            <Field label="Fecha"><Input type="date" value={manual.date} onChange={(e) => setManual({ ...manual, date: e.target.value })} required /></Field>
            <Field label="Q por US$"><Input inputMode="decimal" pattern="\d{1,12}(\.\d{1,6})?" value={manual.rate} onChange={(e) => setManual({ ...manual, rate: e.target.value })} required /></Field>
            <div className="sm:col-span-2"><Field label="Justificación"><Input minLength={10} value={manual.justification} onChange={(e) => setManual({ ...manual, justification: e.target.value })} required /></Field></div>
            <div className="sm:col-span-4"><ErrorBox error={addManual.error} /></div>
            <div><Button type="submit" disabled={addManual.isPending}>Registrar</Button></div>
          </form>
        </Card>
      )}

      <Card title="Historial de sincronización">
        <table className="w-full border-collapse">
          <thead className="border-b border-line"><tr><th className={th}>Inicio</th><th className={th}>Rango</th><th className={th}>Estado</th><th className={`${th} text-right`}>Nuevas / sin cambio / conflictos</th><th className={th}>Error</th></tr></thead>
          <tbody>
            {runs.data?.map((r) => (
              <tr key={r.id} className="border-b border-line/60">
                <td className={`${td} num`}>{new Date(r.started_at).toLocaleString('es-GT')}</td>
                <td className={`${td} num`}>{r.date_from} → {r.date_to}</td>
                <td className={`${td} ${r.status === 'ERROR' ? 'text-danger' : ''}`}>{r.status}</td>
                <td className={`${td} num text-right`}>{r.inserted} / {r.unchanged} / {r.conflicts}</td>
                <td className={`${td} text-danger`}>{r.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
