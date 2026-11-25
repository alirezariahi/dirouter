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
import { formatNumber } from '../lib/date';
import type { SubmitEvent } from '../lib/form';
import { errorMessage } from '../lib/errors';
import { type DataPolicyView, dataPolicyText, reasonText } from '../lib/route-decision';
import { currentOrg } from '../lib/session';

interface Skipped {
  modelId: string;
  credentialId?: string;
  reason: string;
}
/** Live router inputs per candidate (card 25.4). */
interface Signals {
  latencyMs?: number;
  costMicroUsd?: number;
  recentRequests?: number;
  inFlight?: number;
  headroomTokens?: number;
  /** Output tokens per second (card 32.1). */
  throughputTps?: number;
}
type SignalStrategy = 'latency' | 'cost' | 'least-used' | 'headroom';
const SIGNAL_STRATEGIES: readonly string[] = ['latency', 'cost', 'least-used', 'headroom'];

/** The signal the combo's strategy sorted on, formatted for one candidate. */
function signalValue(
  strategy: SignalStrategy,
  signals: Signals | undefined,
  lang: 'fa' | 'en',
  t: (key: string) => string,
): string {
  if (!signals) return t('s2.simulator.noData');
  if (strategy === 'latency')
    return signals.latencyMs === undefined
      ? t('s2.simulator.noData')
      : `${formatNumber(signals.latencyMs, lang)} ms`;
  if (strategy === 'cost')
    return `$${formatNumber((signals.costMicroUsd ?? 0) / 1_000_000, lang, { maximumFractionDigits: 6 })}`;
  if (strategy === 'least-used')
    return `${formatNumber(signals.recentRequests ?? 0, lang)} + ${formatNumber(signals.inFlight ?? 0, lang)}`;
  return signals.headroomTokens === undefined
    ? t('s2.simulator.unlimited')
    : formatNumber(signals.headroomTokens, lang);
}

