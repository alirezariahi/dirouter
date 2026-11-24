/**
 * Request body capture levels (card 24.1): one explicit level per organization, project or key,
 * or none (inherit). Shown on the Log Explorer to members holding `logs:bodies`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { bodyMessages } from '../i18n/body-messages';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatNumber } from '../lib/date';
import { useSettings } from '../settings';
import { Section, selectClass } from './s2/common';
import { Button } from './ui/button';
import { FormError } from './ui/field';
import { ErrorState, Loading } from './ui/states';

type Level = 'none' | 'metadata' | 'full';
type Scope = 'organization' | 'project' | 'key';
interface Levels {
  defaultLevel: Level;
  maxBytes: number;
  rules: { scope: Scope; scopeId: string; level: Level }[];
}
interface Named {
  id: string;
  name: string;
}

const LEVELS: Level[] = ['none', 'metadata', 'full'];

export function BodyCaptureSettings({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const s = useSettings();
  const m = bodyMessages[s.lang];
  const client = useQueryClient();
  const base = `/orgs/${orgId}`;
  const levels = useQuery({
    queryKey: ['body-capture', orgId],
    queryFn: () => api<Levels>(`${base}/body-capture`),
  });
  const projects = useQuery({
    queryKey: ['body-capture-projects', orgId],
    queryFn: () => api<Named[]>(`${base}/projects`),
  });
  const keys = useQuery({
    queryKey: ['body-capture-keys', orgId],
    queryFn: () => api<Named[]>(`${base}/keys`),
  });
  const [scope, setScope] = useState<Scope>('organization');
  const [target, setTarget] = useState('');
  const [level, setLevel] = useState<Level | 'inherit'>('metadata');
  const save = useMutation({
    mutationFn: (body: { scope: Scope; scopeId: string; level: Level | 'inherit' }) =>
      api(`${base}/body-capture`, { method: 'PUT', body }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['body-capture', orgId] }),
  });

  if (levels.isPending) return <Loading />;
  if (levels.error)
    return <ErrorState error={levels.error} onRetry={() => void levels.refetch()} />;
  const choices: Record<Scope, Named[]> = {
    organization: [{ id: orgId, name: m.organization }],
    project: Array.isArray(projects.data) ? projects.data : [],
    key: Array.isArray(keys.data) ? keys.data : [],
  };
  // Defensive: an older control plane (or a test double) may answer without these fields.
  const rules = Array.isArray(levels.data.rules) ? levels.data.rules : [];
  const defaultLevel = LEVELS.includes(levels.data.defaultLevel)
    ? levels.data.defaultLevel
    : 'none';
  const nameOf = (ruleScope: Scope, id: string) =>
    choices[ruleScope].find((item) => item.id === id)?.name ?? id;
  const scopeId = scope === 'organization' ? orgId : target;

  return (
    <Section title={m.captureTitle} help={m.captureHelp}>
      <p className="text-sm text-muted" data-testid="body-capture-default">
        {m.defaultLevel}: {m.levels[defaultLevel]} · {m.maxBytes}:{' '}
        {formatNumber(levels.data.maxBytes, s.lang)}
      </p>
      <h3 className="text-sm font-medium">{m.rules}</h3>
      {rules.length === 0 ? (
        <p className="text-sm text-muted">{m.noRules}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm" data-testid="body-capture-rules">
          {rules.map((rule) => (
            <li key={`${rule.scope}:${rule.scopeId}`} className="flex items-center gap-2">
              <span>
                {m[rule.scope]}: <bdi>{nameOf(rule.scope, rule.scopeId)}</bdi> →{' '}
                {m.levels[rule.level]}
              </span>
              <Button
                variant="ghost"
                onClick={() => {
                  save.mutate({ scope: rule.scope, scopeId: rule.scopeId, level: 'inherit' });
                }}
              >
                {m.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (scopeId) save.mutate({ scope, scopeId, level });
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span>{m.scope}</span>
          <select
            aria-label={m.scope}
            className={selectClass}
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as Scope);
              setTarget('');
            }}
          >
            {(['organization', 'project', 'key'] as const).map((value) => (
              <option key={value} value={value}>
                {m[value]}
              </option>
            ))}
          </select>
        </label>
        {scope !== 'organization' ? (
          <label className="flex flex-col gap-1 text-sm">
            <span>{m.target}</span>
            <select
              aria-label={m.target}
              className={selectClass}
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
              }}
            >
              <option value="">—</option>
              {choices[scope].map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-sm">
          <span>{m.level}</span>
          <select
            aria-label={m.level}
            className={selectClass}
            value={level}
            onChange={(event) => {
              setLevel(event.target.value as Level | 'inherit');
            }}
          >
            {LEVELS.map((value) => (
              <option key={value} value={value}>
                {m.levels[value]}
              </option>
            ))}
            <option value="inherit">{m.inherit}</option>
          </select>
        </label>
        <Button type="submit" disabled={!scopeId || save.isPending}>
          {m.save}
        </Button>
      </form>
      <FormError message={save.isError ? errorMessage(save.error, t) : undefined} />
    </Section>
  );
}
