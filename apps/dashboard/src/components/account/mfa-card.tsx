/**
 * TOTP enrollment for the signed-in user (card 14.1): start, confirm with a code, show the one-time
 * recovery codes exactly once, replace the authenticator (needs the current code) and disable with
 * a code. The secret is shown as text and as an `otpauth://` link; no QR code is drawn because the
 * dashboard has no QR dependency.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../lib/api';
import type { SubmitEvent } from '../../lib/form';
import { formatNumber } from '../../lib/date';
import { errorMessage } from '../../lib/errors';
import { useSettings } from '../../settings';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Field, FormError } from '../ui/field';
import { Loading } from '../ui/states';

interface MfaStatus {
  enabled: boolean;
  pending: boolean;
  backupCodesRemaining: number;
}
interface Enrollment {
  secret: string;
  otpauthUrl: string;
}

export function MfaCard() {
  const { t } = useTranslation();
  const settings = useSettings();
  const qc = useQueryClient();
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [backupCodes, setBackupCodes] = useState<string[]>();
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [replaceCode, setReplaceCode] = useState('');

  const status = useQuery({ queryKey: ['mfa'], queryFn: () => api<MfaStatus>('/auth/mfa') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['mfa'] });

  const begin = useMutation({
    // Replacing an enabled authenticator requires the current code; a first setup sends no body.
    mutationFn: (currentCode?: string) =>
      api<Enrollment>('/auth/mfa/setup', {
        method: 'POST',
        ...(currentCode ? { body: { code: currentCode } } : {}),
      }),
    onSuccess: (data) => {
      setEnrollment(data);
      setReplaceCode('');
      setBackupCodes(undefined);
      void refresh();
    },
  });
  const verify = useMutation({
    mutationFn: () =>
      api<{ backupCodes: string[] }>('/auth/mfa/verify', {
        method: 'POST',
        body: { code: code.replace(/\s+/g, '') },
      }),
    onSuccess: (data) => {
      setBackupCodes(data.backupCodes);
      setEnrollment(undefined);
      setCode('');
      void refresh();
    },
  });
  const disable = useMutation({
    mutationFn: () =>
      api<unknown>('/auth/mfa/disable', {
        method: 'POST',
        body: { code: disableCode.replace(/\s+/g, '') },
      }),
    onSuccess: () => {
      setDisableCode('');
      void refresh();
    },
  });

  if (status.isPending) return <Loading />;
  const s = status.data;
  const failure = begin.error ?? verify.error ?? disable.error ?? status.error;

  return (
    <Card data-testid="mfa-card" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t('s2.mfa.title')}</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            s?.enabled ? 'bg-good/15 text-good' : 'bg-border/60 text-muted'
          }`}
        >
          {s?.enabled ? t('s2.mfa.enabled') : t('s2.mfa.disabled')}
        </span>
      </div>
      <FormError message={failure ? errorMessage(failure, t) : undefined} />

      {backupCodes ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <h3 className="text-sm font-medium">{t('s2.mfa.backupTitle')}</h3>
          <p className="text-xs text-muted">{t('s2.mfa.backupHelp')}</p>
          <ul
            dir="ltr"
            data-testid="mfa-backup-codes"
            className="grid grid-cols-2 gap-1 font-mono text-sm"
          >
            {backupCodes.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(backupCodes.join('\n')).then(() => {
                  setCopied(true);
                });
              }}
            >
              {copied ? t('s2.mfa.backupCopied') : t('s2.mfa.copy')}
            </Button>
            <Button
              onClick={() => {
                setBackupCodes(undefined);
                setCopied(false);
              }}
            >
              {t('s2.mfa.done')}
            </Button>
          </div>
        </div>
      ) : null}

      {enrollment ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event: SubmitEvent) => {
            event.preventDefault();
            verify.mutate();
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('s2.mfa.secret')}</span>
            <code
              dir="ltr"
              data-testid="mfa-secret"
              className="break-all rounded bg-border/40 px-2 py-1"
            >
              {enrollment.secret}
            </code>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('s2.mfa.otpauth')}</span>
            <code dir="ltr" className="break-all rounded bg-border/40 px-2 py-1 text-xs">
              {enrollment.otpauthUrl}
            </code>
          </label>
          <a
            href={enrollment.otpauthUrl}
            dir="auto"
            className="self-start text-sm text-brand underline"
            data-testid="mfa-otpauth-link"
          >
            {t('s2.mfa.otpauthOpen')}
          </a>
          <Field
            name="code"
            label={t('s2.mfa.code')}
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
          <div>
            <Button type="submit" disabled={verify.isPending}>
              {t('s2.mfa.confirm')}
            </Button>
          </div>
        </form>
      ) : s?.enabled ? (
        <>
          <p className="text-sm text-muted">
            {t('s2.mfa.backupRemaining', {
              n: formatNumber(s.backupCodesRemaining, settings.lang),
            })}
          </p>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event: SubmitEvent) => {
              event.preventDefault();
              disable.mutate();
            }}
          >
            <Field
              name="disableCode"
              label={t('s2.mfa.disableCode')}
              dir="ltr"
              autoComplete="one-time-code"
              required
              value={disableCode}
              onChange={(event) => {
                setDisableCode(event.target.value);
              }}
            />
            <p className="text-xs text-muted">{t('s2.mfa.disableWarn')}</p>
            <div>
              <Button type="submit" variant="outline" disabled={disable.isPending}>
                {t('s2.mfa.disable')}
              </Button>
            </div>
          </form>
          <form
            className="flex flex-col gap-2 border-t border-border pt-3"
            onSubmit={(event: SubmitEvent) => {
              event.preventDefault();
              begin.mutate(replaceCode.replace(/\s+/g, ''));
            }}
          >
            <h3 className="text-sm font-medium">{t('s2.mfa.replaceTitle')}</h3>
            <Field
              name="replaceCode"
              label={t('s2.mfa.replaceCode')}
              dir="ltr"
              autoComplete="one-time-code"
              required
              minLength={6}
              maxLength={16}
              value={replaceCode}
              onChange={(event) => {
                setReplaceCode(event.target.value);
              }}
            />
            <p className="text-xs text-muted">{t('s2.mfa.replaceHelp')}</p>
            <div>
              <Button type="submit" variant="outline" disabled={begin.isPending}>
                {t('s2.mfa.restart')}
              </Button>
            </div>
          </form>
        </>
      ) : (
        <>
          {s?.pending ? <p className="text-sm text-muted">{t('s2.mfa.pending')}</p> : null}
          <div>
            <Button
              disabled={begin.isPending}
              onClick={() => {
                begin.mutate(undefined);
              }}
            >
              {s?.pending ? t('s2.mfa.restart') : t('s2.mfa.start')}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
