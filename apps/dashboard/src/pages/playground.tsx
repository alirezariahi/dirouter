/**
 * Model comparison playground (cards 16.5 and 25.6): one prompt, up to four models side by side,
 * each streamed live with its time to first token, tool calls, the x-dirouter-* headers of the
 * gateway, latency, tokens and estimated cost. The request carries what a real client sends: tool
 * definitions, an image, max_tokens, temperature, top_p, reasoning effort and response_format.
 * Calls go through the gateway with a virtual key the user created, so the usage is billed to that
 * key. The key lives only in this component's state.
 */
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PageHeader, Section, selectClass, textareaClass } from '../components/s2/common';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, FormError } from '../components/ui/field';
import { api, apiStream } from '../lib/api';
import { errorMessage } from '../lib/errors';
import type { SubmitEvent } from '../lib/form';
import {
  applyEvent,
  type Column,
  emptyColumn,
  EXAMPLE_TOOLS,
  IMAGE_MAX_CHARS,
  IMAGE_MAX_SIDE,
  parseSse,
  parseTools,
  type PlaygroundForm,
  streamBody,
} from '../lib/playground-stream';
import { listOf, useFormat } from '../lib/s2-format';
import { MAX_MODELS, toggleModel } from '../lib/s2-helpers';
import { takeReplay } from '../lib/replay';
import { bodyMessages } from '../i18n/body-messages';
import { useSettings } from '../settings';
import { currentOrg } from '../lib/session';

interface ModelRow {
  id: string;
  slug: string;
  enabled?: boolean;
}

const EFFORTS = ['', 'minimal', 'low', 'medium', 'high'] as const;
const FORMATS = ['text', 'json_object', 'json_schema'] as const;
const CHOICES = ['auto', 'none', 'required'] as const;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('read failed'));
    };
    reader.readAsDataURL(file);
  });
}

/** Downsizes an image to IMAGE_MAX_SIDE as JPEG when the browser can draw it; else keeps it. */
async function prepareImage(file: File): Promise<string> {
  const original = await readAsDataUrl(file);
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    if (!context) return original;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const resized = canvas.toDataURL('image/jpeg', 0.85);
    return resized.length < original.length ? resized : original;
  } catch {
    return original;
  }
}

