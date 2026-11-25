/** Sign in and sign up (email and password, or the portal's OIDC provider). */
import { useQuery } from '@tanstack/react-query';
import { type SyntheticEvent, useEffect, useState } from 'react';

import { api, ApiError } from '../lib/api';
import { usd } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { Link } from '../lib/link';
import { navigate, query } from '../lib/router';
import { type SessionResponse, start } from '../lib/session';
import { Button, Card, Field, Notice } from '../lib/ui';

interface PortalConfig {
  signupEnabled: boolean;
  /** False when the server cannot send the verification email (no SMTP). */
  passwordSignup?: boolean;
  oidc: { enabled: boolean; name?: string };
  welcomeCreditUsd: string;
}

export function AuthPage({
  mode,
  onSignedIn,
}: {
  mode: 'signin' | 'signup';
  onSignedIn: () => void;
}) {
  const { t } = useI18n();
  const config = useQuery({
    queryKey: ['portal-config'],
    queryFn: () => api<PortalConfig>('/portal/config'),
  });
  const [form, setForm] = useState({ name: '', email: '', password: '', organizationName: '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (field: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm({ ...form, [field]: e.target.value });
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const session =
        mode === 'signup'
          ? await api<SessionResponse>('/portal/signup', {
              method: 'POST',
              body: {
                name: form.name,
                email: form.email,
                password: form.password,
                ...(form.organizationName ? { organizationName: form.organizationName } : {}),
              },
            })
          : await api<SessionResponse>('/auth/login', {
              method: 'POST',
              body: { email: form.email, password: form.password },
            });
      await start(session);
      onSignedIn();
      navigate('/app');
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    } finally {
      setBusy(false);
    }
  };

  const oidc = async () => {
    const { authorizationUrl } = await api<{ authorizationUrl: string }>('/portal/oidc/start', {
      method: 'POST',
    });
    window.location.assign(authorizationUrl);
  };

  const closed = mode === 'signup' && config.data && !config.data.signupEnabled;
  const noPasswordSignup =
    mode === 'signup' && config.data?.signupEnabled && config.data.passwordSignup === false;
  const welcome = config.data?.welcomeCreditUsd;
  return (
    <div className="mx-auto max-w-sm py-10">
      <Card title={mode === 'signup' ? t.signUp : t.signIn}>
        {closed ? (
          <Notice>{t.signupClosed}</Notice>
        ) : noPasswordSignup ? (
          <Notice>{t.passwordSignupOff}</Notice>
        ) : (
          <form className="space-y-3" onSubmit={(e) => void submit(e)}>
            {mode === 'signup' && welcome && Number(welcome) > 0 && (
              <Notice tone="success">
                {t.welcomeCredit}: {usd(welcome)} — {t.welcomeAfterVerify}
              </Notice>
            )}
            {mode === 'signup' && (
              <Field
                label={t.name}
                value={form.name}
                onChange={set('name')}
                required
                autoComplete="name"
              />
            )}
            <Field
              label={t.email}
              type="email"
              value={form.email}
              onChange={set('email')}
              required
              autoComplete="email"
              dir="ltr"
            />
            <Field
              label={t.password}
              type="password"
              value={form.password}
              onChange={set('password')}
              required
              minLength={mode === 'signup' ? 10 : 1}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              dir="ltr"
            />
            {mode === 'signup' && (
              <Field
                label={t.workspace}
                value={form.organizationName}
                onChange={set('organizationName')}
              />
            )}
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" disabled={busy} className="w-full">
              {mode === 'signup' ? t.createAccount : t.signIn}
            </Button>
          </form>
        )}
        {config.data?.oidc.enabled && (
          <Button variant="quiet" className="mt-3 w-full" onClick={() => void oidc()}>
            {t.continueWith} {config.data.oidc.name}
          </Button>
        )}
        <p className="mt-4 text-center text-sm">
          <Link
            href={mode === 'signup' ? '/signin' : '/signup'}
            className="text-teal-700 hover:underline"
          >
            {mode === 'signup' ? t.haveAccount : t.noAccount}
          </Link>
        </p>
      </Card>
    </div>
  );
}

/** The OIDC provider sends the browser here with `code` and `state`. */
export function OAuthCallbackPage({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useI18n();
  const code = query('code');
  const state = query('state');
  // A provider error comes back without a code; show it at once.
  const [error, setError] = useState<string | undefined>(() =>
    code && state ? undefined : (query('error_description') ?? query('error') ?? t.error),
  );
  useEffect(() => {
    if (!code || !state) return;
    const params = new URLSearchParams({ code, state });
    api<SessionResponse>(`/portal/oidc/callback?${params.toString()}`)
      .then(start)
      .then(() => {
        onSignedIn();
        navigate('/app', true);
      })
      .catch((e: unknown) => {
        setError(e instanceof ApiError ? e.message : t.error);
      });
    // Runs once: the code is single use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="mx-auto max-w-sm py-10">
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : (
        <p className="text-stone-500">{t.loading}</p>
      )}
    </div>
  );
}
