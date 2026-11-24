/**
 * Sign-in sessions of the current user (card 23.5): every device with its address and last
 * activity, ending one session, all the others, or every session including this one.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../lib/api';
import { formatDate } from '../../lib/date';
import { errorMessage } from '../../lib/errors';
import { logout } from '../../lib/session';
import { useSettings } from '../../settings';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { FormError } from '../ui/field';
import { Loading } from '../ui/states';

export interface SessionInfo {
  id: string;
  device: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastActiveAt: string;
  method: 'pwd' | 'passkey' | 'sso';
  current: boolean;
}

/** One line of a session list; shared with the member view on the organization page. */
export function SessionLine({ session, action }: { session: SessionInfo; action?: ReactNode }) {
  const { t } = useTranslation();
  const settings = useSettings();
  const date = (iso: string) =>
    formatDate(iso, { calendar: settings.calendar, lang: settings.lang, time: true });
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2 text-sm"
      data-testid={`session-${session.id}`}
    >
      <div>
        <p className="font-medium" title={session.userAgent ?? undefined}>
          <span dir="ltr">{session.device}</span>
          {session.current ? (
            <span className="ms-2 rounded bg-brand/10 px-1.5 py-0.5 text-xs text-brand">
              {t('s4.sessions.current')}
            </span>
          ) : null}
        </p>
        <p className="text-xs text-muted">
          <span dir="ltr">{session.ip ?? t('s4.sessions.unknownIp')}</span>
          {' · '}
          {t(`s4.sessions.methods.${session.method}`)}
          {' · '}
          {t('s4.sessions.started', { date: date(session.createdAt) })}
          {' · '}
          {t('s4.sessions.lastActive', { date: date(session.lastActiveAt) })}
        </p>
      </div>
      {action}
    </li>
  );
}

export function SessionsCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string>();
  const list = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api<SessionInfo[]>('/auth/sessions'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['sessions'] });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void refresh(),
  });
  const revokeAll = useMutation({
    mutationFn: (includeCurrent: boolean) =>
      api<{ revoked: number }>('/auth/sessions/revoke-all', {
        method: 'POST',
        body: { includeCurrent },
      }),
    onSuccess: async (result, includeCurrent) => {
      if (includeCurrent) {
        await logout();
        await navigate({ to: '/login' });
        return;
      }
      setNotice(t('s4.sessions.revokedOthers', { count: result.revoked }));
      void refresh();
    },
  });
  const failure = list.error ?? revoke.error ?? revokeAll.error;
  const sessions = list.data ?? [];
  const busy = revoke.isPending || revokeAll.isPending;

  return (
    <Card data-testid="sessions-card" className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold">{t('s4.sessions.title')}</h2>
        <p className="mt-1 text-xs text-muted">{t('s4.sessions.help')}</p>
      </div>
      <FormError message={failure ? errorMessage(failure, t) : undefined} />
      {notice ? <p className="text-sm text-muted">{notice}</p> : null}
      {list.isPending ? (
        <Loading />
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted">{t('s4.sessions.none')}</p>
      ) : (
        <ul data-testid="session-list" className="flex flex-col gap-2">
          {sessions.map((session) => (
            <SessionLine
              key={session.id}
              session={session}
              action={
                session.current ? null : (
                  <Button
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={busy}
                    onClick={() => {
                      revoke.mutate(session.id);
                    }}
                  >
                    {t('s4.sessions.revoke')}
                  </Button>
                )
              }
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || sessions.filter((s) => !s.current).length === 0}
          onClick={() => {
            revokeAll.mutate(false);
          }}
        >
          {t('s4.sessions.revokeOthers')}
        </Button>
        <Button
          variant="outline"
          className="text-danger"
          disabled={busy}
          onClick={() => {
            if (window.confirm(t('s4.sessions.revokeEverywhereConfirm'))) revokeAll.mutate(true);
          }}
        >
          {t('s4.sessions.revokeEverywhere')}
        </Button>
      </div>
    </Card>
  );
}
