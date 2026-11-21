/**
 * Model comparison playground (card 16.5): one prompt, up to four models side by side with the
 * answer, latency, tokens and estimated cost. Calls go through the gateway with a virtual key the
 * user created, so the usage is billed to that key. The key lives only in this component's state.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PageHeader, Section, textareaClass } from '../components/s2/common';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, FormError } from '../components/ui/field';
import { api } from '../lib/api';
import { listOf, useFormat } from '../lib/s2-format';
import type { SubmitEvent } from '../lib/form';
import { errorMessage } from '../lib/errors';
import { currentOrg } from '../lib/session';
import { MAX_MODELS, toggleModel } from '../lib/s2-helpers';

interface ModelRow {
  id: string;
  slug: string;
  enabled?: boolean;
}
interface Result {
  model: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  text?: string;
  resolvedModel?: string;
  provider?: string;
  cache?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: string;
  error?: { code?: string; message: string };
}
interface Comparison {
  apiKeyId: string;
  results: Result[];
}

export default function PlaygroundPage() {
  const { t } = useTranslation();
  const { n, usd } = useFormat();
  const org = currentOrg();
  const base = `/orgs/${org?.id ?? ''}`;
  const [apiKey, setApiKey] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [system, setSystem] = useState('');
  const [prompt, setPrompt] = useState('');
  const [maxTokens, setMaxTokens] = useState('512');
  const [temperature, setTemperature] = useState('');
  const [localError, setLocalError] = useState<string>();

  const models = useQuery({
    queryKey: ['playground-models', org?.id],
    queryFn: () => api<unknown>(`${base}/models`),
    enabled: Boolean(org),
  });
  const run = useMutation({
    mutationFn: () =>
      api<Comparison>(`${base}/playground/compare`, {
        method: 'POST',
        body: {
          apiKey: apiKey.trim(),
          models: selected,
          prompt,
          ...(system.trim() ? { system } : {}),
          maxTokens: Number(maxTokens) || 512,
          ...(temperature !== '' ? { temperature: Number(temperature) } : {}),
        },
      }),
  });
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (selected.length === 0) {
      setLocalError(t('s2.playground.pick'));
      return;
    }
    setLocalError(undefined);
    run.mutate();
  };
  const available = listOf<ModelRow>(models.data).filter((model) => model.enabled !== false);

  return (
    <section className="flex flex-col gap-4">
      <PageHeader title={t('s2.playground.title')} subtitle={t('s2.playground.subtitle')} />
      <Section title={t('s2.playground.title')}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field
            name="playground-key"
            label={t('s2.playground.key')}
            type="password"
            autoComplete="off"
            dir="ltr"
            required
            placeholder="dr-…"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
            }}
          />
          <p className="text-xs text-muted">{t('s2.playground.keyHelp')}</p>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">{t('s2.playground.models')}</legend>
            <div dir="ltr" data-testid="playground-models" className="flex flex-wrap gap-2">
              {available.map((model) => {
                const active = selected.includes(model.slug);
                return (
                  <button
                    key={model.id}
                    type="button"
                    aria-pressed={active}
                    disabled={!active && selected.length >= MAX_MODELS}
                    onClick={() => {
                      setSelected((current) => toggleModel(current, model.slug));
                    }}
                    className={`rounded-full border px-3 py-1 text-sm disabled:opacity-40 ${
                      active
                        ? 'border-brand bg-brand/10 text-brand'
                        : 'border-border hover:bg-border/40'
                    }`}
                  >
                    {model.slug}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <label htmlFor="playground-system" className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('s2.playground.system')}</span>
            <textarea
              id="playground-system"
              className={textareaClass}
              value={system}
              onChange={(event) => {
                setSystem(event.target.value);
              }}
            />
          </label>
          <label htmlFor="playground-prompt" className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('s2.playground.prompt')}</span>
            <textarea
              id="playground-prompt"
              required
              className={`${textareaClass} min-h-32`}
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
              }}
            />
          </label>
          <div className="grid max-w-md grid-cols-2 gap-3">
            <Field
              name="playground-max-tokens"
              label={t('s2.playground.maxTokens')}
              type="number"
              min={1}
              max={4096}
              dir="ltr"
              value={maxTokens}
              onChange={(event) => {
                setMaxTokens(event.target.value);
              }}
            />
            <Field
              name="playground-temperature"
              label={t('s2.playground.temperature')}
              type="number"
              min={0}
              max={2}
              step="0.1"
              dir="ltr"
              value={temperature}
              onChange={(event) => {
                setTemperature(event.target.value);
              }}
            />
          </div>
          <FormError
            message={localError ?? (run.isError ? errorMessage(run.error, t) : undefined)}
          />
          <div>
            <Button type="submit" disabled={run.isPending || !prompt.trim() || !apiKey.trim()}>
              {run.isPending ? t('s2.playground.running') : t('s2.playground.run')}
            </Button>
          </div>
        </form>
      </Section>

      {run.data ? (
        <>
          <p role="status" className="text-xs text-muted">
            {t('s2.playground.billed', { key: run.data.apiKeyId })}
          </p>
          <div
            data-testid="playground-results"
            className="grid gap-4"
            style={{
              gridTemplateColumns: `repeat(${String(Math.min(2, run.data.results.length))}, minmax(0, 1fr))`,
            }}
          >
            {run.data.results.map((result) => (
              <Card key={result.model} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-semibold" dir="ltr">
                    {result.model}
                  </h2>
                  {result.cache ? (
                    <span className="rounded-full bg-border/60 px-2 py-0.5 text-xs">
                      {t('s2.playground.cached')}
                    </span>
                  ) : null}
                </div>
                {result.ok ? (
                  <>
                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-border/30 p-3 text-sm">
                      {result.text}
                    </pre>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted">
                      <dt>{t('s2.playground.latency')}</dt>
                      <dd className="text-end">
                        {n(result.latencyMs)} {t('overview.ms')}
                      </dd>
                      <dt>{t('s2.playground.tokens')}</dt>
                      <dd className="text-end" dir="ltr">
                        {n(result.inputTokens ?? 0)} / {n(result.outputTokens ?? 0)}
                      </dd>
                      <dt>{t('s2.playground.cost')}</dt>
                      <dd className="text-end">
                        {result.estimatedCostUsd === undefined ? '—' : usd(result.estimatedCostUsd)}
                      </dd>
                      {result.provider ? (
                        <>
                          <dt>{t('s2.playground.provider')}</dt>
                          <dd className="text-end" dir="ltr">
                            {result.provider}
                          </dd>
                        </>
                      ) : null}
                    </dl>
                  </>
                ) : (
                  <FormError
                    message={`${result.error?.code ? `${result.error.code}: ` : ''}${result.error?.message ?? ''}`}
                  />
                )}
              </Card>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
