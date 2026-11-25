/**
 * Controls of automatic routing (card 32.8): the organization's cost tier, allowed and denied
 * models, administrator lock and reasoning effort; each key's own policy; the tier of every model.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Section, selectClass, textareaClass } from '../s2/common';
import { Button } from '../ui/button';
import { FormError } from '../ui/field';
import { Loading } from '../ui/states';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import type { SubmitEvent } from '../../lib/form';
import { listOf, useFormat } from '../../lib/s2-format';

type Tier = 'low' | 'medium' | 'high';
interface Policy {
  scope: 'organization' | 'key';
  scopeId: string;
  costTier: Tier | null;
  allowedModels: string[];
  deniedModels: string[];
  locked: boolean;
  reasoningEffort: 'auto' | 'off';
}
interface Overview {
  organization: Policy | null;
  keys: Policy[];
  tiers: { lowMaxPerMTok: string; mediumMaxPerMTok: string };
  models: { slug: string; blendedPerMTok: number; tier: Tier }[];
}
interface KeyRow {
  id: string;
  name: string;
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function PolicyForm({
  id,
  policy,
  organization,
  canWrite,
  onSave,
  onRemove,
  pending,
}: {
  id: string;
  policy: Policy | null | undefined;
  organization: boolean;
  canWrite: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onRemove: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const [tier, setTier] = useState<string>(policy?.costTier ?? '');
  const [allowed, setAllowed] = useState((policy?.allowedModels ?? []).join('\n'));
  const [denied, setDenied] = useState((policy?.deniedModels ?? []).join('\n'));
  const [locked, setLocked] = useState(policy?.locked ?? false);
  const [effort, setEffort] = useState<'auto' | 'off'>(policy?.reasoningEffort ?? 'auto');
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event: SubmitEvent) => {
        event.preventDefault();
        onSave({
          costTier: tier || null,
          allowedModels: lines(allowed),
          deniedModels: lines(denied),
          reasoningEffort: effort,
          ...(organization ? { locked } : {}),
        });
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <label htmlFor={`${id}-tier`} className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('routingPolicies.auto.costTier')}</span>
          <select
            id={`${id}-tier`}
            className={selectClass}
            disabled={!canWrite}
            value={tier}
            onChange={(e) => {
              setTier(e.target.value);
            }}
          >
            <option value="">{t('routingPolicies.auto.tiers.none')}</option>
            {(['low', 'medium', 'high'] as const).map((x) => (
              <option key={x} value={x}>
                {t(`routingPolicies.auto.tiers.${x}`)}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${id}-effort`} className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('routingPolicies.auto.reasoningEffort')}</span>
          <select
            id={`${id}-effort`}
            className={selectClass}
            disabled={!canWrite}
            value={effort}
            onChange={(e) => {
              setEffort(e.target.value === 'off' ? 'off' : 'auto');
            }}
          >
            <option value="auto">{t('routingPolicies.auto.effort.auto')}</option>
            <option value="off">{t('routingPolicies.auto.effort.off')}</option>
          </select>
        </label>
        <label htmlFor={`${id}-allowed`} className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('routingPolicies.auto.allowed')}</span>
          <textarea
            id={`${id}-allowed`}
            dir="ltr"
            className={textareaClass}
            disabled={!canWrite}
            value={allowed}
            onChange={(e) => {
              setAllowed(e.target.value);
            }}
          />
        </label>
        <label htmlFor={`${id}-denied`} className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('routingPolicies.auto.denied')}</span>
          <textarea
            id={`${id}-denied`}
            dir="ltr"
            className={textareaClass}
            disabled={!canWrite}
            value={denied}
            onChange={(e) => {
              setDenied(e.target.value);
            }}
          />
        </label>
      </div>
      {organization ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            disabled={!canWrite}
            checked={locked}
            onChange={(e) => {
              setLocked(e.target.checked);
            }}
          />
          {t('routingPolicies.auto.locked')}
        </label>
      ) : null}
      {canWrite ? (
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {t('routingPolicies.auto.save')}
          </Button>
          {policy ? (
            <Button type="button" variant="outline" disabled={pending} onClick={onRemove}>
              {t('routingPolicies.auto.remove')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

export function AutoPanel({ base, canWrite }: { base: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const { n } = useFormat();
  const qc = useQueryClient();
  const [keyId, setKeyId] = useState('');
  const overview = useQuery({
    queryKey: ['routing-auto', base],
    queryFn: () => api<Overview>(`${base}/routing/auto`),
  });
  const keys = useQuery({ queryKey: ['keys', base], queryFn: () => api<unknown>(`${base}/keys`) });
  const done = () => qc.invalidateQueries({ queryKey: ['routing-auto', base] });
  const save = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: Record<string, unknown> }) =>
      api<unknown>(`${base}/routing/auto${path}`, {
        method: body ? 'PUT' : 'DELETE',
        ...(body ? { body } : {}),
      }),
    onSuccess: done,
  });
  const data = overview.data;
  const keyName = new Map(listOf<KeyRow>(keys.data).map((k) => [k.id, k.name]));
  if (overview.isPending) return <Loading />;
  return (
    <>
      <FormError message={save.error ? errorMessage(save.error, t) : undefined} />
      {save.isSuccess ? (
        <p className="text-sm text-good">{t('routingPolicies.auto.saved')}</p>
      ) : null}
      <Section title={t('routingPolicies.auto.organization')} help={t('routingPolicies.auto.help')}>
        <p className="mb-3 text-xs text-muted">
          {t('routingPolicies.auto.tierHelp', {
            low: data?.tiers.lowMaxPerMTok ?? '1',
            medium: data?.tiers.mediumMaxPerMTok ?? '10',
          })}
        </p>
        <PolicyForm
          key={`org-${data?.organization?.scopeId ?? 'none'}`}
          id="auto-org"
          policy={data?.organization}
          organization
          canWrite={canWrite}
          pending={save.isPending}
          onSave={(body) => {
            save.mutate({ path: '', body });
          }}
          onRemove={() => {
            save.mutate({ path: '' });
          }}
        />
      </Section>
      <Section title={t('routingPolicies.auto.keys')}>
        {(data?.keys ?? []).length === 0 ? (
          <p className="text-sm text-muted">{t('routingPolicies.auto.noKeys')}</p>
        ) : (
          <ul className="mb-3 flex flex-col gap-1 text-sm" data-testid="auto-key-policies">
            {(data?.keys ?? []).map((p) => (
              <li key={p.scopeId}>
                {keyName.get(p.scopeId) ?? p.scopeId}:{' '}
                {t(`routingPolicies.auto.tiers.${p.costTier ?? 'none'}`)}
                {p.allowedModels.length > 0 ? (
                  <span className="text-muted">
                    {' '}
                    · <bdi dir="ltr">{p.allowedModels.join(', ')}</bdi>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <label htmlFor="auto-key" className="mb-3 flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('routingPolicies.auto.key')}</span>
          <select
            id="auto-key"
            className={selectClass}
            value={keyId}
            onChange={(e) => {
              setKeyId(e.target.value);
            }}
          >
            <option value="">—</option>
            {listOf<KeyRow>(keys.data).map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </label>
        {keyId ? (
          <PolicyForm
            key={keyId}
            id="auto-key-form"
            policy={data?.keys.find((p) => p.scopeId === keyId)}
            organization={false}
            canWrite={canWrite}
            pending={save.isPending}
            onSave={(body) => {
              save.mutate({ path: `/keys/${keyId}`, body });
            }}
            onRemove={() => {
              save.mutate({ path: `/keys/${keyId}` });
            }}
          />
        ) : null}
      </Section>
      <Section title={t('routingPolicies.auto.models')}>
        <ul className="grid gap-1 text-xs md:grid-cols-3" data-testid="auto-model-tiers">
          {(data?.models ?? []).map((m) => (
            <li key={m.slug}>
              <bdi dir="ltr">{m.slug}</bdi> · {t(`routingPolicies.auto.tiers.${m.tier}`)} ($
              {n(Math.round(m.blendedPerMTok * 100) / 100)})
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
