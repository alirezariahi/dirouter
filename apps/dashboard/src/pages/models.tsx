/* eslint-disable react-refresh/only-export-components -- validation/preview helpers intentionally tested with the page */
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Card } from '../components/ui/card';
import { Empty, ErrorState, Loading } from '../components/ui/states';
import { api } from '../lib/api';
import type { SubmitEvent } from '../lib/form';
import { currentOrg, useSession } from '../lib/session';

/**
 * Model/alias/combo management. All user-facing strings are deliberately under
 * models.* so the two locale resources can be added independently of this page.
 * The resource shape and preview rules mirror ModelsController and Router.
 */

type Strategy = 'priority' | 'weighted' | 'round-robin';
type Capability = 'streaming' | 'tools' | 'vision' | 'reasoning' | 'jsonMode';
type TimeoutKey = 'connectMs' | 'firstByteMs' | 'idleMs' | 'totalMs';

interface Pricing {
  inputPerMTok: string;
  outputPerMTok: string;
  cacheReadPerMTok?: string;
  cacheWritePerMTok?: string;
  reasoningPerMTok?: string;
}
interface Model {
  id: string;
  slug: string;
  providerId: string;
  upstreamModel: string;
  displayName: string | null;
  enabled: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  pricing: Pricing;
  capabilities: unknown;
  catalogKey: string | null;
}
interface Provider {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
}
interface Alias {
  id: string;
  slug: string;
  target: { kind: 'model'; modelId: string } | { kind: 'combo'; comboId: string };
}
interface Target {
  modelId: string;
  order: number;
  weight: number;
}
interface Combo {
  id: string;
  slug: string;
  strategy: Strategy;
  targets: Target[];
  fallbackOn: string[];
  retryMaxAttempts: number;
  timeouts: unknown;
}
interface CatalogEntry {
  key: string;
  upstreamModel?: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: Partial<Pricing>;
  capabilities?: Partial<Record<Capability, boolean>>;
}
interface Catalog {
  version: string;
  currency: string;
  models: CatalogEntry[];
}
interface Resources {
  models: Model[];
  aliases: Alias[];
  combos: Combo[];
  providers: Provider[];
  catalog: Catalog;
}

interface ComboDraft {
  id?: string;
  slug: string;
  strategy: Strategy;
  targets: Target[];
  fallbackOn: string[];
  retryMaxAttempts: string;
  timeouts: Record<TimeoutKey, string>;
}
interface ModelDraft {
  id?: string;
  providerId: string;
  upstreamModel: string;
  slug: string;
  displayName: string;
  enabled: boolean;
  contextWindow: string;
  maxOutputTokens: string;
  inputPerMTok: string;
  outputPerMTok: string;
  cacheReadPerMTok: string;
  cacheWritePerMTok: string;
  reasoningPerMTok: string;
  capabilities: Record<Capability, boolean>;
  catalogKey: string;
}
interface AliasDraft {
  id?: string;
  slug: string;
  target: string;
}

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/i;
export const PRICE_PATTERN = /^\d{1,10}(\.\d{1,8})?$/;
export const FALLBACK_CLASSES = [
  'rate_limit',
  'overloaded',
  'server',
  'timeout',
  'connection',
  'auth',
  'bad_request',
  'context_length',
  'content_filter',
  'not_found',
] as const;
const CAPABILITIES: Capability[] = ['streaming', 'tools', 'vision', 'reasoning', 'jsonMode'];
const TIMEOUT_KEYS: TimeoutKey[] = ['connectMs', 'firstByteMs', 'idleMs', 'totalMs'];

const integer = (value: string) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
const targetId = (target: Alias['target']) =>
  `${target.kind}:${target.kind === 'model' ? target.modelId : target.comboId}`;

function asTimeouts(value: unknown): Record<TimeoutKey, string> {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    TIMEOUT_KEYS.map((key) => [key, typeof source[key] === 'number' ? String(source[key]) : '']),
  ) as Record<TimeoutKey, string>;
}

function comboDraft(combo?: Combo): ComboDraft {
  return {
    ...(combo ? { id: combo.id } : {}),
    slug: combo?.slug ?? '',
    strategy: combo?.strategy ?? 'priority',
    targets: (combo?.targets ?? []).map((target) => ({ ...target })),
    fallbackOn: [...(combo?.fallbackOn ?? [])],
    retryMaxAttempts: String(combo?.retryMaxAttempts ?? 2),
    timeouts: asTimeouts(combo?.timeouts),
  };
}

