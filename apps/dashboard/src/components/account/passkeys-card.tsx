/**
 * Passkeys of the signed-in user (card 14.1): list, add (browser ceremony with user verification
 * required) and remove. Rendered only when the browser supports WebAuthn.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatDate } from '../../lib/date';
import { errorMessage } from '../../lib/errors';
import type { SubmitEvent } from '../../lib/form';
import {
  isCancelled,
  listPasskeys,
  passkeysSupported,
  registerPasskey,
  removePasskey,
} from '../../lib/webauthn';
import { useSettings } from '../../settings';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Field, FormError } from '../ui/field';
import { Loading } from '../ui/states';

export function PasskeysCard() {
  const { t } = useTranslation();
  const settings = useSettings();
  const qc = useQueryClient();
  const supported = passkeysSupported();
  const [name, setName] = useState('');
  const [armed, setArmed] = useState<string>();

  const list = useQuery({ queryKey: ['passkeys'], queryFn: listPasskeys, enabled: supported });
  const refresh = () => qc.invalidateQueries({ queryKey: ['passkeys'] });
  const add = useMutation({
    mutationFn: () => registerPasskey(name),
    onSuccess: () => {
      setName('');
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: removePasskey,
    onSettled: () => {
      setArmed(undefined);
      void refresh();
    },
  });

  if (!supported) return null;
  const failure =
    (add.error && !isCancelled(add.error) ? add.error : null) ?? remove.error ?? list.error;
  const date = (iso: string) =>
    formatDate(iso, { calendar: settings.calendar, lang: settings.lang, time: true });

  return (
    <Card data-testid="passkeys-card" className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold">{t('s2.mfa.passkeys.title')}</h2>
        <p className="mt-1 text-xs text-muted">{t('s2.mfa.passkeys.help')}</p>
      </div>
      <FormError message={failure ? errorMessage(failure, t) : undefined} />
      {list.isPending ? (
        <Loading />
      ) : !list.data?.length ? (
        <p className="text-sm text-muted">{t('s2.mfa.passkeys.none')}</p>
      ) : (
        <ul data-testid="passkey-list" className="flex flex-col gap-2">
          {list.data.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2 text-sm"
            >
              <div>
                <p className="font-medium" dir="auto">
                  {item.name}
                </p>
                <p className="text-xs text-muted">
                  {t('s2.mfa.passkeys.added', { date: date(item.createdAt) })}
                  {' · '}
                  {item.lastUsedAt
                    ? t('s2.mfa.passkeys.lastUsed', { date: date(item.lastUsedAt) })
                    : t('s2.mfa.passkeys.neverUsed')}
                </p>
              </div>
              {armed === item.id ? (
                <span className="flex items-center gap-2">
                  <span className="text-xs">{t('s2.mfa.passkeys.removeConfirm')}</span>
                  <Button
                    className="h-7 px-2 text-xs"
                    disabled={remove.isPending}
                    onClick={() => {
                      remove.mutate(item.id);
                    }}
                  >
                    {t('s2.mfa.passkeys.remove')}
                  </Button>
                </span>
              ) : (
                <Button
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setArmed(item.id);
                  }}
                >
                  {t('s2.mfa.passkeys.remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event: SubmitEvent) => {
          event.preventDefault();
          add.mutate();
        }}
      >
        <Field
          name="passkey-name"
          label={t('s2.mfa.passkeys.name')}
          maxLength={60}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <div>
          <Button type="submit" disabled={add.isPending}>
            {t('s2.mfa.passkeys.add')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