export default function PlaygroundPage() {
  const { t } = useTranslation();
  const { n, usd } = useFormat();
  const org = currentOrg();
  const base = `/orgs/${org?.id ?? ''}`;
  const lang = useSettings().lang;
  // A request replayed from the Log Explorer (card 24.1), taken once; any model can be picked.
  const [replay, setReplay] = useState(takeReplay);
  const [selected, setSelected] = useState<string[]>([]);
  const [form, setForm] = useState<PlaygroundForm>(() => ({
    apiKey: '',
    system: replay?.system ?? '',
    prompt: replay?.prompt ?? '',
    maxTokens: replay?.maxTokens ? String(Math.min(4096, replay.maxTokens)) : '512',
    temperature: replay?.temperature !== undefined ? String(replay.temperature) : '',
    topP: '',
    reasoningEffort: '',
    responseFormat: 'text',
    jsonSchema: '{\n  "type": "object"\n}',
    toolChoice: 'auto',
  }));
  const [tools, setTools] = useState('');
  const [imageName, setImageName] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const [columns, setColumns] = useState<Column[]>([]);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | undefined>(undefined);

  const models = useQuery({
    queryKey: ['playground-models', org?.id],
    queryFn: () => api<unknown>(`${base}/models`),
    enabled: Boolean(org),
  });
  const set = <K extends keyof PlaygroundForm>(key: K, value: PlaygroundForm[K]) => {
    setForm((old) => ({ ...old, [key]: value }));
  };
  const update = (index: number, change: (column: Column) => Column) => {
    setColumns((old) => old.map((column, i) => (i === index ? change(column) : column)));
  };

  async function runOne(index: number, model: string, body: unknown, signal: AbortSignal) {
    try {
      const res = await apiStream(`${base}/playground/stream`, { method: 'POST', body, signal });
      if (!res.body) throw new Error('no body');
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const parsed = parseSse(buffer + value);
        buffer = parsed.rest;
        if (parsed.events.length)
          update(index, (column) => parsed.events.reduce(applyEvent, column));
      }
      update(index, (column) =>
        column.state === 'streaming' ? { ...column, state: 'done' } : column,
      );
    } catch (error) {
      update(index, (column) => ({
        ...column,
        state: 'error',
        error: {
          message: signal.aborted ? t('playgroundStream.stop') : errorMessage(error, t),
        },
      }));
    }
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (selected.length === 0) {
      setLocalError(t('s2.playground.pick'));
      return;
    }
    const parsedTools = parseTools(tools);
    if (!parsedTools.ok) {
      setLocalError(
        t(
          parsedTools.error === 'json'
            ? 'playgroundStream.invalidTools'
            : 'playgroundStream.invalidToolsShape',
        ),
      );
      return;
    }
    let schema: Record<string, unknown> | undefined;
    if (form.responseFormat === 'json_schema') {
      try {
        const value: unknown = JSON.parse(form.jsonSchema);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
        schema = value as Record<string, unknown>;
      } catch {
        setLocalError(t('playgroundStream.invalidSchema'));
        return;
      }
    }
    setLocalError(undefined);
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setColumns(selected.map(emptyColumn));
    setRunning(true);
    void Promise.all(
      selected.map((model, index) =>
        runOne(
          index,
          model,
          streamBody(form, model, parsedTools.tools, schema, replay?.history),
          controller.signal,
        ),
      ),
    ).finally(() => {
      if (abort.current === controller) setRunning(false);
    });
  };

  const attach = async (file: File | undefined) => {
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) {
      setLocalError(t('playgroundStream.imageType'));
      return;
    }
    const url = await prepareImage(file);
    if (url.length > IMAGE_MAX_CHARS) {
      setLocalError(t('playgroundStream.imageTooLarge'));
      return;
    }
    setLocalError(undefined);
    setImageName(file.name);
    set('image', url);
  };

  const available = listOf<ModelRow>(models.data).filter((model) => model.enabled !== false);

  return (
    <section className="enter flex flex-col gap-6">
      <PageHeader title={t('s2.playground.title')} subtitle={t('s2.playground.subtitle')} />
      <Section title={t('s2.playground.title')}>
        {replay ? (
          <div
            role="note"
            data-testid="playground-replay"
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-sm"
          >
            <span>
              {bodyMessages[lang].replayOf} <bdi dir="ltr">{replay.requestId}</bdi>
              {replay.model ? (
                <>
                  {' '}
                  (<bdi dir="ltr">{replay.model}</bdi>)
                </>
              ) : null}
              {replay.history.length
                ? ` · ${bodyMessages[lang].earlierTurns}: ${String(replay.history.length)}`
                : ''}
            </span>
            {replay.lossy ? (
              <span className="text-xs text-muted">{bodyMessages[lang].replayLossy}</span>
            ) : null}
            <Button
              variant="ghost"
              onClick={() => {
                setReplay(undefined);
              }}
            >
              {bodyMessages[lang].dropHistory}
            </Button>
          </div>
        ) : null}
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field
            name="playground-key"
            label={t('s2.playground.key')}
            type="password"
            autoComplete="off"
            dir="ltr"
            required
            placeholder="dr-…"
            value={form.apiKey}
            onChange={(event) => {
              set('apiKey', event.target.value);
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
              value={form.system}
              onChange={(event) => {
                set('system', event.target.value);
              }}
            />
          </label>
          <label htmlFor="playground-prompt" className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('s2.playground.prompt')}</span>
            <textarea
              id="playground-prompt"
              required
              className={`${textareaClass} min-h-32`}
              value={form.prompt}
              onChange={(event) => {
                set('prompt', event.target.value);
              }}
            />
          </label>

          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label htmlFor="playground-image" className="font-medium">
              {t('playgroundStream.image')}
            </label>
            <input
              id="playground-image"
              type="file"
              accept={IMAGE_TYPES.join(',')}
              className="text-xs"
              onChange={(event) => {
                void attach(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            {form.image ? (
              <span className="flex items-center gap-2" data-testid="playground-image-preview">
                <img
                  src={form.image}
                  alt={imageName ?? ''}
                  className="size-10 rounded object-cover"
                />
                <span className="text-xs text-muted">{imageName}</span>
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    set('image', undefined);
                    setImageName(undefined);
                  }}
                >
                  {t('playgroundStream.removeImage')}
                </Button>
              </span>
            ) : (
              <span className="text-xs text-muted">{t('playgroundStream.imageHelp')}</span>
            )}
          </div>

          <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-medium">{t('playgroundStream.params')}</legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field
                name="playground-max-tokens"
                label={t('s2.playground.maxTokens')}
                type="number"
                min={1}
                max={32768}
                dir="ltr"
                value={form.maxTokens}
                onChange={(event) => {
                  set('maxTokens', event.target.value);
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
                value={form.temperature}
                onChange={(event) => {
                  set('temperature', event.target.value);
                }}
              />
              <Field
                name="playground-top-p"
                label={t('playgroundStream.topP')}
                type="number"
                min={0}
                max={1}
                step="0.05"
                dir="ltr"
                value={form.topP}
                onChange={(event) => {
                  set('topP', event.target.value);
                }}
              />
              <label htmlFor="playground-effort" className="flex flex-col gap-1.5 text-sm">
                <span className="text-[13px] font-medium text-fg-2">
                  {t('playgroundStream.reasoningEffort')}
                </span>
                <select
                  id="playground-effort"
                  className={selectClass}
                  value={form.reasoningEffort}
                  onChange={(event) => {
                    set('reasoningEffort', event.target.value as PlaygroundForm['reasoningEffort']);
                  }}
                >
                  {EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {t(`playgroundStream.effort.${effort || 'none'}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="playground-format" className="flex flex-col gap-1.5 text-sm">
                <span className="text-[13px] font-medium text-fg-2">
                  {t('playgroundStream.responseFormat')}
                </span>
                <select
                  id="playground-format"
                  className={selectClass}
                  value={form.responseFormat}
                  onChange={(event) => {
                    set('responseFormat', event.target.value as PlaygroundForm['responseFormat']);
                  }}
                >
                  {FORMATS.map((format) => (
                    <option key={format} value={format}>
                      {t(`playgroundStream.formats.${format}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="playground-tool-choice" className="flex flex-col gap-1.5 text-sm">
                <span className="text-[13px] font-medium text-fg-2">
                  {t('playgroundStream.toolChoice')}
                </span>
                <select
                  id="playground-tool-choice"
                  className={selectClass}
                  value={form.toolChoice}
                  onChange={(event) => {
                    set('toolChoice', event.target.value as PlaygroundForm['toolChoice']);
                  }}
                >
                  {CHOICES.map((choice) => (
                    <option key={choice} value={choice}>
                      {t(`playgroundStream.choices.${choice}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {form.responseFormat === 'json_schema' ? (
              <label htmlFor="playground-schema" className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('playgroundStream.jsonSchema')}</span>
                <textarea
                  id="playground-schema"
                  dir="ltr"
                  className={`${textareaClass} font-mono`}
                  value={form.jsonSchema}
                  onChange={(event) => {
                    set('jsonSchema', event.target.value);
                  }}
                />
              </label>
            ) : null}
            <div className="flex flex-col gap-1 text-sm">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="playground-tools" className="font-medium">
                  {t('playgroundStream.tools')}
                </label>
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setTools(EXAMPLE_TOOLS);
                  }}
                >
                  {t('playgroundStream.toolExample')}
                </Button>
              </div>
              <textarea
                id="playground-tools"
                dir="ltr"
                spellCheck={false}
                aria-describedby="playground-tools-help"
                className={`${textareaClass} font-mono`}
                value={tools}
                onChange={(event) => {
                  setTools(event.target.value);
                }}
              />
              <span id="playground-tools-help" className="text-xs text-muted">
                {t('playgroundStream.toolsHelp')}
              </span>
            </div>
          </fieldset>

          <FormError message={localError} />
          <div className="flex gap-2">
            <Button type="submit" disabled={running || !form.prompt.trim() || !form.apiKey.trim()}>
              {running ? t('s2.playground.running') : t('s2.playground.run')}
            </Button>
            {running ? (
              <Button
                variant="outline"
                onClick={() => {
                  abort.current?.abort();
                }}
              >
                {t('playgroundStream.stop')}
              </Button>
            ) : null}
          </div>
        </form>
      </Section>

      {columns.length ? (
        <div
          data-testid="playground-results"
          className="grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${String(Math.min(2, columns.length))}, minmax(0, 1fr))`,
          }}
        >
          {columns.map((column) => (
            <Card
              key={column.model}
              className="flex min-w-0 flex-col gap-2"
              data-testid="playground-column"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold" dir="ltr">
                  {column.model}
                </h2>
                {column.state === 'streaming' ? (
                  <span className="text-xs text-muted" role="status">
                    {t('playgroundStream.streaming')}
                  </span>
                ) : column.headers['x-dirouter-cache'] ? (
                  <span className="rounded-full bg-border/60 px-2 py-0.5 text-xs">
                    {t('s2.playground.cached')}
                  </span>
                ) : null}
              </div>
              {column.error ? (
                <FormError
                  message={`${column.error.code ? `${column.error.code}: ` : ''}${column.error.message}`}
                />
              ) : null}
              {column.reasoning ? (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted">
                    {t('playgroundStream.reasoning')}
                  </summary>
                  <pre className="mt-1 whitespace-pre-wrap rounded bg-border/30 p-2">
                    {column.reasoning}
                  </pre>
                </details>
              ) : null}
              {column.text || column.state === 'streaming' ? (
                <pre
                  data-testid="playground-text"
                  className="max-h-96 min-h-12 overflow-auto whitespace-pre-wrap rounded bg-border/30 p-3 text-sm"
                >
                  {column.text}
                </pre>
              ) : null}
              {column.toolCalls.length ? (
                <div data-testid="playground-tool-calls" className="flex flex-col gap-1">
                  <h3 className="text-xs font-medium">{t('playgroundStream.toolCalls')}</h3>
                  {column.toolCalls.map((call, i) => (
                    <pre
                      key={call.id || String(i)}
                      dir="ltr"
                      className="overflow-auto rounded border border-border p-2 text-xs"
                    >
                      {call.name}({call.arguments})
                    </pre>
                  ))}
                </div>
              ) : null}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted">
                <dt>{t('playgroundStream.ttft')}</dt>
                <dd className="text-end" data-testid="playground-ttft">
                  {column.ttftMs === undefined ? '—' : `${n(column.ttftMs)} ${t('overview.ms')}`}
                </dd>
                <dt>{t('s2.playground.latency')}</dt>
                <dd className="text-end">
                  {column.latencyMs === undefined
                    ? '—'
                    : `${n(column.latencyMs)} ${t('overview.ms')}`}
                </dd>
                <dt>{t('s2.playground.tokens')}</dt>
                <dd className="text-end" dir="ltr">
                  {n(column.inputTokens ?? 0)} / {n(column.outputTokens ?? 0)}
                </dd>
                <dt>{t('s2.playground.cost')}</dt>
                <dd className="text-end">
                  {column.estimatedCostUsd === undefined ? '—' : usd(column.estimatedCostUsd)}
                </dd>
                {column.status !== undefined ? (
                  <>
                    <dt>{t('playgroundStream.status')}</dt>
                    <dd className="text-end">{column.status}</dd>
                  </>
                ) : null}
                {column.finishReason ? (
                  <>
                    <dt>{t('playgroundStream.finish')}</dt>
                    <dd className="text-end" dir="ltr">
                      {column.finishReason}
                    </dd>
                  </>
                ) : null}
              </dl>
              <details className="text-xs" data-testid="playground-headers">
                <summary className="cursor-pointer text-muted">
                  {t('playgroundStream.headers')}
                </summary>
                {Object.keys(column.headers).length === 0 ? (
                  <p className="mt-1 text-muted">{t('playgroundStream.noHeaders')}</p>
                ) : (
                  <dl
                    dir="ltr"
                    className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono"
                  >
                    {Object.entries(column.headers).map(([name, value]) => (
                      <div key={name} className="contents">
                        <dt className="text-muted">{name}</dt>
                        <dd className="break-all">{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </details>
            </Card>
          ))}
        </div>
      ) : null}
    </section>
  );
}
