import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, FormError } from '../components/ui/field';
import { text, type SubmitEvent } from '../lib/form';
import { errorMessage } from '../lib/errors';
import { login } from '../lib/session';

export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      await login(text(form, 'email'), text(form, 'password'));
      await navigate({ to: '/' });
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <h1 className="mb-4 text-xl font-bold">{t('auth.loginTitle')}</h1>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
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
          <Button type="submit" disabled={busy}>
            {busy ? t('auth.loggingIn') : t('auth.login')}
          </Button>
        </form>
      </Card>
    </main>
  );
}
