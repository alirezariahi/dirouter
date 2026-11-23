/** SCIM provisioning tokens (card 22.1); only owners create or revoke them. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { API_URL } from '../config';
import { useSettings } from '../settings';
import { api } from '../lib/api';
import { formatDate } from '../lib/date';
import { errorMessage } from '../lib/errors';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Field, FormError } from './ui/field';
import { Loading } from './ui/states';

interface ScimToken {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function ScimTokens({ base, canManage }: { base: string; canManage: boolean }) {
  const { t } = useTranslation();
  const settings = useSettings();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string>();
  const tokens = useQuery({
    queryKey: ['scim-tokens', base],
    queryFn: () => api<ScimToken[]>(`${base}/scim/tokens`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['scim-tokens', base] });
  const create = useMutation({
    mutationFn: () =>
      api<{ token: string }>(`${base}/scim/tokens`, {
        method: 'POST',
        body: { name: name.trim() },
      }),
    onSuccess: (result) => {
      setCreated(result.token);
      setName('');
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`${base}/scim/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => void refresh(),
  });
  const failure = create.error ?? revoke.error;

  return (
    <Card>
      <h2 className="text-lg font-semibold">{t('s3.saml.scimTitle')}</h2>
      <p className="mt-1 text-sm text-muted">
        {t('s3.saml.scimHelp', { url: `${API_URL}/scim/v2` })}
      </p>
      <div className="mt-3">
        <FormError message={failure ? errorMessage(failure, t) : undefined} />
      </div>
      {created ? (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-300" data-testid="scim-token">
          {t('s3.saml.shownOnce')}{' '}
          <code dir="ltr" className="break-all">
            {created}
          </code>
        </p>
      ) : null}
      {tokens.isPending ? (
        <Loading />
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {(tokens.data ?? []).map((token) => (
            <li
              key={token.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2 text-sm"
            >
              <div>
                <p className="font-medium">{token.name}</p>
                <p dir="ltr" className="text-xs text-muted">
                  {token.prefix}…
                </p>
                <p className="text-xs text-muted">
                  {token.revokedAt
                    ? t('s3.saml.revoked')
                    : token.lastUsedAt
                      ? t('s3.saml.lastUsed', {
                          date: formatDate(token.lastUsedAt, {
                            calendar: settings.calendar,
                            lang: settings.lang,
                            time: true,
                          }),
                        })
                      : t('s3.saml.never')}
                </p>
              </div>
              {canManage && !token.revokedAt ? (
                <Button
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={revoke.isPending}
                  onClick={() => {
                    revoke.mutate(token.id);
                  }}
                >
                  {t('s3.saml.revoke')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <Field
            name="scim-token-name"
            label={t('s3.saml.tokenName')}
            required
            maxLength={100}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <Button type="submit" disabled={create.isPending}>
            {t('s3.saml.create')}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
