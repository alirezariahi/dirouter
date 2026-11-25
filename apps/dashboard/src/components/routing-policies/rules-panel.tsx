/**
 * Conditional routing rules (card 32.2): the ordered list with each rule's share of traffic, and a
 * form whose condition is checked by the server as you type (the same compiler the gateway uses).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Section, selectClass, textareaClass } from '../s2/common';
import { Button } from '../ui/button';
import { Field, FormError } from '../ui/field';
import { Loading } from '../ui/states';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import type { SubmitEvent } from '../../lib/form';
import { parsePairs } from '../../lib/pairs';
import { listOf, useFormat } from '../../lib/s2-format';

type Action =
  | { type: 'route'; target: string }
  | { type: 'reject'; message?: string; status: 400 | 403 | 429 }
  | { type: 'tag'; tags: Record<string, string> };
interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  teamId: string | null;
  condition: string;
  action: Action;
}
interface Traffic {
  totalRequests: number;
  rules: { id: string; matched: number; decided: number; share: number }[];
}
interface Team {
  id: string;
  name: string;
}

const EMPTY = {
  name: '',
  priority: '',
  teamId: '',
  condition: '',
  type: 'route' as Action['type'],
  target: '',
  message: '',
  status: '403',
  tags: '',
};

export function RulesPanel({ base, canWrite }: { base: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const { n } = useFormat();
  const qc = useQueryClient();
  const [draft, setDraft] = useState(EMPTY);
  const rules = useQuery({
    queryKey: ['routing-rules', base],
    queryFn: () => api<unknown>(`${base}/routing/rules`),
  });
  const traffic = useQuery({
    queryKey: ['routing-rules-traffic', base],
    queryFn: () => api<Traffic>(`${base}/routing/rules/traffic`),
  });
  const teams = useQuery({
    queryKey: ['teams', base],
    queryFn: () => api<unknown>(`${base}/teams`),
  });
  const done = () => qc.invalidateQueries({ queryKey: ['routing-rules', base] });

  const validate = useMutation({
    mutationFn: (condition: string) =>
      api<{ valid: boolean; problem?: string }>(`${base}/routing/rules/validate`, {
        method: 'POST',
        body: { condition },
      }),
  });
  const { mutate: check } = validate;
  useEffect(() => {
    if (!draft.condition.trim()) return;
    const timer = setTimeout(() => {
      check(draft.condition);
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [draft.condition, check]);

  const action = (): Action =>
    draft.type === 'route'
      ? { type: 'route', target: draft.target.trim() }
      : draft.type === 'reject'
        ? {
            type: 'reject',
            status: Number(draft.status) as 400 | 403 | 429,
            ...(draft.message.trim() ? { message: draft.message.trim() } : {}),
          }
        : { type: 'tag', tags: parsePairs(draft.tags, '=') };
  const create = useMutation({
    mutationFn: () =>
      api<unknown>(`${base}/routing/rules`, {
        method: 'POST',
        body: {
          name: draft.name.trim(),
          condition: draft.condition,
          action: action(),
          ...(draft.priority ? { priority: Number(draft.priority) } : {}),
          ...(draft.teamId ? { teamId: draft.teamId } : {}),
        },
      }),
    onSuccess: () => {
      setDraft(EMPTY);
      validate.reset();
      void done();
    },
  });
  const toggle = useMutation({
    mutationFn: (rule: Rule) =>
      api<unknown>(`${base}/routing/rules/${rule.id}`, {
        method: 'PATCH',
        body: { enabled: !rule.enabled },
      }),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<unknown>(`${base}/routing/rules/${id}`, { method: 'DELETE' }),
    onSuccess: done,
  });

  const set = (key: keyof typeof EMPTY, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const list = listOf<Rule>(rules.data);
  const share = new Map((traffic.data?.rules ?? []).map((r) => [r.id, r]));
  const teamName = new Map(listOf<Team>(teams.data).map((x) => [x.id, x.name]));
  const failure = create.error ?? toggle.error ?? remove.error ?? rules.error;
  const describe = (a: Action) =>
    a.type === 'route'
      ? `${t('routingPolicies.rules.actions.route')} ${a.target}`
      : a.type === 'reject'
        ? `${t('routingPolicies.rules.actions.reject')} (${String(a.status)})`
        : `${t('routingPolicies.rules.actions.tag')}: ${Object.entries(a.tags)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`;

  return (
    <>
      <FormError message={failure ? errorMessage(failure, t) : undefined} />
      <Section title={t('routingPolicies.tabs.rules')} help={t('routingPolicies.rules.help')}>
        {rules.isPending ? (
          <Loading />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted">{t('routingPolicies.rules.none')}</p>
        ) : (
          <ol data-testid="routing-rules" className="flex flex-col gap-2">
            {list.map((rule) => {
              const hit = share.get(rule.id);
              return (
                <li
                  key={rule.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium">
                      <span className="text-muted">{n(rule.priority)} · </span>
                      {rule.name}
                      {rule.teamId ? (
                        <span className="text-muted">
                          {' '}
                          · {t('routingPolicies.rules.team')}:{' '}
                          {teamName.get(rule.teamId) ?? rule.teamId}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted" dir="ltr">
                      {rule.condition}
                    </p>
                    <p className="text-xs text-muted">{describe(rule.action)}</p>
                    <p className="text-xs text-muted" data-testid={`rule-share-${rule.id}`}>
                      {t('routingPolicies.rules.share', {
                        share: `${n(Math.round((hit?.share ?? 0) * 1000) / 10)}%`,
                        matched: n(hit?.matched ?? 0),
                        decided: n(hit?.decided ?? 0),
                      })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted">
                      {rule.enabled
                        ? t('routingPolicies.rules.enabled')
                        : t('routingPolicies.rules.disabled')}
                    </span>
                    {canWrite ? (
                      <>
                        <Button
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={toggle.isPending}
                          onClick={() => {
                            toggle.mutate(rule);
                          }}
                        >
                          {rule.enabled
                            ? t('routingPolicies.rules.disable')
                            : t('routingPolicies.rules.enable')}
                        </Button>
                        <Button
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={remove.isPending}
                          onClick={() => {
                            remove.mutate(rule.id);
                          }}
                        >
                          {t('routingPolicies.rules.delete')}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {traffic.data ? (
          <p className="mt-2 text-xs text-muted">
            {t('routingPolicies.rules.traffic')} ·{' '}
            {t('routingPolicies.rules.total', { total: n(traffic.data.totalRequests) })}
          </p>
        ) : null}
      </Section>

      {canWrite ? (
        <Section title={t('routingPolicies.rules.newTitle')}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event: SubmitEvent) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <div className="grid gap-3 md:grid-cols-3">
              <Field
                name="rule-name"
                label={t('routingPolicies.rules.name')}
                required
                maxLength={100}
                value={draft.name}
                onChange={(e) => {
                  set('name', e.target.value);
                }}
              />
              <Field
                name="rule-priority"
                label={t('routingPolicies.rules.priority')}
                type="number"
                min={0}
                dir="ltr"
                value={draft.priority}
                onChange={(e) => {
                  set('priority', e.target.value);
                }}
              />
              <label htmlFor="rule-team" className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('routingPolicies.rules.scope')}</span>
                <select
                  id="rule-team"
                  className={selectClass}
                  value={draft.teamId}
                  onChange={(e) => {
                    set('teamId', e.target.value);
                  }}
                >
                  <option value="">{t('routingPolicies.rules.scopeOrg')}</option>
                  {listOf<Team>(teams.data).map((team) => (
                    <option key={team.id} value={team.id}>
                      {t('routingPolicies.rules.team')}: {team.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label htmlFor="rule-condition" className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('routingPolicies.rules.condition')}</span>
              <textarea
                id="rule-condition"
                dir="ltr"
                required
                maxLength={2000}
                className={textareaClass}
                value={draft.condition}
                onChange={(e) => {
                  set('condition', e.target.value);
                }}
              />
              <span className="text-xs text-muted">{t('routingPolicies.rules.conditionHelp')}</span>
              {validate.data && draft.condition.trim() ? (
                <span
                  data-testid="rule-condition-check"
                  className={validate.data.valid ? 'text-xs text-good' : 'text-xs text-danger'}
                >
                  {validate.data.valid ? t('routingPolicies.rules.valid') : validate.data.problem}
                </span>
              ) : null}
            </label>
            <div className="grid gap-3 md:grid-cols-3">
              <label htmlFor="rule-action" className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('routingPolicies.rules.action')}</span>
                <select
                  id="rule-action"
                  className={selectClass}
                  value={draft.type}
                  onChange={(e) => {
                    set('type', e.target.value);
                  }}
                >
                  {(['route', 'reject', 'tag'] as const).map((type) => (
                    <option key={type} value={type}>
                      {t(`routingPolicies.rules.actions.${type}`)}
                    </option>
                  ))}
                </select>
              </label>
              {draft.type === 'route' ? (
                <Field
                  name="rule-target"
                  label={t('routingPolicies.rules.target')}
                  dir="ltr"
                  required
                  value={draft.target}
                  onChange={(e) => {
                    set('target', e.target.value);
                  }}
                />
              ) : null}
              {draft.type === 'reject' ? (
                <>
                  <Field
                    name="rule-message"
                    label={t('routingPolicies.rules.message')}
                    maxLength={500}
                    value={draft.message}
                    onChange={(e) => {
                      set('message', e.target.value);
                    }}
                  />
                  <label htmlFor="rule-status" className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">{t('routingPolicies.rules.status')}</span>
                    <select
                      id="rule-status"
                      className={selectClass}
                      value={draft.status}
                      onChange={(e) => {
                        set('status', e.target.value);
                      }}
                    >
                      {['403', '400', '429'].map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}
              {draft.type === 'tag' ? (
                <label htmlFor="rule-tags" className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{t('routingPolicies.rules.tags')}</span>
                  <textarea
                    id="rule-tags"
                    dir="ltr"
                    className={textareaClass}
                    value={draft.tags}
                    onChange={(e) => {
                      set('tags', e.target.value);
                    }}
                  />
                </label>
              ) : null}
            </div>
            <div>
              <Button type="submit" disabled={create.isPending || validate.data?.valid === false}>
                {t('routingPolicies.rules.create')}
              </Button>
            </div>
          </form>
        </Section>
      ) : null}
    </>
  );
}