interface Simulation {
  ok: boolean;
  status: number;
  requested?: string;
  kind?: 'model' | 'combo';
  combo?: { id: string; slug: string; strategy: string };
  fallbackOn?: string[];
  candidates?: {
    modelId: string;
    model: string;
    provider: string;
    credentialId: string;
    signals?: Signals;
  }[];
  skipped?: Skipped[];
  neededTokens?: number;
  error?: { code?: string; message?: string };
  /** Provider preferences and fallback models (card 32.1). */
  models?: string[];
  preferences?: Record<string, unknown>;
  policy?: { lockProvider: boolean; sources: { scope: string; scopeId: string }[] };
  clientPreferencesIgnored?: boolean;
  /** Effective data policy (card 32.5). */
  dataPolicy?: DataPolicyView;
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
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'fa' ? 'fa' : 'en';
  const org = currentOrg();
  const base = `/orgs/${org?.id ?? ''}`;
  const [model, setModel] = useState(
    () => new URLSearchParams(window.location.search).get('model') ?? '',
  );
  const [keyId, setKeyId] = useState('');
  const [inputTokens, setInputTokens] = useState('');
  const [maxOutput, setMaxOutput] = useState('');
  const [sessionKey, setSessionKey] = useState('');
  const [providerJson, setProviderJson] = useState('');
  const [fallbackModels, setFallbackModels] = useState('');
  const [jsonError, setJsonError] = useState(false);

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
    mutationFn: (provider: Record<string, unknown> | undefined) =>
      api<Simulation>(`${base}/routes/simulate`, {
        method: 'POST',
        body: {
          model: model.trim(),
          ...(keyId ? { virtualKeyId: keyId } : {}),
          ...(inputTokens ? { estimatedInputTokens: Number(inputTokens) } : {}),
          ...(maxOutput ? { maxOutputTokens: Number(maxOutput) } : {}),
          ...(sessionKey.trim() ? { sessionKey: sessionKey.trim() } : {}),
          ...(provider ? { provider } : {}),
          ...(fallbacks.length > 0 ? { models: fallbacks } : {}),
        },
      }),
  });
  const fallbacks = fallbackModels
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!model.trim()) return;
    let provider: Record<string, unknown> | undefined;
    if (providerJson.trim()) {
      try {
        const parsed: unknown = JSON.parse(providerJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('');
        provider = parsed as Record<string, unknown>;
      } catch {
        setJsonError(true);
        return;
      }
    }
    setJsonError(false);
    run.mutate(provider);
  };

  const result = run.data;
  const routeError = result && !result.ok ? (result.error?.code ?? 'unavailable') : undefined;
  const skipped = result?.skipped ?? [];
  const candidates = result?.candidates ?? [];
  const strategy = result?.combo?.strategy;
  const signalStrategy =
    strategy && SIGNAL_STRATEGIES.includes(strategy) ? (strategy as SignalStrategy) : undefined;

  return (
    <section className="enter flex flex-col gap-6">
      <header>
        <h1 className="text-2xl leading-8 font-semibold">{t('s2.simulator.title')}</h1>
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
              className="h-10 rounded-lg border border-border bg-surface px-3"
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
          <Field
            name="fallbackModels"
            label={t('routingRequests.fallbackModels')}
            dir="ltr"
            value={fallbackModels}
            onChange={(event) => {
              setFallbackModels(event.target.value);
            }}
          />
          <label
            htmlFor="simulator-provider"
            className="flex flex-col gap-1 text-sm md:col-span-2 lg:col-span-3"
          >
            <span className="font-medium">{t('routingRequests.preferences')}</span>
            <textarea
              id="simulator-provider"
              dir="ltr"
              rows={2}
              value={providerJson}
              placeholder={t('routingRequests.preferencesHint')}
              onChange={(event) => {
                setProviderJson(event.target.value);
              }}
              className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs"
            />
          </label>
          <div className="flex items-end">
            <Button type="submit" disabled={run.isPending || !model.trim()}>
              {result ? t('s2.simulator.again') : t('s2.simulator.run')}
            </Button>
          </div>
        </form>
        <p className="mt-3 text-xs text-muted">{t('s2.simulator.hint')}</p>
      </Card>

      {run.isError ? <FormError message={errorMessage(run.error, t)} /> : null}
      {jsonError ? <FormError message={t('routingRequests.invalidJson')} /> : null}

      {result ? (
        <>
          {result.dataPolicy ? (
            <p className="text-sm text-muted" data-testid="simulator-data-policy">
              {t('routingRequests.dataPolicy')}: {dataPolicyText(t, result.dataPolicy)}
            </p>
          ) : null}
          {routeError ? (
            <FormError
              message={`${t(`s2.simulator.error.${routeError}`, {
                defaultValue: t(`routingRequests.error.${routeError}`, {
                  defaultValue: routeError,
                }),
              })}${
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
                  <span className="text-muted" data-testid="simulator-strategy">
                    {t('s2.simulator.strategy')}:{' '}
                    {t(`models.strategyType.${result.combo.strategy}`, {
                      defaultValue: result.combo.strategy,
                    })}
                  </span>
                ) : null}
                {result.fallbackOn?.length ? (
                  <span className="text-muted">
                    {t('s2.simulator.fallbackOn')}:{' '}
                    <span dir="ltr">{result.fallbackOn.join(', ')}</span>
                  </span>
                ) : null}
              </div>
              {result.models && result.models.length > 1 ? (
                <p className="mb-2 text-sm text-muted" data-testid="simulator-models">
                  {t('routingRequests.models')}: <span dir="ltr">{result.models.join(' → ')}</span>
                </p>
              ) : null}
              {result.preferences ? (
                <p className="mb-2 text-sm text-muted" data-testid="simulator-preferences">
                  {t('routingRequests.applied')}:{' '}
                  <code dir="ltr" className="text-xs">
                    {JSON.stringify(result.preferences)}
                  </code>
                </p>
              ) : null}
              {result.clientPreferencesIgnored ? (
                <p className="mb-2 text-sm text-warn">{t('routingRequests.locked')}</p>
              ) : result.policy?.lockProvider ? (
                <p className="mb-2 text-sm text-muted">{t('routingRequests.lockedPolicy')}</p>
              ) : null}
              {result.combo ? (
                <p className="mb-3 text-xs text-muted">
                  {t(`models.strategyHelp.${result.combo.strategy}`, { defaultValue: '' })}
                </p>
              ) : null}
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
                      {signalStrategy ? (
                        <span className="text-muted" data-testid="simulator-signal">
                          {t(`s2.simulator.signal.${signalStrategy}`)}:{' '}
                          <span dir="ltr">{signalValue(signalStrategy, c.signals, lang, t)}</span>
                        </span>
                      ) : null}
                      {c.signals?.throughputTps !== undefined ? (
                        <span className="text-muted" data-testid="simulator-throughput">
                          {t('routingRequests.throughput')}:{' '}
                          <span dir="ltr">
                            {formatNumber(c.signals.throughputTps, lang)} {t('routingRequests.tps')}
                          </span>
                        </span>
                      ) : null}
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
                      <td className="py-1.5">{reasonText(t, s.reason)}</td>
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
