/**
 * Invitation acceptance (card 3.5): the link `/invite/<token>` created on the Organization page.
 * A new account sends a name and a new password. An existing account sends its own password, is
 * subject to the login lockout, and is asked for its second factor when the server answers
 * `mfa_required`, exactly like the sign-in page.
 */
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, FormError } from '../components/ui/field';
import { ApiError } from '../lib/api';
import { errorMessage, fieldError } from '../lib/errors';
import { text, type SubmitEvent } from '../lib/form';
import { acceptInvitation } from '../lib/session';

export default function InvitePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token = '' } = useParams({ strict: false });
  const [existing, setExisting] = useState(false);
  const [needsMfa, setNeedsMfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [failure, setFailure] = useState<unknown>();

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = existing ? '' : text(form, 'name').trim();
    const mfaCode = needsMfa ? text(form, 'mfaCode').replace(/\s+/g, '') : '';
    setBusy(true);
    setError(undefined);
    setFailure(undefined);
    try {
      await acceptInvitation({
        token,
        password: text(form, 'password'),
        ...(name ? { name } : {}),
        ...(mfaCode ? { mfaCode } : {}),
      });
      await navigate({ to: '/' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_required') {
        // The account already exists and has a second factor: ask for it and submit again.
        setExisting(true);
        setNeedsMfa(true);
        return;
      }
      setFailure(err);
      if (err instanceof ApiError && err.code === 'not_found') setError(t('s2.mfa.invite.invalid'));
      else if (
        err instanceof ApiError &&
        err.code === 'validation_failed' &&
        !err.problem.errors?.length &&
        existing
      ) {
        // No account owns the invited email, so a name is needed to create one.
        setExisting(false);
        setError(t('s2.mfa.invite.nameRequired'));
      } else setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <h1 className="mb-2 text-xl font-bold">{t('s2.mfa.invite.title')}</h1>
        <p className="mb-4 text-xs text-muted">{t('s2.mfa.invite.help')}</p>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <FormError message={error} />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={existing}
              disabled={needsMfa}
              onChange={(event) => {
                setExisting(event.target.checked);
              }}
            />
            {t('s2.mfa.invite.existing')}
          </label>
          {existing ? null : (
            <Field
              label={t('s2.mfa.invite.name')}
              name="name"
              autoComplete="name"
              required
              maxLength={100}
            />
          )}
          <Field
            label={existing ? t('s2.mfa.invite.password') : t('s2.mfa.invite.newPassword')}
            name="password"
            type="password"
            autoComplete={existing ? 'current-password' : 'new-password'}
            required
            minLength={existing ? 1 : 10}
            dir="ltr"
            error={fieldError(failure, 'password')}
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
                minLength={6}
                maxLength={16}
                dir="ltr"
              />
              <p className="text-xs text-muted">{t('s2.mfa.loginHint')}</p>
            </>
          ) : null}
          <Button type="submit" disabled={busy || !token}>
            {busy ? t('s2.mfa.invite.accepting') : t('s2.mfa.invite.accept')}
          </Button>
          <Link to="/login" className="text-center text-sm text-brand underline">
            {t('s2.mfa.invite.toLogin')}
          </Link>
        </form>
      </Card>
    </main>
  );
}