function modelDraft(model: Model | undefined, providers: Provider[]): ModelDraft {
  const caps =
    model?.capabilities && typeof model.capabilities === 'object'
      ? (model.capabilities as Partial<Record<Capability, boolean>>)
      : {};
  return {
    ...(model ? { id: model.id } : {}),
    providerId: model?.providerId ?? providers[0]?.id ?? '',
    upstreamModel: model?.upstreamModel ?? '',
    slug: model?.slug ?? '',
    displayName: model?.displayName ?? '',
    enabled: model?.enabled ?? true,
    contextWindow: model?.contextWindow ? String(model.contextWindow) : '',
    maxOutputTokens: model?.maxOutputTokens ? String(model.maxOutputTokens) : '',
    inputPerMTok: model?.pricing.inputPerMTok ?? '',
    outputPerMTok: model?.pricing.outputPerMTok ?? '',
    cacheReadPerMTok: model?.pricing.cacheReadPerMTok ?? '',
    cacheWritePerMTok: model?.pricing.cacheWritePerMTok ?? '',
    reasoningPerMTok: model?.pricing.reasoningPerMTok ?? '',
    capabilities: Object.fromEntries(
      CAPABILITIES.map((key) => [key, caps[key] === true]),
    ) as Record<Capability, boolean>,
    catalogKey: model?.catalogKey ?? '',
  };
}

/** Client-side equivalent of the server Zod bodies; returned keys are translation keys. */
export function validateCombo(draft: ComboDraft): string | undefined {
  if (!SLUG_PATTERN.test(draft.slug)) return 'models.validation.slug';
  if (draft.targets.length < 1 || draft.targets.length > 20) return 'models.validation.targets';
  if (new Set(draft.targets.map((target) => target.modelId)).size !== draft.targets.length)
    return 'models.validation.duplicateTarget';
  if (
    draft.targets.some(
      (target) =>
        !target.modelId ||
        !Number.isInteger(target.weight) ||
        target.weight < 0 ||
        target.weight > 1000,
    )
  )
    return 'models.validation.weight';
  const attempts = Number(draft.retryMaxAttempts);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10)
    return 'models.validation.attempts';
  if (TIMEOUT_KEYS.some((key) => draft.timeouts[key] !== '' && !integer(draft.timeouts[key])))
    return 'models.validation.timeout';
  return undefined;
}

export function validateAlias(draft: AliasDraft, names: string[]): string | undefined {
  if (!SLUG_PATTERN.test(draft.slug)) return 'models.validation.slug';
  if (!draft.target) return 'models.validation.aliasTarget';
  if (!draft.id && names.includes(draft.slug)) return 'models.validation.nameTaken';
  return undefined;
}

/** Equivalent to Router's priority/weighted/round-robin target ordering. */
export function executionOrder(
  draft: ComboDraft,
  requestNumber = 0,
  random = Math.random,
): Target[] {
  const pool = draft.targets.map((target) => ({ target, weight: Math.max(0, target.weight) }));
  const result: Target[] = [];
  if (draft.strategy === 'priority') return [...draft.targets].sort((a, b) => a.order - b.order);
  if (draft.strategy === 'round-robin') {
    const ordered = [...draft.targets].sort((a, b) => a.order - b.order);
    const start = ordered.length === 0 ? 0 : requestNumber % ordered.length;
    return [...ordered.slice(start), ...ordered.slice(0, start)];
  }
  while (pool.length > 0) {
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
    let pick = 0;
    if (total > 0) {
      let value = random() * total;
      for (; pick < pool.length - 1; pick++) {
        value -= pool[pick]?.weight ?? 0;
        if (value < 0) break;
      }
    }
    const [chosen] = pool.splice(pick, 1);
    if (chosen) result.push(chosen.target);
  }
  return result;
}

function Select({
  label,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <select
        className="h-10 rounded-md border border-border bg-surface px-2 outline-none focus:border-brand"
        {...props}
      >
        {children}
      </select>
    </label>
  );
}

function Check({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" className="size-4 accent-brand" {...props} />
      {label}
    </label>
  );
}

function Actions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-1">
      <button
        type="button"
        className="rounded px-2 py-1 text-xs text-brand hover:bg-border/50"
        onClick={onEdit}
      >
        {t('models.edit')}
      </button>
      <button
        type="button"
        className="rounded px-2 py-1 text-xs text-danger hover:bg-danger/10"
        onClick={onDelete}
      >
        {t('models.delete')}
      </button>
    </div>
  );
}

