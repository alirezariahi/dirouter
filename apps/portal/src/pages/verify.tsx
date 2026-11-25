/**
 * Email verification (card 23.4): the page the emailed link opens, and the notice an unverified
 * user sees until then, with a button to send the link again.
 */
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Link } from '../lib/link';
import { query } from '../lib/router';
import { me, restore } from '../lib/session';
import { Button, Card, Notice } from '../lib/ui';

/** Opens `/verify-email?token=…`; works signed in or not. */
export function VerifyEmailPage({ onVerified }: { onVerified: () => void }) {
  const { t } = useI18n();
  const token = query('token');
  const [state, setState] = useState<{ ok: boolean; message?: string } | undefined>(() =>
    token ? undefined : { ok: false, message: t.verifyInvalid },
  );
  useEffect(() => {
    if (!token) return;
    api<{ verified: true }>('/portal/verify-email', { method: 'POST', body: { token } })
      .then(async () => {
        // A signed-in user sees the unlocked account at once.
        if (me()) await restore();
        onVerified();
        setState({ ok: true });
      })
      .catch((e: unknown) => {
        setState({ ok: false, message: e instanceof ApiError ? e.message : t.error });
      });
    // Runs once: the link is single use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="mx-auto max-w-sm py-10">
      <Card title={t.verifyTitle}>
        {!state ? (
          <p className="text-stone-500">{t.loading}</p>
        ) : state.ok ? (
          <div className="space-y-4">
            <Notice tone="success">{t.verifyDone}</Notice>
            <Link
              href={me() ? '/app' : '/signin'}
              className="inline-block text-sm font-medium text-teal-700 hover:underline"
            >
              {me() ? t.home : t.signIn}
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <Notice tone="error">{state.message}</Notice>
            <p className="text-sm text-stone-600">{t.verifyAgainHint}</p>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Shown on the signed-in pages until the address is verified. */
export function VerifyNotice() {
  const { t } = useI18n();
  const resend = useMutation({
    mutationFn: () => api<{ sent: boolean }>('/portal/verify-email/resend', { method: 'POST' }),
  });
  if (me()?.emailVerified !== false) return null;
  return (
    <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-medium">{t.verifyPending}</p>
      <p className="mt-1">{t.verifyPendingHint}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          variant="quiet"
          disabled={resend.isPending}
          onClick={() => {
            resend.mutate();
          }}
        >
          {t.verifyResend}
        </Button>
        {resend.data && <span>{resend.data.sent ? t.verifyResent : t.verifySendFailed}</span>}
        {resend.error && <span className="text-red-700">{resend.error.message}</span>}
      </div>
    </div>
  );
}
