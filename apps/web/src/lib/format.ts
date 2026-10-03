import type { EntryStatus } from './api.ts';

/** Formats a decimal string as "Q 1,234.56" without converting to a JS number. */
export function formatMoney(value: string, currency = 'GTQ'): string {
  const negative = value.startsWith('-');
  const [intPart = '0', frac = ''] = (negative ? value.slice(1) : value).split('.');
  const grouped = intPart.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'GTQ' ? 'Q' : currency === 'USD' ? 'US$' : currency;
  return `${negative ? '-' : ''}${symbol} ${grouped}.${frac.padEnd(2, '0').slice(0, 2)}`;
}

export const STATUS_LABEL: Record<EntryStatus, string> = {
  DRAFT: 'Borrador',
  APPROVED: 'Aprobada',
  POSTED: 'Contabilizada',
  REVERSED: 'Revertida',
};

export const SCOPE_LABEL = {
  PROJECT: 'Proyecto',
  CONSOLIDATED: 'Consolidado institucional',
  ASSIGNED_PROJECTS: 'Proyectos asignados (no es consolidado institucional)',
} as const;
