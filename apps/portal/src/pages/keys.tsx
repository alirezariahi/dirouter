/** API keys of the user's default project: create (shown once) and revoke. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SyntheticEvent, useState } from 'react';

import { api } from '../lib/api';
import { date } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { orgId } from '../lib/session';
import { Button, Card, CopyBlock, Field, Mono, Notice } from '../lib/ui';

interface Key {
  id: string;
  name: string;
  prefix: string;
  state: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function KeysPage() {
  const { t, lang } = useI18n();
  const client = useQueryClient();
  const org = orgId();
  const keys = useQuery({
    queryKey: ['keys', org],
    queryFn: () => api<Key[]>(`/orgs/${org}/keys`),
  });
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string>();

  const create = useMutation({
    mutationFn: async () => {
      const projects = await api<{ id: string; slug: string }[]>(`/orgs/${org}/projects`);
      const project = projects.find((p) => p.slug === 'default') ?? projects[0];
      return api<{ key: string }>(`/orgs/${org}/keys`, {
        method: 'POST',
        body: { name: name || 'default', projectId: project?.id },
      });
    },
    onSuccess: (created) => {
      setFresh(created.key);
      setName('');
      void client.invalidateQueries({ queryKey: ['keys', org] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/orgs/${org}/keys/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['keys', org] }),
  });

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    create.mutate();
  };
  const active = (keys.data ?? []).filter((k) => k.state === 'active');
  return (
    <div className="space-y-6">
      <Card title={t.createKey}>
        <form className="flex items-end gap-3" onSubmit={submit}>
          <div className="flex-1">
            <Field
              label={t.keyName}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              maxLength={100}
            />
          </div>
          <Button type="submit" disabled={create.isPending}>
            {t.createKey}
          </Button>
        </form>
        {create.error && <Notice tone="error">{create.error.message}</Notice>}
        {fresh && (
          <div className="mt-4 space-y-2">
            <Notice tone="success">{t.keyOnce}</Notice>
            <CopyBlock text={fresh} />
          </div>
        )}
      </Card>
      <Card title={t.keys}>
        {keys.isSuccess && active.length === 0 && <Notice>{t.noKeys}</Notice>}
        <ul className="divide-y divide-stone-100">
          {active.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-4 py-3">
              <div>
                <p className="font-medium text-stone-900">{k.name}</p>
                <p className="text-xs text-stone-500">
                  <Mono>{k.prefix}…</Mono> · {date(k.createdAt, lang)}
                </p>
              </div>
              <Button
                variant="danger"
                onClick={() => {
                  revoke.mutate(k.id);
                }}
                disabled={revoke.isPending}
              >
                {t.revoke}
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
