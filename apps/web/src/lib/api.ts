export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** JSON request to the API. Cookies carry the session; the CSRF header is always sent. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      'x-coni-csrf': '1',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? 'ERROR', data?.message ?? `Error ${res.status}`);
  }
  return data as T;
}

export interface Me {
  username: string;
  fullName: string;
  permissions: string[];
  allProjects: boolean;
  mfaRequired: boolean;
  mfaEnrolled: boolean;
  mfaVerified: boolean;
  mustChangePassword: boolean;
}

export interface Project { id: number; code: string; name: string; active: boolean }
export interface Account { id: number; code: string; name: string; type: string; parent_id: number | null; is_postable: boolean; requires_project: boolean; active: boolean }
export interface Period { id: number; code: string; start_date: string; end_date: string; status: 'OPEN' | 'CLOSED' }
export type EntryStatus = 'DRAFT' | 'APPROVED' | 'POSTED' | 'REVERSED';
export interface EntrySummary {
  id: string; entry_date: string; description: string; status: EntryStatus;
  created_by: string; approved_by: string | null; posted_by: string | null;
  reverses_entry_id: string | null; total_gtq: string;
}
export interface EntryLine {
  id: string; line_no: number; account_id: number; currency_code: string;
  debit_tx: string; credit_tx: string; rate: string; rate_source: string; rate_date: string;
  debit_gtq: string; credit_gtq: string; project_id: number | null; memo: string | null;
}
export interface EntryDetail {
  entry: EntrySummary & { period_id: number; source_type: string; source_id: string | null };
  lines: EntryLine[];
}
export interface TrialBalance {
  scope: 'PROJECT' | 'CONSOLIDATED' | 'ASSIGNED_PROJECTS';
  from: string; to: string; projectId: number | null;
  rows: { code: string; name: string; debit: string; credit: string }[];
}

export interface Currency { code: string; name: string; is_functional: boolean; banguat_code: number | null; enabled: boolean }
export interface Rate { currency_code: string; rate_date: string; rate: string; source: 'BANGUAT' | 'MANUAL'; justification: string | null; approved_by: string | null }
export interface SyncRun {
  id: string; started_at: string; finished_at: string | null; currency_code: string; date_from: string; date_to: string;
  inserted: number; unchanged: number; conflicts: number; status: 'RUNNING' | 'OK' | 'ERROR'; error: string | null;
}
export interface Setting { key: string; value: string; status: 'PROPUESTA' | 'APROBADO'; description: string }
