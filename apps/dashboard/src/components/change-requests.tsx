/**
 * Pending change requests (card 22.2). Anyone with the operation's permission may approve, except
 * the requester, who may only cancel; the server enforces both, the UI only hides what cannot work.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { useSession } from '../lib/session';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { FormError } from './ui/field';

interface ChangeRequest {
  id: string;
  kind: string;
  summary: string;
  status: string;
  requestedById: string;
  createdAt: string;
}
interface Member {
  userId: string;
  email: string;
}

export function ChangeRequests({ base }: { base: string }) {
  const { t } = useTranslation();
  const session = useSession();
  const qc = useQueryClient();
  const pending = useQuery({
    queryKey: ['change-requests', base],
    queryFn: () =>
      api<ChangeRequest[]>(`${base}/change-requests`, { query: { status: 'pending' } }),
    retry: false,
  });
  const members = useQuery({
    queryKey: ['change-requests', base, 'members'],
    queryFn: () => api<Member[]>(`${base}/members`),
    retry: false,
  });
  const refresh = () => qc.invalidateQueries();
  const decide = useMutation({
    mutationFn: (input: { id: string; action: 'approve' | 'reject' }) =>
      api<ChangeRequest>(`${base}/change-requests/${input.id}/${input.action}`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: () => void refresh(),
  });
  // Members without audit access do not see the queue at all.
  if (pending.isError || !pending.data) return null;
  const who = (id: string) => members.data?.find((m) => m.userId === id)?.email ?? id;

  return (
    <Card>
      <h2 className="text-lg font-semibold">{t('s3.changes.title')}</h2>
      <p className="mt-1 text-sm text-muted">{t('s3.changes.help')}</p>
      <div className="mt-3">
        <FormError message={decide.error ? errorMessage(decide.error, t) : undefined} />
      </div>
      {pending.data.length === 0 ? (
        <p className="mt-2 text-sm text-muted">{t('s3.changes.none')}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2" data-testid="change-requests">
          {pending.data.map((request) => {
            const own = request.requestedById === session?.id;
            return (
              <li
                key={request.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium">{request.summary}</p>
                  <p className="text-xs text-muted">
                    {t('s3.changes.requestedBy', { who: who(request.requestedById) })}
                  </p>
                </div>
                <div className="flex gap-2">
                  {own ? null : (
                    <Button
                      className="h-7 px-2 text-xs"
                      disabled={decide.isPending}
                      onClick={() => {
                        decide.mutate({ id: request.id, action: 'approve' });
                      }}
                    >
                      {t('s3.changes.approve')}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={decide.isPending}
                    onClick={() => {
                      decide.mutate({ id: request.id, action: 'reject' });
                    }}
                  >
                    {own ? t('s3.changes.cancel') : t('s3.changes.reject')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