function CatalogTable({
  models,
  onEdit,
  onDelete,
}: {
  models: Model[];
  onEdit: (model: Model) => void;
  onDelete: (model: Model) => void;
}) {
  const { t } = useTranslation();
  if (models.length === 0) return <Empty title={t('models.empty')} />;
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm" data-testid="model-catalog-table">
        <thead className="text-muted">
          <tr className="border-b border-border">
            {['name', 'upstream', 'context', 'pricing', 'capabilities', 'status', 'actions'].map(
              (key) => (
                <th
                  key={key}
                  scope="col"
                  className="whitespace-nowrap px-3 py-2 text-start font-medium"
                >
                  {t(`models.column.${key}`)}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {models.map((model) => {
            const capabilities = CAPABILITIES.filter(
              (key) =>
                model.capabilities &&
                typeof model.capabilities === 'object' &&
                (model.capabilities as Partial<Record<Capability, boolean>>)[key] === true,
            );
            return (
              <tr key={model.id} className="border-b border-border/60 align-top">
                <td className="px-3 py-2">
                  <div className="font-medium">{model.displayName || model.slug}</div>
                  <code className="text-xs text-muted" dir="ltr">
                    {model.slug}
                  </code>
                </td>
                <td className="px-3 py-2" dir="ltr">
                  {model.upstreamModel}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {model.contextWindow?.toLocaleString('en-US') ?? '—'}
                  <span className="block text-xs text-muted">
                    {t('models.maxOutput')}: {model.maxOutputTokens?.toLocaleString('en-US') ?? '—'}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2" dir="ltr">
                  ${model.pricing.inputPerMTok} / ${model.pricing.outputPerMTok}
                  <span className="block text-xs text-muted">{t('models.perMTok')}</span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex max-w-52 flex-wrap gap-1">
                    {capabilities.length === 0
                      ? '—'
                      : capabilities.map((key) => (
                          <span key={key} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">
                            {t(`models.capability.${key}`)}
                          </span>
                        ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">
                  {t(model.enabled ? 'models.enabled' : 'models.disabled')}
                </td>
                <td className="px-3 py-2">
                  <Actions
                    onEdit={() => {
                      onEdit(model);
                    }}
                    onDelete={() => {
                      onDelete(model);
                    }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function ComboEditor({
  initial,
  models,
  names,
  onCancel,
  onSaved,
}: {
  initial?: Combo;
  models: Model[];
  names: string[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const org = currentOrg();
  const [draft, setDraft] = useState(() => comboDraft(initial));
  const [selectedModel, setSelectedModel] = useState(models[0]?.id ?? '');
  const [dragged, setDragged] = useState<number>();
  const [preview, setPreview] = useState(0);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<ComboDraft>) => {
    setDraft((old) => ({ ...old, ...patch }));
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= draft.targets.length || from === to) return;
    const targets = [...draft.targets];
    const [item] = targets.splice(from, 1);
    if (!item) return;
    targets.splice(to, 0, item);
    update({ targets: targets.map((target, order) => ({ ...target, order })) });
  };
  const modelName = (id: string) => models.find((model) => model.id === id)?.slug ?? id;
  const order = executionOrder(draft, preview);
  const totalWeight = draft.targets.reduce((sum, target) => sum + target.weight, 0);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const validation = validateCombo(draft);
    if (validation) {
      setError(validation);
      return;
    }
    if (names.includes(draft.slug)) {
      setError('models.validation.nameTaken');
      return;
    }
    const timeouts = Object.fromEntries(
      TIMEOUT_KEYS.filter((key) => draft.timeouts[key] !== '').map((key) => [
        key,
        Number(draft.timeouts[key]),
      ]),
    );
    const body = {
      slug: draft.slug,
      strategy: draft.strategy,
      targets: draft.targets.map((target, order) => ({
        modelId: target.modelId,
        order,
        weight: target.weight,
      })),
      fallbackOn: draft.fallbackOn,
      retryMaxAttempts: Number(draft.retryMaxAttempts),
      timeouts: Object.keys(timeouts).length > 0 ? timeouts : null,
    };
    setBusy(true);
    setError(undefined);
    try {
      await api(`/orgs/${org?.id ?? ''}/combos${initial ? `/${initial.id}` : ''}`, {
        method: initial ? 'PATCH' : 'POST',
        body,
      });
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('state.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
        data-testid="combo-editor"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium">{t(initial ? 'models.editCombo' : 'models.newCombo')}</h2>
          <button type="button" className="text-sm text-muted" onClick={onCancel}>
            ×
          </button>
        </div>
        {error && (
          <p
            role="alert"
            className="rounded border border-danger/40 bg-danger/10 p-2 text-sm text-danger"
          >
            {t(error, error)}
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('models.slug')}</span>
            <input
              required
              pattern="[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}"
              dir="ltr"
              value={draft.slug}
              onChange={(event) => {
                update({ slug: event.target.value });
              }}
              className="h-10 rounded-md border border-border bg-surface px-3 outline-none focus:border-brand"
            />
          </label>
          <Select
            label={t('models.strategy')}
            value={draft.strategy}
            onChange={(event) => {
              update({ strategy: event.target.value as Strategy });
            }}
          >
            {(['priority', 'weighted', 'round-robin'] as const).map((strategy) => (
              <option key={strategy} value={strategy}>
                {t(`models.strategyType.${strategy}`)}
              </option>
            ))}
          </Select>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('models.retryMaxAttempts')}</span>
            <input
              required
              type="number"
              min={1}
              max={10}
              step={1}
              value={draft.retryMaxAttempts}
              onChange={(event) => {
                update({ retryMaxAttempts: event.target.value });
              }}
              className="h-10 rounded-md border border-border bg-surface px-3 outline-none focus:border-brand"
            />
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t('models.targets')}</h3>
          {draft.targets.length === 0 && (
            <p className="text-sm text-muted">{t('models.noTargets')}</p>
          )}
          <ol className="flex flex-col gap-2" aria-label={t('models.targets')}>
            {draft.targets.map((target, index) => (
              <li
                key={target.modelId}
                draggable
                data-testid="combo-target"
                onDragStart={(event) => {
                  setDragged(index);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', target.modelId);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragged !== undefined) move(dragged, index);
                  setDragged(undefined);
                }}
                onDragEnd={() => {
                  setDragged(undefined);
                }}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2/40 p-2"
              >
                <span aria-hidden="true" className="cursor-grab px-1 text-muted">
                  ⋮⋮
                </span>
                <span className="min-w-32 flex-1" dir="ltr">
                  {index + 1}. {modelName(target.modelId)}
                </span>
                <label className="flex items-center gap-1 text-xs">
                  {t('models.weight')}
                  <input
                    aria-label={`${t('models.weight')} ${modelName(target.modelId)}`}
                    type="number"
                    min={0}
                    max={1000}
                    step={1}
                    value={target.weight}
                    onChange={(event) => {
                      const targets = draft.targets.map((item, i) =>
                        i === index ? { ...item, weight: Number(event.target.value) } : item,
                      );
                      update({ targets });
                    }}
                    className="h-8 w-20 rounded border border-border bg-surface px-2"
                  />
                </label>
                <button
                  type="button"
                  aria-label={`${t('models.moveUp')} ${modelName(target.modelId)}`}
                  disabled={index === 0}
                  onClick={() => {
                    move(index, index - 1);
                  }}
                  className="rounded border border-border px-2 py-1 disabled:opacity-40"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`${t('models.moveDown')} ${modelName(target.modelId)}`}
                  disabled={index === draft.targets.length - 1}
                  onClick={() => {
                    move(index, index + 1);
                  }}
                  className="rounded border border-border px-2 py-1 disabled:opacity-40"
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`${t('models.removeTarget')} ${modelName(target.modelId)}`}
                  onClick={() => {
                    update({
                      targets: draft.targets
                        .filter((_, i) => i !== index)
                        .map((item, order) => ({ ...item, order })),
                    });
                  }}
                  className="rounded px-2 py-1 text-danger hover:bg-danger/10"
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-end gap-2">
            <Select
              label={t('models.addTarget')}
              value={selectedModel}
              onChange={(event) => {
                setSelectedModel(event.target.value);
              }}
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.slug}
                </option>
              ))}
            </Select>
            <button
              type="button"
              className="h-10 rounded-md border border-border px-3 text-sm hover:bg-border/40"
              disabled={
                !selectedModel ||
                draft.targets.length >= 20 ||
                draft.targets.some((target) => target.modelId === selectedModel)
              }
              onClick={() => {
                if (
                  !selectedModel ||
                  draft.targets.some((target) => target.modelId === selectedModel)
                )
                  return;
                update({
                  targets: [
                    ...draft.targets,
                    { modelId: selectedModel, order: draft.targets.length, weight: 1 },
                  ],
                });
              }}
            >
              {t('models.add')}
            </button>
          </div>
          <p className="text-xs text-muted">{t('models.dragHint')}</p>
        </div>

        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('models.fallbackOn')}</legend>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            {FALLBACK_CLASSES.map((kind) => (
              <Check
                key={kind}
                label={t(`models.errorClass.${kind}`)}
                checked={draft.fallbackOn.includes(kind)}
                onChange={(event) => {
                  update({
                    fallbackOn: event.target.checked
                      ? [...draft.fallbackOn, kind]
                      : draft.fallbackOn.filter((item) => item !== kind),
                  });
                }}
              />
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('models.timeouts')}</legend>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {TIMEOUT_KEYS.map((key) => (
              <label key={key} className="flex flex-col gap-1 text-xs">
                {t(`models.timeout.${key}`)}
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.timeouts[key]}
                  onChange={(event) => {
                    update({ timeouts: { ...draft.timeouts, [key]: event.target.value } });
                  }}
                  className="h-9 rounded border border-border bg-surface px-2"
                />
              </label>
            ))}
          </div>
        </fieldset>

        <section
          aria-label={t('models.executionPreview')}
          className="rounded-md border border-border bg-surface-2/30 p-3"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{t('models.executionPreview')}</h3>
            <button
              type="button"
              className="text-xs text-brand"
              onClick={() => {
                setPreview((value) => value + 1);
              }}
            >
              {t('models.simulateNext')}
            </button>
          </div>
          {order.length === 0 ? (
            <p className="text-sm text-muted">{t('models.noTargets')}</p>
          ) : (
            <ol data-testid="execution-preview" className="flex flex-wrap gap-2">
              {order.map((target, index) => (
                <li
                  key={target.modelId}
                  className="rounded border border-border bg-surface px-2 py-1 text-xs"
                >
                  <span className="text-muted">{index + 1}. </span>
                  <span dir="ltr">{modelName(target.modelId)}</span>
                  {draft.strategy === 'weighted' && (
                    <span className="ms-1 text-muted">
                      ({totalWeight === 0 ? 0 : Math.round((target.weight / totalWeight) * 100)}%)
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
          <p className="mt-2 text-xs text-muted">{t(`models.previewHelp.${draft.strategy}`)}</p>
        </section>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="h-9 rounded-md bg-brand px-3 text-sm font-medium text-brand-fg disabled:opacity-50"
          >
            {t('models.save')}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="h-9 rounded-md border border-border px-3 text-sm"
          >
            {t('models.cancel')}
          </button>
        </div>
      </form>
    </Card>
  );
}

function ModelEditor({
  initial,
  resources,
  names,
  onCancel,
  onSaved,
}: {
  initial?: Model;
  resources: Resources;
  names: string[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const org = currentOrg();
  const [draft, setDraft] = useState(() => modelDraft(initial, resources.providers));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<ModelDraft>) => {
    setDraft((old) => ({ ...old, ...patch }));
  };
  const pricingKeys = [
    'inputPerMTok',
    'outputPerMTok',
    'cacheReadPerMTok',
    'cacheWritePerMTok',
    'reasoningPerMTok',
  ] as const;

  function chooseCatalog(key: string) {
    const entry = resources.catalog.models.find((item) => item.key === key);
    update({
      catalogKey: key,
      ...(entry?.upstreamModel && !initial ? { upstreamModel: entry.upstreamModel } : {}),
      ...(entry?.displayName && !initial ? { displayName: entry.displayName } : {}),
      ...(entry?.contextWindow ? { contextWindow: String(entry.contextWindow) } : {}),
      ...(entry?.maxOutputTokens ? { maxOutputTokens: String(entry.maxOutputTokens) } : {}),
      ...(entry?.pricing
        ? Object.fromEntries(pricingKeys.map((price) => [price, entry.pricing?.[price] ?? '']))
        : {}),
      ...(entry?.capabilities
        ? { capabilities: { ...draft.capabilities, ...entry.capabilities } }
        : {}),
    });
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!SLUG_PATTERN.test(draft.slug)) {
      setError('models.validation.slug');
      return;
    }
    if (names.includes(draft.slug)) {
      setError('models.validation.nameTaken');
      return;
    }
    if (draft.providerId === '' || !draft.upstreamModel) {
      setError('models.validation.modelRequired');
      return;
    }
    if (
      (['contextWindow', 'maxOutputTokens'] as const).some(
        (key) => draft[key] && !integer(draft[key]),
      )
    ) {
      setError('models.validation.positiveInteger');
      return;
    }
    if (pricingKeys.some((key) => draft[key] && !PRICE_PATTERN.test(draft[key]))) {
      setError('models.validation.price');
      return;
    }
    if (!draft.catalogKey && (!draft.inputPerMTok || !draft.outputPerMTok)) {
      setError('models.validation.basePrice');
      return;
    }
    const pricing = Object.fromEntries(
      pricingKeys.filter((key) => draft[key] !== '').map((key) => [key, draft[key]]),
    );
    const body = {
      ...(initial ? {} : { providerId: draft.providerId, upstreamModel: draft.upstreamModel }),
      slug: draft.slug,
      displayName: draft.displayName || null,
      enabled: draft.enabled,
      contextWindow: draft.contextWindow ? Number(draft.contextWindow) : null,
      maxOutputTokens: draft.maxOutputTokens ? Number(draft.maxOutputTokens) : null,
      pricing,
      capabilities: draft.capabilities,
    };
    setBusy(true);
    setError(undefined);
    try {
      await api(`/orgs/${org?.id ?? ''}/models${initial ? `/${initial.id}` : ''}`, {
        method: initial ? 'PATCH' : 'POST',
        body,
      });
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('state.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-3"
        data-testid="model-editor"
      >
        <div className="flex justify-between">
          <h2 className="font-medium">{t(initial ? 'models.editModel' : 'models.newModel')}</h2>
          <button type="button" onClick={onCancel}>
            ×
          </button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {t(error, error)}
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <Select
            label={t('models.catalogKey')}
            value={draft.catalogKey}
            onChange={(event) => {
              chooseCatalog(event.target.value);
            }}
          >
            <option value="">{t('models.customModel')}</option>
            {resources.catalog.models.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.displayName ?? entry.key}
              </option>
            ))}
          </Select>
          <Select
            label={t('models.provider')}
            value={draft.providerId}
            disabled={Boolean(initial)}
            onChange={(event) => {
              update({ providerId: event.target.value });
            }}
          >
            {resources.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} ({provider.slug})
              </option>
            ))}
          </Select>
          {(
            ['slug', 'upstreamModel', 'displayName', 'contextWindow', 'maxOutputTokens'] as const
          ).map((key) => (
            <label key={key} className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t(`models.${key}`)}</span>
              <input
                dir="ltr"
                required={key === 'slug' || key === 'upstreamModel'}
                disabled={Boolean(initial) && key === 'upstreamModel'}
                type={key === 'contextWindow' || key === 'maxOutputTokens' ? 'number' : 'text'}
                min={1}
                value={draft[key]}
                onChange={(event) => {
                  update({ [key]: event.target.value });
                }}
                className="h-10 rounded border border-border bg-surface px-3 disabled:opacity-60"
              />
            </label>
          ))}
          {pricingKeys.map((key) => (
            <label key={key} className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t(`models.price.${key}`)}</span>
              <input
                dir="ltr"
                inputMode="decimal"
                required={!draft.catalogKey && (key === 'inputPerMTok' || key === 'outputPerMTok')}
                value={draft[key]}
                onChange={(event) => {
                  update({ [key]: event.target.value });
                }}
                className="h-10 rounded border border-border bg-surface px-3"
              />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-4">
          {CAPABILITIES.map((key) => (
            <Check
              key={key}
              label={t(`models.capability.${key}`)}
              checked={draft.capabilities[key]}
              onChange={(event) => {
                update({ capabilities: { ...draft.capabilities, [key]: event.target.checked } });
              }}
            />
          ))}
        </div>
        <Check
          label={t('models.enabled')}
          checked={draft.enabled}
          onChange={(event) => {
            update({ enabled: event.target.checked });
          }}
        />
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="h-9 rounded bg-brand px-3 text-sm text-brand-fg"
          >
            {t('models.save')}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="h-9 rounded border border-border px-3 text-sm"
          >
            {t('models.cancel')}
          </button>
        </div>
      </form>
    </Card>
  );
}

function AliasEditor({
  initial,
  resources,
  names,
  onCancel,
  onSaved,
}: {
  initial?: Alias;
  resources: Resources;
  names: string[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const org = currentOrg();
  const [draft, setDraft] = useState<AliasDraft>(() => ({
    ...(initial ? { id: initial.id } : {}),
    slug: initial?.slug ?? '',
    target: initial ? targetId(initial.target) : '',
  }));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const validation = validateAlias(
      draft,
      initial ? names.filter((name) => name !== initial.slug) : names,
    );
    if (validation) {
      setError(validation);
      return;
    }
    const [kind, ...id] = draft.target.split(':');
    setBusy(true);
    setError(undefined);
    try {
      await api(`/orgs/${org?.id ?? ''}/aliases${initial ? `/${initial.id}` : ''}`, {
        method: initial ? 'PATCH' : 'POST',
        body: {
          slug: draft.slug,
          ...(kind === 'model' ? { modelId: id.join(':') } : { comboId: id.join(':') }),
        },
      });
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('state.error'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <form
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-3"
        data-testid="alias-editor"
      >
        <h2 className="font-medium">{t(initial ? 'models.editAlias' : 'models.newAlias')}</h2>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {t(error, error)}
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('models.slug')}</span>
            <input
              required
              dir="ltr"
              value={draft.slug}
              onChange={(event) => {
                setDraft({ ...draft, slug: event.target.value });
              }}
              className="h-10 rounded border border-border bg-surface px-3"
            />
          </label>
          <Select
            label={t('models.aliasTarget')}
            value={draft.target}
            onChange={(event) => {
              setDraft({ ...draft, target: event.target.value });
            }}
          >
            <option value="">{t('models.chooseTarget')}</option>
            <optgroup label={t('models.models')}>
              {resources.models.map((model) => (
                <option key={model.id} value={`model:${model.id}`}>
                  {model.slug}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('models.combos')}>
              {resources.combos.map((combo) => (
                <option key={combo.id} value={`combo:${combo.id}`}>
                  {combo.slug}
                </option>
              ))}
            </optgroup>
          </Select>
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="h-9 rounded bg-brand px-3 text-sm text-brand-fg"
          >
            {t('models.save')}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="h-9 rounded border border-border px-3 text-sm"
          >
            {t('models.cancel')}
          </button>
        </div>
      </form>
    </Card>
  );
}

export default function ModelsPage() {
  const { t } = useTranslation();
  useSession();
  const org = currentOrg();
  const query = useQuery({
    queryKey: ['model-management', org?.id],
    enabled: Boolean(org),
    queryFn: async (): Promise<Resources> => {
      const base = `/orgs/${org?.id ?? ''}`;
      const [models, aliases, combos, providers, catalog] = await Promise.all([
        api<Model[]>(`${base}/models`),
        api<Alias[]>(`${base}/aliases`),
        api<Combo[]>(`${base}/combos`),
        api<Provider[]>(`${base}/providers`),
        api<Catalog>(`${base}/catalog`),
      ]);
      return { models, aliases, combos, providers, catalog };
    },
  });
  const [editor, setEditor] = useState<'model' | 'alias' | 'combo'>();
  const [selectedModel, setSelectedModel] = useState<Model>();
  const [selectedAlias, setSelectedAlias] = useState<Alias>();
  const [selectedCombo, setSelectedCombo] = useState<Combo>();
  const [actionError, setActionError] = useState<string>();
  const data = query.data;
  const names = data
    ? [...data.models, ...data.aliases, ...data.combos].map((item) => item.slug)
    : [];
  const saved = async () => {
    setEditor(undefined);
    setSelectedModel(undefined);
    setSelectedAlias(undefined);
    setSelectedCombo(undefined);
    await query.refetch();
  };
  const cancel = () => {
    setEditor(undefined);
    setSelectedModel(undefined);
    setSelectedAlias(undefined);
    setSelectedCombo(undefined);
  };
  const remove = async (kind: 'models' | 'aliases' | 'combos', id: string) => {
    if (!window.confirm(t('models.confirmDelete'))) return;
    try {
      await api(`/orgs/${org?.id ?? ''}/${kind}/${id}`, { method: 'DELETE' });
      setActionError(undefined);
      await query.refetch();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('state.error'));
    }
  };
  const openModel = (model?: Model) => {
    setSelectedModel(model);
    setEditor('model');
  };
  const openAlias = (alias?: Alias) => {
    setSelectedAlias(alias);
    setEditor('alias');
  };
  const openCombo = (combo?: Combo) => {
    setSelectedCombo(combo);
    setEditor('combo');
  };
  const comboName = (id: string) => data?.combos.find((combo) => combo.id === id)?.slug ?? id;
  const modelName = (id: string) => data?.models.find((model) => model.id === id)?.slug ?? id;

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('models.title')}</h1>
          <p className="text-sm text-muted">{t('models.subtitle')}</p>
        </div>
        {data && (
          <span className="text-xs text-muted">
            {t('models.catalogVersion', {
              version: data.catalog.version,
              currency: data.catalog.currency,
            })}
          </span>
        )}
      </div>
      {actionError && (
        <p
          role="alert"
          className="rounded border border-danger/40 bg-danger/10 p-2 text-sm text-danger"
        >
          {actionError}
        </p>
      )}
      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">{t('models.models')}</h2>
              <button
                type="button"
                onClick={() => {
                  openModel();
                }}
                className="h-9 rounded bg-brand px-3 text-sm text-brand-fg"
              >
                {t('models.newModel')}
              </button>
            </div>
            <CatalogTable
              models={data.models}
              onEdit={(model) => {
                openModel(model);
              }}
              onDelete={(model) => void remove('models', model.id)}
            />
          </section>
          <div className="grid items-start gap-4 xl:grid-cols-2">
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-medium">{t('models.aliases')}</h2>
                <button
                  type="button"
                  onClick={() => {
                    openAlias();
                  }}
                  className="rounded border border-border px-3 py-1.5 text-sm"
                >
                  {t('models.newAlias')}
                </button>
              </div>
              <Card className="p-0">
                {data.aliases.length === 0 ? (
                  <Empty title={t('models.noAliases')} />
                ) : (
                  <ul>
                    {data.aliases.map((alias) => (
                      <li
                        key={alias.id}
                        className="flex items-center gap-2 border-b border-border/60 p-3 last:border-0"
                      >
                        <div className="min-w-0 flex-1">
                          <code dir="ltr">{alias.slug}</code>
                          <p className="text-xs text-muted">
                            →{' '}
                            {alias.target.kind === 'model'
                              ? modelName(alias.target.modelId)
                              : comboName(alias.target.comboId)}
                          </p>
                        </div>
                        <Actions
                          onEdit={() => {
                            openAlias(alias);
                          }}
                          onDelete={() => void remove('aliases', alias.id)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </section>
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-medium">{t('models.combos')}</h2>
                <button
                  type="button"
                  onClick={() => {
                    openCombo();
                  }}
                  className="rounded border border-border px-3 py-1.5 text-sm"
                >
                  {t('models.newCombo')}
                </button>
              </div>
              <Card className="p-0">
                {data.combos.length === 0 ? (
                  <Empty title={t('models.noCombos')} />
                ) : (
                  <ul>
                    {data.combos.map((combo) => (
                      <li
                        key={combo.id}
                        className="flex items-center gap-2 border-b border-border/60 p-3 last:border-0"
                      >
                        <div className="min-w-0 flex-1">
                          <code dir="ltr">{combo.slug}</code>
                          <p className="text-xs text-muted">
                            {t(`models.strategyType.${combo.strategy}`)} ·{' '}
                            {t('models.targetCount', {
                              count: combo.targets.length,
                            })}
                          </p>
                        </div>
                        <Actions
                          onEdit={() => {
                            openCombo(combo);
                          }}
                          onDelete={() => void remove('combos', combo.id)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </section>
          </div>
          {editor === 'combo' && (
            <ComboEditor
              key={selectedCombo?.id ?? 'new'}
              initial={selectedCombo}
              models={data.models}
              names={selectedCombo ? names.filter((name) => name !== selectedCombo.slug) : names}
              onCancel={cancel}
              onSaved={saved}
            />
          )}
          {editor === 'model' && (
            <ModelEditor
              key={selectedModel?.id ?? 'new'}
              initial={selectedModel}
              resources={data}
              names={selectedModel ? names.filter((name) => name !== selectedModel.slug) : names}
              onCancel={cancel}
              onSaved={saved}
            />
          )}
          {editor === 'alias' && (
            <AliasEditor
              key={selectedAlias?.id ?? 'new'}
              initial={selectedAlias}
              resources={data}
              names={selectedAlias ? names.filter((name) => name !== selectedAlias.slug) : names}
              onCancel={cancel}
              onSaved={saved}
            />
          )}
        </>
      )}
    </section>
  );
}

/** Exported for focused client/server-equivalence tests. */
export { comboDraft, validateCombo as validateComboDraft };
