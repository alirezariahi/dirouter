import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, FormError } from '../components/ui/field';
import { text, type SubmitEvent } from '../lib/form';
import { ApiError } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { login, passkeyLogin, ssoComplete, ssoStart, SsoStateError } from '../lib/session';
import { isCancelled, passkeysSupported } from '../lib/webauthn';

export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  // Return leg of single sign-on (card 14.2): the identity provider sends `code` and `state` here.
  const [ssoReturn] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    return code && state ? { code, state } : undefined;
  });
  const [busy, setBusy] = useState(ssoReturn !== undefined);
  // Shown after the server answers `mfa_required` (card 14.1); the password is submitted again with the code.
  const [needsMfa, setNeedsMfa] = useState(false);

  const formRef = useRef<HTMLFormElement>(null);

  // The code and the stored state are single-use; never exchange them twice (effects can re-run).
  const exchanged = useRef(false);

  useEffect(() => {
    if (!ssoReturn || exchanged.current) return;
    exchanged.current = true;
    // The code is single-use: drop it (and the state) from the address bar before exchanging it.
    const url = new URL(window.location.href);
    for (const name of ['code', 'state', 'session_state', 'iss']) url.searchParams.delete(name);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    ssoComplete(ssoReturn.code, ssoReturn.state)
      .then(() => navigate({ to: '/' }))
      .catch((err: unknown) => {
        setError(err instanceof SsoStateError ? t('s2.mfa.ssoState') : errorMessage(err, t));
      })
      .finally(() => {
        setBusy(false);
      });
    // Runs once for the URL the page was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSso() {
    const email = formRef.current ? text(new FormData(formRef.current), 'email').trim() : '';
    if (!email) {
      setError(t('s2.mfa.ssoEmail'));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const url = await ssoStart(email);
      if (url) window.location.assign(url);
      else setError(t('s2.mfa.ssoNone'));
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function onPasskey() {
    // With an email the prompt is limited to that account; without one the browser offers every
    // passkey it holds for this site.
    const email = formRef.current ? text(new FormData(formRef.current), 'email').trim() : '';
    setBusy(true);
    setError(undefined);
    try {
      await passkeyLogin(email || undefined);
      await navigate({ to: '/' });
    } catch (err) {
      if (!isCancelled(err)) setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const code = needsMfa ? text(form, 'mfaCode').replace(/\s+/g, '') : '';
      await login(text(form, 'email'), text(form, 'password'), code || undefined);
      await navigate({ to: '/' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_required') {
        setNeedsMfa(true);
        setError(undefined);
        return;
      }
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <h1 className="mb-4 text-xl font-bold">{t('auth.loginTitle')}</h1>
        <form ref={formRef} onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <FormError message={error} />
          <Field
            label={t('auth.email')}
            name="email"
            type="email"
            autoComplete="username"
            required
            dir="ltr"
          />
          <Field
            label={t('auth.password')}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            dir="ltr"
          />
          {needsMfa ? (
            <>
              <Field
                label={t('s2.mfa.loginCode')}
                name="mfaCode"
                inputMode="text"
                autoComplete="one-time-code"
                autoFocus
                required
                dir="ltr"
              />
              <p className="text-xs text-muted">{t('s2.mfa.loginHint')}</p>
            </>
          ) : null}
          <Button type="submit" disabled={busy}>
            {busy ? t('auth.loggingIn') : t('auth.login')}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void onSso()}>
            {t('s2.mfa.sso')}
          </Button>
          {passkeysSupported() ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void onPasskey()}
            >
              {t('s2.mfa.passkeyLogin')}
            </Button>
          ) : null}
        </form>
      </Card>
    </main>
  );
}
