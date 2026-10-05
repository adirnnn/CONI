import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Me } from './lib/api.ts';
import { ChangePasswordPage, LoginPage, MfaPage } from './pages/auth.tsx';
import { EntriesPage, EntryPage, NewEntryPage, TrialBalancePage } from './pages/ledger.tsx';
import { AccountsPage, PeriodsPage, RatesPage } from './pages/config.tsx';
import { BudgetPage, BudgetsPage, NewBudgetPage } from './pages/budgets.tsx';
import { ErrorBox } from './ui.tsx';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

// Any 401 means the session ended: drop cached data and return to login.
queryClient.getQueryCache().subscribe((event) => {
  const err = event.query.state.error;
  if (event.type === 'updated' && err instanceof ApiError && err.status === 401 && event.query.queryKey[0] !== 'me') {
    queryClient.invalidateQueries({ queryKey: ['me'] });
  }
});

function Shell({ me }: { me: Me }) {
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSettled: () => { qc.clear(); window.location.assign('/'); },
  });
  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-brand text-white' : 'text-ink hover:bg-canvas'}`;
  const can = (p: string) => me.permissions.includes(p);
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="font-semibold text-brand">CONI</span>
          <nav className="flex flex-wrap gap-1" aria-label="Principal">
            {can('ledger.read') && <NavLink to="/partidas" end className={link}>Partidas</NavLink>}
            {can('ledger.read') && <NavLink to="/presupuestos" className={link}>Presupuestos</NavLink>}
            {can('ledger.read') && <NavLink to="/reportes/balance-comprobacion" className={link}>Balance de comprobación</NavLink>}
            {can('ledger.read') && <NavLink to="/configuracion/cuentas" className={link}>Catálogo</NavLink>}
            {can('ledger.read') && <NavLink to="/configuracion/periodos" className={link}>Periodos</NavLink>}
            {can('ledger.read') && <NavLink to="/configuracion/tipos-cambio" className={link}>Tipo de cambio</NavLink>}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-muted">{me.fullName}</span>
            <button className="text-brand hover:underline" onClick={() => logout.mutate()}>Cerrar sesión</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Navigate to={can('ledger.read') ? '/partidas' : '/sin-acceso'} replace />} />
          <Route path="/partidas" element={<EntriesPage me={me} />} />
          <Route path="/partidas/nueva" element={<NewEntryPage />} />
          <Route path="/partidas/:id" element={<EntryPage me={me} />} />
          <Route path="/reportes/balance-comprobacion" element={<TrialBalancePage />} />
          <Route path="/presupuestos" element={<BudgetsPage me={me} />} />
          <Route path="/presupuestos/nuevo" element={<NewBudgetPage />} />
          <Route path="/presupuestos/:id" element={<BudgetPage me={me} />} />
          <Route path="/configuracion/cuentas" element={<AccountsPage me={me} />} />
          <Route path="/configuracion/periodos" element={<PeriodsPage me={me} />} />
          <Route path="/configuracion/tipos-cambio" element={<RatesPage me={me} />} />
          <Route path="/sin-acceso" element={<p className="text-sm text-muted">Su usuario no tiene módulos asignados. Contacte al administrador.</p>} />
          <Route path="*" element={<p className="text-sm text-muted">Página no encontrada.</p>} />
        </Routes>
      </main>
    </div>
  );
}

function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me'), retry: false });
  if (me.isPending) return <p className="p-6 text-sm text-muted">Cargando…</p>;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <LoginPage />;
    return <div className="p-6"><ErrorBox error={me.error} /></div>;
  }
  const user = me.data;
  if (user.mustChangePassword) return <ChangePasswordPage />;
  if (user.mfaRequired && !user.mfaVerified) return <MfaPage me={user} />;
  return <Shell me={user} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter><App /></BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
