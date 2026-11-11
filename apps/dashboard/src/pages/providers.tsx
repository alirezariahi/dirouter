/**
 * Providers and credential pools (DiTask 7.4). Secrets only exist in the add/rotate
 * password inputs; API responses are rendered as supplied (masked), never unmasked.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, FormError } from '../components/ui/field';
import { Empty, ErrorState, Loading } from '../components/ui/states';
import { api } from '../lib/api';
import { formatDate } from '../lib/date';
import { errorMessage } from '../lib/errors';
import { text } from '../lib/form';
import { currentOrg, useSession } from '../lib/session';
import { useSettings } from '../settings';

type ProviderType = 'openai' | 'azure-openai' | 'openai-compatible' | 'anthropic' | 'gemini';
type CredentialStatus = 'ACTIVE' | 'DISABLED';

interface Timeouts {
  connectMs?: number;
  firstByteMs?: number;
  idleMs?: number;
  totalMs?: number;
}
interface Credential {
  id: string;
  name: string;
  secret: string;
  weight: number;
  status: CredentialStatus;
  cooldownUntil: string | null;
  headers: string[];
  proxyUrl: string | null;
}
interface Provider {
  id: string;
  slug: string;
  name: string;
  type: ProviderType | 'mock';
  baseUrl: string;
  enabled: boolean;
  proxyUrl: string | null;
  timeouts: Timeouts | null;
  options: Record<string, unknown>;
  maxConcurrency: number | null;
  credentials: Credential[];
  createdAt: string;
}
interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: { class: string; message: string };
  modelCount?: number;
}
interface DiscoveredModel {
  upstreamModel: string;
  inCatalog: boolean;
  suggested: boolean;
  catalog?: { key: string; contextWindow?: number; pricing: unknown };
}
interface Discovery extends ProbeResult {
  models: DiscoveredModel[];
}
interface RuntimeHealth {
  gatewayReachable: boolean;
  nodes: unknown[];
  models: { id: string; slug: string; breaker: Breaker | null }[];
  providers: {
    id: string;
    name: string;
    slug: string;
    breaker: Breaker | null;
    credentials: {
      id: string;
      name: string;
      status: string;
      cooldownUntil: string | null;
      disabledUntil: string | null;
      disabledReason: string | null;
      lockouts: { modelId: string; until: string | null }[];
    }[];
  }[];
}
interface Breaker {
  state: 'closed' | 'open' | 'half_open';
  total: number;
  errors: number;
  reopensAt: string | null;
}
interface ProviderBody {
  name: string;
  type?: ProviderType;
  baseUrl?: string;
  enabled: boolean;
  proxyUrl?: string;
  timeouts?: Timeouts;
  options?: Record<string, unknown>;
  maxConcurrency?: number;
  credentials?: (CredentialBody & { secret: string })[];
}
type CredentialBody = {
  name: string;
  weight: number;
  secret?: string;
  headers?: Record<string, string>;
  proxyUrl?: string;
};

const PRESETS = [
  { id: 'openai', type: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
  { id: 'azure-openai', type: 'azure-openai', baseUrl: '' },
  { id: 'custom', type: 'openai-compatible', baseUrl: '' },
  { id: 'openrouter', type: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'deepseek', type: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'groq', type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'together', type: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1' },
  {
    id: 'fireworks',
    type: 'openai-compatible',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
  },
  { id: 'mistral', type: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'xai', type: 'openai-compatible', baseUrl: 'https://api.x.ai/v1' },
  { id: 'cerebras', type: 'openai-compatible', baseUrl: 'https://api.cerebras.ai/v1' },
  { id: 'ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
  { id: 'vllm', type: 'openai-compatible', baseUrl: 'http://localhost:8000/v1' },
] as const;
type PresetId = (typeof PRESETS)[number]['id'];
const preset = (id: PresetId) => PRESETS.find((p) => p.id === id) ?? PRESETS[4];

const PROVIDER_PATH = (org: string, id = '') => `/orgs/${org}/providers${id ? `/${id}` : ''}`;
const optionalText = (value: string) => value.trim() || undefined;
const numberText = (value: string) => {
  const parsed = Number(value);
  return value.trim() && Number.isFinite(parsed) ? parsed : undefined;
};
const timeoutKeys = ['connectMs', 'firstByteMs', 'idleMs', 'totalMs'] as const;
function timeoutBody(form: FormData): Timeouts | undefined {
  const body: Timeouts = {};
  for (const key of timeoutKeys) {
    const value = numberText(text(form, key));
    if (value !== undefined) body[key] = value;
  }
  return Object.keys(body).length ? body : undefined;
}
function headersBody(value: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of value.split('\n')) {
    if (!line.trim()) continue;
    const separator = line.indexOf(':');
    if (separator < 1 || !/^[A-Za-z0-9-]{1,64}$/.test(line.slice(0, separator).trim()))
      throw new Error('providers.invalidHeaders');
    headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return Object.keys(headers).length ? headers : undefined;
}
function credentialBody(form: FormData, secretRequired: boolean): CredentialBody {
  const secret = text(form, 'secret');
  const proxyUrl = text(form, 'credentialProxyUrl').trim();
  return {
    name: text(form, 'credentialName').trim(),
    weight: numberText(text(form, 'weight')) ?? 1,
    ...(secretRequired || secret ? { secret } : {}),
    ...(text(form, 'headers').trim() ? { headers: headersBody(text(form, 'headers')) } : {}),
    ...(proxyUrl ? { proxyUrl } : {}),
  };
}

function Badge({
  tone,
  children,
}: {
  tone: 'good' | 'bad' | 'warn' | 'muted';
  children: ReactNode;
}) {
  const color = {
    good: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    bad: 'bg-danger/15 text-danger',
    warn: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    muted: 'bg-border/50 text-muted',
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-xs ${color}`}>{children}</span>;
}
function BreakerBadge({ breaker }: { breaker: Breaker | null | undefined }) {
  const { t } = useTranslation();
  const state = breaker?.state ?? 'closed';
  return (
    <Badge tone={state === 'closed' ? 'good' : state === 'open' ? 'bad' : 'warn'}>
      {t(`providers.breaker.${state}`)}
    </Badge>
  );
}
function LabeledSelect({
  label,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  const id = props.id ?? props.name;
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <select
        id={id}
        className="h-10 rounded-md border border-border bg-surface px-3 outline-none focus:border-brand"
        {...props}
      >
        {children}
      </select>
    </label>
  );
}
function LabeledArea({
  label,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  const id = props.id ?? props.name;
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <textarea
        id={id}
        className="min-h-20 rounded-md border border-border bg-surface px-3 py-2 outline-none focus:border-brand"
        {...props}
      />
    </label>
  );
}
function NetworkFields({ provider }: { provider?: Provider }) {
  const { t } = useTranslation();
  const [showSecrets, setShowSecrets] = useState(false);
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-medium">{t('providers.network')}</legend>
      {provider?.proxyUrl ? (
        <p className="text-xs text-muted" dir="ltr">
          {t('providers.currentProxy')}: {provider.proxyUrl}
        </p>
      ) : null}
      <Field
        label={t('providers.proxyUrl')}
        name="proxyUrl"
        type={showSecrets ? 'text' : 'password'}
        defaultValue=""
        placeholder={provider ? t('providers.keepProxy') : 'socks5h://user:password@proxy:1080'}
        dir="ltr"
        autoComplete="off"
      />
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={showSecrets}
          onChange={(e) => {
            setShowSecrets(e.target.checked);
          }}
        />
        {t('providers.showProxy')}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t('providers.connectMs')}
          name="connectMs"
          type="number"
          min={1}
          max={120000}
          defaultValue={provider?.timeouts?.connectMs}
          dir="ltr"
        />
        <Field
          label={t('providers.firstByteMs')}
          name="firstByteMs"
          type="number"
          min={1}
          max={900000}
          defaultValue={provider?.timeouts?.firstByteMs}
          dir="ltr"
        />
        <Field
          label={t('providers.idleMs')}
          name="idleMs"
          type="number"
          min={1}
          max={900000}
          defaultValue={provider?.timeouts?.idleMs}
          dir="ltr"
        />
        <Field
          label={t('providers.totalMs')}
          name="totalMs"
          type="number"
          min={1}
          max={3600000}
          defaultValue={provider?.timeouts?.totalMs}
          dir="ltr"
        />
      </div>
      <Field
        label={t('providers.maxConcurrency')}
        name="maxConcurrency"
        type="number"
        min={1}
        max={10000}
        defaultValue={provider?.maxConcurrency ?? ''}
        dir="ltr"
      />
    </fieldset>
  );
}
function CredentialFields({ credential }: { credential?: Credential }) {
  const { t } = useTranslation();
  const editing = Boolean(credential);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t('providers.credentialName')}
          name="credentialName"
          required
          defaultValue={credential?.name ?? ''}
        />
        <Field
          label={t('providers.weight')}
          name="weight"
          type="number"
          required
          min={0}
          max={1000}
          defaultValue={credential?.weight ?? 1}
          dir="ltr"
        />
      </div>
      <Field
        label={editing ? t('providers.newSecret') : t('providers.secret')}
        name="secret"
        type="password"
        required={!editing}
        maxLength={8192}
        dir="ltr"
        autoComplete="new-password"
      />
      <p className="text-xs text-muted">{t('providers.secretOnce')}</p>
      <LabeledArea
        label={t('providers.headers')}
        name="headers"
        placeholder={'x-organization: org_123\nx-project: project_123'}
        dir="ltr"
      />
      <Field
        label={t('providers.credentialProxy')}
        name="credentialProxyUrl"
        placeholder="http://proxy:8080"
        defaultValue=""
        dir="ltr"
        autoComplete="off"
      />
    </>
  );
}
function ProbeNotice({ result }: { result: ProbeResult }) {
  const { t } = useTranslation();
  return (
    <p
      role="status"
      className={`text-sm ${result.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-danger'}`}
    >
      {result.ok
        ? t('providers.testOk', {
            latency: result.latencyMs,
            models: result.modelCount ?? 0,
          })
        : t('providers.testFailed', {
            class: result.error?.class ?? 'connection',
            message: result.error?.message ?? '',
          })}
      {result.status !== undefined ? ` (${result.status})` : ''}
    </p>
  );
}

export default function ProvidersPage() {
  const { t } = useTranslation();
  const settings = useSettings();
  useSession();
  const org = currentOrg()?.id ?? '';
  const canWrite = ['OWNER', 'ADMIN'].includes(currentOrg()?.role ?? '');
  const qc = useQueryClient();
  const [wizard, setWizard] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [presetId, setPresetId] = useState<PresetId>('openai');
  const [wizardProvider, setWizardProvider] = useState<ProviderBody>();
  const [editing, setEditing] = useState<Provider>();
  const [credentialProvider, setCredentialProvider] = useState<Provider>();
  const [rotating, setRotating] = useState<{ provider: Provider; credential: Credential }>();
  const [discoverProvider, setDiscoverProvider] = useState<Provider>();
  const [discovery, setDiscovery] = useState<Discovery>();
  const [addModelForms, setAddModelForms] = useState<
    Record<string, { inputPerMTok: string; outputPerMTok: string }>
  >({});
  const [addingModel, setAddingModel] = useState('');
  const [probe, setProbe] = useState<Record<string, ProbeResult>>({});
  const [notice, setNotice] = useState('');
  const [formError, setFormError] = useState<unknown>();
  const [actionError, setActionError] = useState<unknown>();

  const providers = useQuery({
    queryKey: ['providers', org],
    queryFn: () => api<Provider[]>(PROVIDER_PATH(org)),
    enabled: Boolean(org),
  });
  const health = useQuery({
    queryKey: ['health', org],
    queryFn: () => api<RuntimeHealth>(`/orgs/${org}/health/runtime`),
    enabled: Boolean(org),
    refetchInterval: 30_000,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['providers', org] });
    void qc.invalidateQueries({ queryKey: ['health', org] });
  };
  const closeWizard = () => {
    setWizard(false);
    setStep(1);
    setWizardProvider(undefined);
    setFormError(undefined);
  };
  const saveProvider = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: ProviderBody }) =>
      api<Provider>(PROVIDER_PATH(org, id), { method: id ? 'PATCH' : 'POST', body }),
    onSuccess: () => {
      invalidate();
      closeWizard();
      setEditing(undefined);
    },
    onError: setFormError,
  });
  const saveCredential = useMutation({
    mutationFn: ({
      providerId,
      credentialId,
      body,
    }: {
      providerId: string;
      credentialId?: string;
      body: CredentialBody & { status?: CredentialStatus };
    }) =>
      api<Provider>(
        `${PROVIDER_PATH(org, providerId)}/credentials${credentialId ? `/${credentialId}` : ''}`,
        { method: credentialId ? 'PATCH' : 'POST', body },
      ),
    onSuccess: () => {
      invalidate();
      setCredentialProvider(undefined);
      setRotating(undefined);
    },
    onError: setFormError,
  });
  const statusMutation = useMutation({
    mutationFn: ({ provider, credential }: { provider: Provider; credential: Credential }) =>
      api<Provider>(`${PROVIDER_PATH(org, provider.id)}/credentials/${credential.id}`, {
        method: 'PATCH',
        body: { status: credential.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' },
      }),
    onSuccess: invalidate,
    onError: setActionError,
  });
  const enabledMutation = useMutation({
    mutationFn: (provider: Provider) =>
      api<Provider>(PROVIDER_PATH(org, provider.id), {
        method: 'PATCH',
        body: { enabled: !provider.enabled },
      }),
    onSuccess: invalidate,
    onError: setActionError,
  });
  const remove = useMutation({
    mutationFn: ({ providerId, credentialId }: { providerId: string; credentialId?: string }) =>
      api<undefined>(
        `${PROVIDER_PATH(org, providerId)}${credentialId ? `/credentials/${credentialId}` : ''}`,
        { method: 'DELETE' },
      ),
    onSuccess: invalidate,
    onError: setActionError,
  });
  const test = useMutation({
    mutationFn: ({ providerId, credentialId }: { providerId: string; credentialId?: string }) =>
      api<ProbeResult>(`${PROVIDER_PATH(org, providerId)}/test`, {
        method: 'POST',
        body: credentialId ? { credentialId } : {},
      }),
    onSuccess: (result, variables) => {
      setProbe((old) => ({
        ...old,
        [`${variables.providerId}:${variables.credentialId ?? ''}`]: result,
      }));
    },
    onError: setActionError,
  });
  const discover = useMutation({
    mutationFn: (providerId: string) =>
      api<Discovery>(`${PROVIDER_PATH(org, providerId)}/discover`, { method: 'POST', body: {} }),
    onSuccess: (result) => {
      setDiscovery(result);
      setAddModelForms({});
    },
    onError: setActionError,
  });
  const addModels = useMutation({
    mutationFn: async () => {
      if (!discoverProvider || !discovery) return 0;
      let added = 0;
      const failures: string[] = [];
      for (const model of discovery.models) {
        const pricing = addModelForms[model.upstreamModel];
        if (!pricing || model.inCatalog) continue;
        setAddingModel(model.upstreamModel);
        try {
          await api(`/orgs/${org}/models`, {
            method: 'POST',
            body: {
              providerId: discoverProvider.id,
              upstreamModel: model.upstreamModel,
              ...(model.catalog
                ? { catalogKey: model.catalog.key }
                : {
                    pricing: {
                      inputPerMTok: pricing.inputPerMTok.trim(),
                      outputPerMTok: pricing.outputPerMTok.trim(),
                    },
                  }),
            },
          });
          added += 1;
        } catch {
          failures.push(model.upstreamModel);
        }
      }
      if (failures.length)
        throw new Error(t('providers.modelAddFailed', { models: failures.join(', ') }));
      return added;
    },
    onSuccess: (added) => {
      setNotice(t('providers.modelsAdded', { count: added }));
      setDiscoverProvider(undefined);
      setDiscovery(undefined);
      setAddModelForms({});
      invalidate();
    },
    onError: setActionError,
    onSettled: () => {
      setAddingModel('');
    },
  });
  function toggleModel(model: DiscoveredModel, checked: boolean) {
    setAddModelForms((old) => {
      const next = { ...old };
      if (checked)
        next[model.upstreamModel] = old[model.upstreamModel] ?? {
          inputPerMTok: '0',
          outputPerMTok: '0',
        };
      else {
        const { [model.upstreamModel]: _removed, ...rest } = next;
        return rest;
      }
      return next;
    });
  }

  function submitProvider(event: SyntheticEvent<HTMLFormElement>, id?: string) {
    event.preventDefault();
    setFormError(undefined);
    const form = new FormData(event.currentTarget);
    const selected = preset(presetId);
    const baseUrl = text(form, 'baseUrl').trim();
    const proxyUrl = optionalText(text(form, 'proxyUrl'));
    const body: ProviderBody = {
      name: text(form, 'name').trim(),
      ...(!id ? { type: selected.type } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      enabled: id && editing ? editing.enabled : true,
      ...(proxyUrl ? { proxyUrl } : {}),
      ...(timeoutBody(form) ? { timeouts: timeoutBody(form) } : {}),
      ...(numberText(text(form, 'maxConcurrency'))
        ? { maxConcurrency: numberText(text(form, 'maxConcurrency')) }
        : {}),
      ...(!id && selected.type === 'openai-compatible' && selected.id !== 'custom'
        ? { options: { preset: selected.id } }
        : {}),
    };
    saveProvider.mutate({ ...(id ? { id } : {}), body });
  }
  function submitCredential(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);
    const provider = credentialProvider ?? rotating?.provider;
    if (!provider) return;
    try {
      saveCredential.mutate({
        providerId: provider.id,
        ...(rotating ? { credentialId: rotating.credential.id } : {}),
        body: credentialBody(new FormData(event.currentTarget), !rotating),
      });
    } catch (error) {
      setFormError(error);
    }
  }
  function startDiscovery(provider: Provider) {
    setActionError(undefined);
    setNotice('');
    setDiscovery(undefined);
    setAddModelForms({});
    setDiscoverProvider(provider);
    discover.mutate(provider.id);
  }

  if (providers.isPending) return <Loading />;
  if (providers.isError)
    return <ErrorState error={providers.error} onRetry={() => void providers.refetch()} />;

  const rows = providers.data;
  const activePreset = preset(presetId);
  const providerModal = wizard || editing;
  const credentialModal = credentialProvider ?? rotating?.provider;
  const message = formError
    ? t(errorMessage(formError, t), { defaultValue: errorMessage(formError, t) })
    : undefined;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('providers.title')}</h1>
          <p className="text-sm text-muted">{t('providers.subtitle')}</p>
        </div>
        {canWrite ? (
          <Button
            className="ms-auto"
            onClick={() => {
              setWizard(true);
              setStep(1);
              setFormError(undefined);
            }}
          >
            {t('providers.add')}
          </Button>
        ) : null}
      </div>
      <p className="rounded-md bg-brand/10 px-3 py-2 text-xs text-muted">
        {t('providers.secretPolicy')}
      </p>
      {notice ? (
        <p role="status" className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      {actionError ? <FormError message={errorMessage(actionError, t)} /> : null}
      {health.data && !health.data.gatewayReachable ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {t('providers.healthUnavailable')}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <Card>
          <Empty title={t('providers.empty')}>
            {canWrite ? (
              <Button
                onClick={() => {
                  setWizard(true);
                }}
              >
                {t('providers.add')}
              </Button>
            ) : null}
          </Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {rows.map((provider) => {
            const runtime = health.data?.providers.find((p) => p.id === provider.id);
            const providerProbe = probe[`${provider.id}:`];
            return (
              <Card
                key={provider.id}
                data-testid={`provider-${provider.slug}`}
                className="flex flex-col gap-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div>
                    <h2 className="text-lg font-semibold">{provider.name}</h2>
                    <p className="text-xs text-muted" dir="ltr">
                      {provider.type} · {provider.baseUrl}
                    </p>
                  </div>
                  <Badge tone={provider.enabled ? 'good' : 'muted'}>
                    {provider.enabled ? t('providers.enabled') : t('providers.disabled')}
                  </Badge>
                  <BreakerBadge breaker={runtime?.breaker} />
                  {runtime?.breaker ? (
                    <span className="text-xs text-muted">
                      {t('providers.errors', {
                        errors: runtime.breaker.errors,
                        total: runtime.breaker.total,
                      })}
                    </span>
                  ) : null}
                  {canWrite ? (
                    <div className="ms-auto flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          test.mutate({ providerId: provider.id });
                        }}
                        disabled={test.isPending}
                      >
                        {t('providers.test')}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          startDiscovery(provider);
                        }}
                        disabled={discover.isPending}
                      >
                        {t('providers.discover')}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setFormError(undefined);
                          setEditing(provider);
                        }}
                      >
                        {t('providers.edit')}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          enabledMutation.mutate(provider);
                        }}
                      >
                        {provider.enabled ? t('providers.disable') : t('providers.enable')}
                      </Button>
                      <Button
                        variant="ghost"
                        className="text-danger"
                        onClick={() => {
                          if (
                            window.confirm(
                              t('providers.deleteProviderConfirm', {
                                name: provider.name,
                              }),
                            )
                          )
                            remove.mutate({ providerId: provider.id });
                        }}
                      >
                        {t('providers.delete')}
                      </Button>
                    </div>
                  ) : null}
                </div>
                {providerProbe ? <ProbeNotice result={providerProbe} /> : null}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  <span>
                    {t('providers.proxy')}:{' '}
                    <span dir="ltr">{provider.proxyUrl ?? t('providers.none')}</span>
                  </span>
                  <span>
                    {t('providers.timeoutSummary')}:{' '}
                    {provider.timeouts
                      ? Object.values(provider.timeouts).join(' / ')
                      : t('providers.default')}
                  </span>
                  <span>
                    {t('providers.maxConcurrency')}:{' '}
                    {provider.maxConcurrency ?? t('providers.unlimited')}
                  </span>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">{t('providers.credentials')}</h3>
                    <span className="text-xs text-muted">{provider.credentials.length}</span>
                    {canWrite ? (
                      <Button
                        variant="outline"
                        className="ms-auto h-8 text-xs"
                        onClick={() => {
                          setFormError(undefined);
                          setCredentialProvider(provider);
                        }}
                      >
                        {t('providers.addCredential')}
                      </Button>
                    ) : null}
                  </div>
                  {provider.credentials.length === 0 ? (
                    <p className="text-sm text-muted">{t('providers.noCredentials')}</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[720px] text-sm">
                        <thead className="text-start text-xs text-muted">
                          <tr>
                            <th className="py-2 text-start font-normal">
                              {t('providers.credentialName')}
                            </th>
                            <th className="py-2 text-start font-normal">
                              {t('providers.maskedSecret')}
                            </th>
                            <th className="py-2 text-start font-normal">{t('providers.weight')}</th>
                            <th className="py-2 text-start font-normal">{t('providers.status')}</th>
                            <th className="py-2 text-start font-normal">
                              {t('providers.runtime')}
                            </th>
                            <th className="py-2 text-start font-normal">
                              {t('providers.connection')}
                            </th>
                            {canWrite ? (
                              <th className="py-2 text-start font-normal">
                                {t('providers.actions')}
                              </th>
                            ) : null}
                          </tr>
                        </thead>
                        <tbody>
                          {provider.credentials.map((credential) => {
                            const runtimeCredential = runtime?.credentials.find(
                              (c) => c.id === credential.id,
                            );
                            const cooldown =
                              runtimeCredential?.cooldownUntil ?? credential.cooldownUntil;
                            const credentialProbe = probe[`${provider.id}:${credential.id}`];
                            return (
                              <tr
                                key={credential.id}
                                className="border-t border-border align-top"
                                data-testid={`credential-${credential.id}`}
                              >
                                <td className="py-3 pe-3">
                                  <span className="font-medium">{credential.name}</span>
                                  {credential.headers.length ? (
                                    <span className="block text-xs text-muted" dir="ltr">
                                      {credential.headers.join(', ')}
                                    </span>
                                  ) : null}
                                </td>
                                <td className="py-3 pe-3" dir="ltr">
                                  <code>{credential.secret}</code>
                                </td>
                                <td className="py-3 pe-3">{credential.weight}</td>
                                <td className="py-3 pe-3">
                                  <Badge tone={credential.status === 'ACTIVE' ? 'good' : 'muted'}>
                                    {t(
                                      `dashboardTranslations.providers.credentialStatus.${credential.status}`,
                                    )}
                                  </Badge>
                                </td>
                                <td className="py-3 pe-3 text-xs">
                                  {cooldown ? (
                                    <span className="text-amber-700 dark:text-amber-300">
                                      {t('providers.cooldownUntil', {
                                        date: formatDate(cooldown, {
                                          calendar: settings.calendar,
                                          lang: settings.lang,
                                          time: true,
                                        }),
                                      })}
                                    </span>
                                  ) : runtimeCredential?.disabledUntil ? (
                                    <span className="text-danger">
                                      {t('providers.runtimeDisabled', {
                                        reason: runtimeCredential.disabledReason ?? '',
                                      })}
                                    </span>
                                  ) : (
                                    t('providers.healthy')
                                  )}
                                  {runtimeCredential?.lockouts.map((lockout) => (
                                    <span
                                      key={lockout.modelId}
                                      className="block text-amber-700 dark:text-amber-300"
                                      dir="ltr"
                                    >
                                      {lockout.modelId}
                                    </span>
                                  ))}
                                </td>
                                <td className="py-3 pe-3 text-xs" dir="ltr">
                                  {credential.proxyUrl ?? t('providers.inherited')}
                                </td>
                                {canWrite ? (
                                  <td className="py-3">
                                    <div className="flex flex-wrap gap-1">
                                      <Button
                                        className="h-7 px-2 text-xs"
                                        variant="outline"
                                        onClick={() => {
                                          test.mutate({
                                            providerId: provider.id,
                                            credentialId: credential.id,
                                          });
                                        }}
                                      >
                                        {t('providers.test')}
                                      </Button>
                                      <Button
                                        className="h-7 px-2 text-xs"
                                        variant="outline"
                                        onClick={() => {
                                          statusMutation.mutate({ provider, credential });
                                        }}
                                      >
                                        {credential.status === 'ACTIVE'
                                          ? t('providers.disable')
                                          : t('providers.enable')}
                                      </Button>
                                      <Button
                                        className="h-7 px-2 text-xs"
                                        variant="outline"
                                        onClick={() => {
                                          setFormError(undefined);
                                          setRotating({ provider, credential });
                                        }}
                                      >
                                        {t('providers.rotate')}
                                      </Button>
                                      <Button
                                        className="h-7 px-2 text-xs text-danger"
                                        variant="ghost"
                                        onClick={() => {
                                          if (
                                            window.confirm(
                                              t(
                                                'dashboardTranslations.providers.deleteCredentialConfirm',
                                                {
                                                  name: credential.name,
                                                },
                                              ),
                                            )
                                          )
                                            remove.mutate({
                                              providerId: provider.id,
                                              credentialId: credential.id,
                                            });
                                        }}
                                      >
                                        {t('providers.delete')}
                                      </Button>
                                    </div>
                                    {credentialProbe ? (
                                      <div className="mt-2 max-w-xs">
                                        <ProbeNotice result={credentialProbe} />
                                      </div>
                                    ) : null}
                                  </td>
                                ) : null}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {providerModal ? (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={editing ? t('providers.editProvider') : t('providers.add')}
        >
          <Card className="mx-auto my-8 w-full max-w-2xl">
            <div className="mb-4 flex items-center gap-3">
              <div>
                <h2 className="text-xl font-semibold">
                  {editing ? t('providers.editProvider') : t('providers.add')}
                </h2>
                {!editing ? (
                  <p className="text-xs text-muted">{t('providers.step', { step })}</p>
                ) : null}
              </div>
              <Button
                variant="ghost"
                className="ms-auto"
                aria-label={t('providers.close')}
                onClick={() => {
                  closeWizard();
                  setEditing(undefined);
                }}
              >
                ×
              </Button>
            </div>
            <FormError message={message} />
            {editing ? (
              <form
                className="mt-3 flex flex-col gap-3"
                onSubmit={(e) => {
                  submitProvider(e, editing.id);
                }}
              >
                <Field
                  label={t('providers.name')}
                  name="name"
                  required
                  maxLength={100}
                  defaultValue={editing.name}
                />
                <Field
                  label={t('providers.baseUrl')}
                  name="baseUrl"
                  type="url"
                  required
                  dir="ltr"
                  defaultValue={editing.baseUrl}
                />
                <NetworkFields provider={editing} />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditing(undefined);
                    }}
                  >
                    {t('providers.cancel')}
                  </Button>
                  <Button type="submit" disabled={saveProvider.isPending}>
                    {t('providers.save')}
                  </Button>
                </div>
              </form>
            ) : (
              <>
                {step === 1 ? (
                  <div className="mt-3 flex flex-col gap-3">
                    <LabeledSelect
                      label={t('providers.preset')}
                      value={presetId}
                      onChange={(e) => {
                        setPresetId(e.target.value as PresetId);
                      }}
                    >
                      {PRESETS.map((item) => (
                        <option key={item.id} value={item.id}>
                          {t(`providers.presets.${item.id}`)}
                        </option>
                      ))}
                    </LabeledSelect>
                    <p className="rounded-md bg-border/30 p-3 text-sm text-muted">
                      {t(`providers.presetHelp.${activePreset.type}`)}
                    </p>
                    <div className="flex justify-end">
                      <Button
                        onClick={() => {
                          setStep(2);
                        }}
                      >
                        {t('providers.next')}
                      </Button>
                    </div>
                  </div>
                ) : null}
                {step === 2 ? (
                  <form
                    className="mt-3 flex flex-col gap-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const form = new FormData(e.currentTarget);
                      const baseUrl = text(form, 'baseUrl').trim();
                      setWizardProvider({
                        name: text(form, 'name').trim(),
                        type: activePreset.type,
                        ...(baseUrl ? { baseUrl } : {}),
                        enabled: true,
                        ...(optionalText(text(form, 'proxyUrl'))
                          ? { proxyUrl: optionalText(text(form, 'proxyUrl')) }
                          : {}),
                        ...(timeoutBody(form) ? { timeouts: timeoutBody(form) } : {}),
                        ...(numberText(text(form, 'maxConcurrency'))
                          ? { maxConcurrency: numberText(text(form, 'maxConcurrency')) }
                          : {}),
                        ...(activePreset.type === 'openai-compatible' &&
                        activePreset.id !== 'custom'
                          ? { options: { preset: activePreset.id } }
                          : {}),
                      });
                      setStep(3);
                    }}
                  >
                    <Field
                      label={t('providers.name')}
                      name="name"
                      required
                      maxLength={100}
                      defaultValue={
                        wizardProvider?.name ?? t(`providers.presets.${activePreset.id}`)
                      }
                    />
                    <Field
                      label={t('providers.baseUrl')}
                      name="baseUrl"
                      type="url"
                      required
                      dir="ltr"
                      defaultValue={wizardProvider?.baseUrl ?? activePreset.baseUrl}
                    />
                    <NetworkFields />
                    <div className="flex justify-between">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setStep(1);
                        }}
                      >
                        {t('providers.back')}
                      </Button>
                      <Button type="submit">{t('providers.next')}</Button>
                    </div>
                  </form>
                ) : null}
                {step === 3 ? (
                  <form
                    className="mt-3 flex flex-col gap-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setFormError(undefined);
                      try {
                        const credential = credentialBody(
                          new FormData(e.currentTarget),
                          true,
                        ) as CredentialBody & { secret: string };
                        if (wizardProvider)
                          saveProvider.mutate({
                            body: {
                              ...wizardProvider,
                              credentials: [credential],
                            },
                          });
                      } catch (error) {
                        setFormError(error);
                      }
                    }}
                  >
                    <p className="text-sm text-muted">{t('providers.firstCredential')}</p>
                    <CredentialFields />
                    <div className="flex justify-between">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setStep(2);
                        }}
                      >
                        {t('providers.back')}
                      </Button>
                      <Button type="submit" disabled={saveProvider.isPending}>
                        {t('providers.create')}
                      </Button>
                    </div>
                  </form>
                ) : null}
              </>
            )}
          </Card>
        </div>
      ) : null}

      {credentialModal ? (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={rotating ? t('providers.rotateCredential') : t('providers.addCredential')}
        >
          <Card className="mx-auto my-8 w-full max-w-lg">
            <div className="mb-4 flex items-center gap-3">
              <h2 className="text-xl font-semibold">
                {rotating ? t('providers.rotateCredential') : t('providers.addCredential')}
              </h2>
              <Button
                variant="ghost"
                className="ms-auto"
                aria-label={t('providers.close')}
                onClick={() => {
                  setCredentialProvider(undefined);
                  setRotating(undefined);
                }}
              >
                ×
              </Button>
            </div>
            <p className="mb-3 text-sm text-muted">
              {credentialModal.name}
              {rotating ? ` · ${rotating.credential.name} · ${rotating.credential.secret}` : ''}
            </p>
            <FormError message={message} />
            <form className="mt-3 flex flex-col gap-3" onSubmit={submitCredential}>
              <CredentialFields credential={rotating?.credential} />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setCredentialProvider(undefined);
                    setRotating(undefined);
                  }}
                >
                  {t('providers.cancel')}
                </Button>
                <Button type="submit" disabled={saveCredential.isPending}>
                  {rotating ? t('providers.rotateSave') : t('providers.save')}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      ) : null}

      {discoverProvider ? (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t('providers.discover')}
        >
          <Card className="mx-auto my-8 w-full max-w-2xl">
            <div className="mb-4 flex items-center gap-3">
              <div>
                <h2 className="text-xl font-semibold">{t('providers.discoveredModels')}</h2>
                <p className="text-sm text-muted">{discoverProvider.name}</p>
              </div>
              <Button
                variant="ghost"
                className="ms-auto"
                aria-label={t('providers.close')}
                onClick={() => {
                  setDiscoverProvider(undefined);
                }}
              >
                ×
              </Button>
            </div>
            {discover.isPending ? <Loading /> : null}
            {discovery ? (
              <div className="flex flex-col gap-3">
                <ProbeNotice result={discovery} />
                <p className="text-xs text-muted">{t('providers.discoveryHelp')}</p>
                {discovery.models.length === 0 ? (
                  <Empty title={t('providers.noModels')} />
                ) : (
                  <ul className="max-h-80 divide-y divide-border overflow-y-auto">
                    {discovery.models.map((model) => {
                      const selectable = !model.inCatalog;
                      const selected = Boolean(addModelForms[model.upstreamModel]);
                      return (
                        <li key={model.upstreamModel} className="flex flex-col gap-2 py-3">
                          <div className="flex items-center gap-3">
                            <input
                              type="checkbox"
                              aria-label={t('providers.selectModel', {
                                model: model.upstreamModel,
                              })}
                              disabled={!selectable}
                              checked={selected}
                              onChange={(e) => {
                                toggleModel(model, e.target.checked);
                              }}
                            />
                            <code dir="ltr">{model.upstreamModel}</code>
                            {model.inCatalog ? (
                              <Badge tone="muted">{t('providers.inCatalog')}</Badge>
                            ) : model.catalog ? (
                              <Badge tone="good">{t('providers.newModel')}</Badge>
                            ) : (
                              <Badge tone="warn">{t('providers.pricingRequired')}</Badge>
                            )}
                            {model.catalog?.contextWindow ? (
                              <span className="ms-auto text-xs text-muted">
                                {model.catalog.contextWindow.toLocaleString()}{' '}
                                {t('providers.tokens')}
                              </span>
                            ) : null}
                          </div>
                          {selected && !model.catalog ? (
                            <div className="grid gap-2 ps-7 sm:grid-cols-2">
                              <Field
                                label={t('providers.inputPrice')}
                                aria-label={t('providers.inputPriceFor', {
                                  model: model.upstreamModel,
                                })}
                                type="number"
                                min={0}
                                step="any"
                                required
                                value={addModelForms[model.upstreamModel]?.inputPerMTok ?? '0'}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  setAddModelForms((old) => ({
                                    ...old,
                                    [model.upstreamModel]: {
                                      inputPerMTok: value,
                                      outputPerMTok: old[model.upstreamModel]?.outputPerMTok ?? '0',
                                    },
                                  }));
                                }}
                                dir="ltr"
                              />
                              <Field
                                label={t('providers.outputPrice')}
                                aria-label={t('providers.outputPriceFor', {
                                  model: model.upstreamModel,
                                })}
                                type="number"
                                min={0}
                                step="any"
                                required
                                value={addModelForms[model.upstreamModel]?.outputPerMTok ?? '0'}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  setAddModelForms((old) => ({
                                    ...old,
                                    [model.upstreamModel]: {
                                      inputPerMTok: old[model.upstreamModel]?.inputPerMTok ?? '0',
                                      outputPerMTok: value,
                                    },
                                  }));
                                }}
                                dir="ltr"
                              />
                            </div>
                          ) : null}
                          {addingModel === model.upstreamModel ? (
                            <span className="ps-7 text-xs text-muted">
                              {t('providers.addingModel')}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDiscoverProvider(undefined);
                    }}
                  >
                    {t('providers.cancel')}
                  </Button>
                  <Button
                    disabled={addModels.isPending || Object.keys(addModelForms).length === 0}
                    onClick={() => {
                      addModels.mutate();
                    }}
                  >
                    {t('providers.addSelected')}
                  </Button>
                </div>
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}
    </section>
  );
}
