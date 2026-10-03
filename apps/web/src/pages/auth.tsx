import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api, type Me } from '../lib/api.ts';
import { Button, CenteredPanel, ErrorBox, Field, Input } from '../ui.tsx';

export function LoginPage() {
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api('/auth/login', { method: 'POST', body: { username, password } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); login.mutate(); };
  return (
    <CenteredPanel title="Iniciar sesión">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Usuario"><Input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></Field>
        <Field label="Contraseña"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <ErrorBox error={login.error} />
        <Button type="submit" className="w-full" disabled={login.isPending}>{login.isPending ? 'Ingresando…' : 'Ingresar'}</Button>
      </form>
    </CenteredPanel>
  );
}

export function ChangePasswordPage({ onDone }: { onDone?: () => void }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const change = useMutation({
    mutationFn: () => {
      if (next !== confirm) throw new Error('Las contraseñas nuevas no coinciden');
      return api('/auth/password', { method: 'POST', body: { current, next } });
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['me'] }); onDone?.(); },
  });
  return (
    <CenteredPanel title="Cambiar contraseña">
      <p className="mb-4 text-sm text-muted">Debe establecer una contraseña personal de al menos 12 caracteres.</p>
      <form onSubmit={(e) => { e.preventDefault(); change.mutate(); }} className="space-y-4">
        <Field label="Contraseña actual"><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></Field>
        <Field label="Nueva contraseña"><Input type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} required /></Field>
        <Field label="Confirmar nueva contraseña"><Input type="password" autoComplete="new-password" minLength={12} value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></Field>
        <ErrorBox error={change.error} />
        <Button type="submit" className="w-full" disabled={change.isPending}>Guardar</Button>
      </form>
    </CenteredPanel>
  );
}

export function MfaPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [uri, setUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const enroll = useMutation({
    mutationFn: () => api<{ otpauthUri: string }>('/auth/mfa/enroll', { method: 'POST' }),
    onSuccess: (r) => setUri(r.otpauthUri),
  });
  const verify = useMutation({
    mutationFn: () => api('/auth/mfa/verify', { method: 'POST', body: { code } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  useEffect(() => { if (uri) QRCode.toDataURL(uri, { margin: 1, width: 200 }).then(setQr); }, [uri]);
  const secret = uri ? new URL(uri).searchParams.get('secret') : null;

  return (
    <CenteredPanel title="Verificación en dos pasos">
      {!me.mfaEnrolled && !uri ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">Su rol requiere un segundo factor. Necesitará una aplicación de autenticación (por ejemplo, Google Authenticator o Microsoft Authenticator).</p>
          <ErrorBox error={enroll.error} />
          <Button className="w-full" onClick={() => enroll.mutate()} disabled={enroll.isPending}>Configurar</Button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); verify.mutate(); }} className="space-y-4">
          {qr && (
            <div className="space-y-2 text-center">
              <img src={qr} alt="Código QR para la aplicación de autenticación" className="mx-auto" />
              <p className="text-xs text-muted">Clave manual: <code className="break-all">{secret}</code></p>
            </div>
          )}
          <Field label="Código de 6 dígitos">
            <Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
          </Field>
          <ErrorBox error={verify.error} />
          <Button type="submit" className="w-full" disabled={verify.isPending}>Verificar</Button>
        </form>
      )}
    </CenteredPanel>
  );
}
