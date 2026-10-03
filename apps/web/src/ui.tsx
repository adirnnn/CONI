import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import type { EntryStatus } from './lib/api.ts';
import { STATUS_LABEL } from './lib/format.ts';

export function Button({ variant = 'primary', className = '', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const styles = {
    primary: 'bg-brand text-white hover:bg-brand-strong disabled:opacity-50',
    secondary: 'bg-white text-ink border border-line hover:bg-canvas disabled:opacity-50',
    danger: 'bg-white text-danger border border-danger/40 hover:bg-danger/5 disabled:opacity-50',
  }[variant];
  return (
    <button
      className={`rounded-md px-3.5 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${styles} ${className}`}
      {...props}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const control = 'w-full rounded-md border border-line bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';

export const Input = ({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) =>
  <input className={`${control} ${className}`} {...props} />;
export const Select = ({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) =>
  <select className={`${control} ${className}`} {...props} />;

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel">
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Ocurrió un error';
  return <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{message}</p>;
}

export function StatusBadge({ status }: { status: EntryStatus }) {
  const tone = {
    DRAFT: 'bg-canvas text-muted border-line',
    APPROVED: 'bg-warn/10 text-warn border-warn/30',
    POSTED: 'bg-ok/10 text-ok border-ok/30',
    REVERSED: 'bg-danger/5 text-danger border-danger/30',
  }[status];
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${tone}`}>{STATUS_LABEL[status]}</span>;
}

export function CenteredPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-panel p-6 shadow-sm">
        <p className="text-xs font-semibold tracking-wide text-brand uppercase">Asociación CONI</p>
        <h1 className="mb-5 mt-1 text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}
