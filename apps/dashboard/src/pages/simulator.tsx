/**
 * Routing simulator (card 12.5): a dry-run of the gateway resolver for a model, alias or combo.
 * Shows the attempt order and the reason every skipped target was left out; nothing is sent upstream.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, FormError } from '../components/ui/field';
import { api } from '../lib/api';
import type { SubmitEvent } from '../lib/form';
import { errorMessage } from '../lib/errors';
import { currentOrg } from '../lib/session';

interface Skipped {
  modelId: string;
  credentialId?: string;
  reason: string;
}
interface Simulation {
  ok: boolean;
  status: number;
  requested?: string;
  kind?: 'model' | 'combo';
  combo?: { id: string; slug: string; strategy: string };
  fallbackOn?: string[];
  candidates?: { modelId: string; model: string; provider: string; credentialId: string }[];
  skipped?: Skipped[];
  neededTokens?: number;
  error?: { code?: string; message?: string };
}
interface KeyRow {
  id: string;
  name: string;
}
interface ModelRow {
  id: string;
  slug: string;
}

const list = <T,>(value: unknown): T[] =>
  Array.isArray(value)
    ? (value as T[])
    : Array.isArray((value as { items?: unknown } | undefined)?.items)
      ? (value as { items: T[] }).items
      : [];

export default function SimulatorPage() {
  const { t } = useTranslation();
  const org = currentOrg();
  const base = `/orgs/${org?.id ?? ''}`;
  const [model, setModel] = useState('');
  const [keyId, setKeyId] = useState('');
  const [inputTokens, setInputTokens] = useState('');
  const [maxOutput, setMaxOutput] = useState('');
  const [sessionKey, setSessionKey] = useState('');

  const keys = useQuery({
    queryKey: ['simulator-keys', org?.id],
    queryFn: () => api<unknown>(`${base}/keys`),
    enabled: Boolean(org),
  });
  const models = useQuery({
    queryKey: ['simulator-models', org?.id],
    queryFn: () => api<unknown>(`${base}/models`),
    enabled: Boolean(org),
  });
  const modelSlug = new Map(list<ModelRow>(models.data).map((m) => [m.id, m.slug]));

  const run = useMutation({
    mutationFn: () =>
      api<Simulation>(`${base}/routes/simulate`, {
        method: 'POST',
        body: {
          model: model.trim(),
          ...(keyId ? { virtualKeyId: keyId } : {}),
          ...(inputTokens ? { estimatedInputTokens: Number(inputTokens) } : {}),
          ...(maxOutput ? { maxOutputTokens: Number(maxOutput) } : {}),
          ...(sessionKey.trim() ? { sessionKey: sessionKey.trim() } : {}),
        },
      }),
  });
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (model.trim()) run.mutate();
  };

  const result = run.data;
  const routeError = result && !result.ok ? (result.error?.code ?? 'unavailable') : undefined;
  const skipped = result?.skipped ?? [];
  const candidates = result?.candidates ?? [];

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-bold">{t('s2.simulator.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('s2.simulator.subtitle')}</p>
      </header>

      <Card>
        <form onSubmit={submit} className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <Field
            name="model"
            label={t('s2.simulator.model')}
            dir="ltr"
            required
            list="simulator-models"
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
            }}
          />
          <datalist id="simulator-models">
            {list<ModelRow>(models.data).map((m) => (
              <option key={m.id} value={m.slug} />
            ))}
          </datalist>
          <label htmlFor="simulator-key" className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('s2.simulator.key')}</span>
            <select
              id="simulator-key"
              value={keyId}
              onChange={(event) => {
                setKeyId(event.target.value);
              }}
              className="h-10 rounded-md border border-border bg-surface px-3"
            >
              <option value="">{t('s2.simulator.anyKey')}</option>
              {list<KeyRow>(keys.data).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </label>
          <Field
            name="inputTokens"
            label={t('s2.simulator.inputTokens')}
            type="number"
            min={0}
            dir="ltr"
            value={inputTokens}
            onChange={(event) => {
              setInputTokens(event.target.value);
            }}
          />
          <Field
            name="maxOutputTokens"
            label={t('s2.simulator.maxOutputTokens')}
            type="number"
            min={1}
            dir="ltr"
            value={maxOutput}
            onChange={(event) => {
              setMaxOutput(event.target.value);
            }}
          />
          <Field
            name="sessionKey"
            label={t('s2.simulator.sessionKey')}
            dir="ltr"
            value={sessionKey}
            onChange={(event) => {
              setSessionKey(event.target.value);
            }}
          />
          <div className="flex items-end">
            <Button type="submit" disabled={run.isPending || !model.trim()}>
              {result ? t('s2.simulator.again') : t('s2.simulator.run')}
            </Button>
          </div>
        </form>
        <p className="mt-3 text-xs text-muted">{t('s2.simulator.hint')}</p>
      </Card>

      {run.isError ? <FormError message={errorMessage(run.error, t)} /> : null}

      {result ? (
        <>
          {routeError ? (
            <FormError
              message={`${t(`s2.simulator.error.${routeError}`, { defaultValue: routeError })}${
                result.neededTokens !== undefined
                  ? ` (${t('s2.simulator.neededTokens')}: ${String(result.neededTokens)})`
                  : ''
              }`}
            />
          ) : (
            <Card>
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <h2 className="text-base font-semibold">{t('s2.simulator.candidates')}</h2>
                {result.kind ? (
                  <span className="text-muted">{t(`s2.simulator.kind.${result.kind}`)}</span>
                ) : null}
                {result.combo ? (
                  <span className="text-muted">
                    {t('s2.simulator.strategy')}: <span dir="ltr">{result.combo.strategy}</span>
                  </span>
                ) : null}
                {result.fallbackOn?.length ? (
                  <span className="text-muted">
                    {t('s2.simulator.fallbackOn')}:{' '}
                    <span dir="ltr">{result.fallbackOn.join(', ')}</span>
                  </span>
                ) : null}
              </div>
              {candidates.length === 0 ? (
                <p className="text-sm text-muted">{t('s2.simulator.noCandidates')}</p>
              ) : (
                <ol data-testid="simulator-candidates" className="flex flex-col gap-2">
                  {candidates.map((c, index) => (
                    <li
                      key={`${c.modelId}:${c.credentialId}`}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-border px-3 py-2 text-sm"
                    >
                      <span className="w-6 text-muted">{index + 1}</span>
                      <span dir="ltr" className="font-medium">
                        {c.model}
                      </span>
                      <span className="text-muted">
                        {t('s2.simulator.provider')}: <span dir="ltr">{c.provider}</span>
                      </span>
                      <span className="text-muted">
                        {t('s2.simulator.credential')}: <span dir="ltr">{c.credentialId}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          )}

          <Card>
            <h2 className="mb-3 text-base font-semibold">{t('s2.simulator.skipped')}</h2>
            {skipped.length === 0 ? (
              <p className="text-sm text-muted">{t('s2.simulator.noneSkipped')}</p>
            ) : (
              <table data-testid="simulator-skipped" className="w-full text-sm">
                <thead>
                  <tr className="text-start text-xs text-muted">
                    <th className="py-1 text-start font-medium">{t('s2.simulator.target')}</th>
                    <th className="py-1 text-start font-medium">{t('s2.simulator.credential')}</th>
                    <th className="py-1 text-start font-medium">{t('s2.simulator.reasonTitle')}</th>
                  </tr>
                </thead>
                <tbody>
                  {skipped.map((s, index) => (
                    <tr
                      key={`${s.modelId}:${s.credentialId ?? ''}:${String(index)}`}
                      className="border-t border-border"
                    >
                      <td className="py-1.5" dir="ltr">
                        {modelSlug.get(s.modelId) ?? s.modelId}
                      </td>
                      <td className="py-1.5" dir="ltr">
                        {s.credentialId ?? '—'}
                      </td>
                      <td className="py-1.5">
                        {t(`s2.simulator.reason.${s.reason}`, { defaultValue: s.reason })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      ) : null}
    </section>
  );
}
