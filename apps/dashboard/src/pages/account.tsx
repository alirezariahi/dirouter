import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, FormError } from '../components/ui/field';
import { text, type SubmitEvent } from '../lib/form';
import { errorMessage, fieldError } from '../lib/errors';
import { changePassword } from '../lib/session';

export default function AccountPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      await changePassword(text(f, 'currentPassword'), text(f, 'newPassword'));
      await navigate({ to: '/login', search: { changed: 1 } as never });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex max-w-md flex-col gap-4">
      <h1 className="text-2xl font-bold">{t('auth.changePassword')}</h1>
      <Card>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <FormError message={error ? errorMessage(error, t) : undefined} />
          <Field
            label={t('auth.currentPassword')}
            name="currentPassword"
            type="password"
            required
            dir="ltr"
            autoComplete="current-password"
          />
          <Field
            label={t('auth.newPassword')}
            name="newPassword"
            type="password"
            required
            minLength={10}
            dir="ltr"
            autoComplete="new-password"
            error={fieldError(error, 'newPassword')}
          />
          <Button type="submit" disabled={busy}>
            {t('auth.save')}
          </Button>
        </form>
      </Card>
    </section>
  );
}
