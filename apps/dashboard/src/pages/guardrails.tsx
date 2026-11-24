/**
 * Guardrail policies (card 15.2): list, enable/disable, delete and create, with a live test that
 * shows what a sample text would do under the draft settings before anything is saved.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PageHeader, Section, selectClass, textareaClass } from '../components/s2/common';
import { Button } from '../components/ui/button';
import { Field, FormError } from '../components/ui/field';
import { Loading } from '../components/ui/states';
import { api, ApiError } from '../lib/api';
import { listOf, useFormat } from '../lib/s2-format';
import type { SubmitEvent } from '../lib/form';
import { errorMessage, fieldError } from '../lib/errors';
import { can, currentOrg, useSession } from '../lib/session';
import { configOf } from '../lib/s2-helpers';

const TYPES = [
  'regex',
  'keyword',
  'pii',
  'secret',
  'prompt_injection',
  'max_input_tokens',
  'json_schema',
] as const;
const STAGES = ['request', 'response', 'both'] as const;
const ACTIONS = ['block', 'redact', 'flag'] as const;
const PII = ['email', 'credit_card', 'iban', 'national_id', 'phone'] as const;
type GuardrailType = (typeof TYPES)[number];

interface Policy {
  id: string;
  name: string;
  enabled: boolean;
  stage: (typeof STAGES)[number];
  type: GuardrailType;
  action: (typeof ACTIONS)[number];
}
interface Preview {
  blocked: boolean;
  matches?: string[];
  redacted?: boolean | string;
  redactedText?: string;
  estimatedTokens?: number;
  valid?: boolean;
}
interface Draft {
  name: string;
  type: GuardrailType;
  stage: (typeof STAGES)[number];
  action: (typeof ACTIONS)[number];
  pattern: string;
  flags: string;
  terms: string;
  piiType: (typeof PII)[number];
  maxTokens: string;
  schema: string;
  message: string;
}
/** Limits enforced by the API (guardrails controller and regex-safety). */
const MAX_PATTERN = 1000;
const MAX_SAMPLE = 10_000;

/**
 * The server's own words when it refuses a regex (nested quantifiers, backreferences, too long,
 * too slow, bad flags) so they can be shown next to the pattern field.
 */
function patternProblem(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || (error.status !== 400 && error.status !== 422))
    return undefined;
  const field = error.problem.errors?.find((e) => /pattern|flags/.test(e.path))?.message;
  if (field) return field;
  const detail = error.problem.detail ?? '';
  return /regex|pattern/i.test(detail) ? detail : undefined;
}

const EMPTY: Draft = {
  name: '',
  type: 'regex',
  stage: 'both',
  action: 'block',
  pattern: '',
  flags: 'gi',
  terms: '',
  piiType: 'email',
  maxTokens: '8000',
  schema: '{\n  "type": "object"\n}',
  message: '',
};

export default function GuardrailsPage() {
  const { t } = useTranslation();
  const { n } = useFormat();
  const qc = useQueryClient();
  const user = useSession();
  const org = currentOrg();
  // Creating, changing and even testing a policy needs `guardrails:write`: the test runs a
  // caller-supplied pattern on the server.
  const canWrite = can(
    user?.organizations.find((o) => o.id === org?.id),
    'guardrails:write',
  );
  const base = `/orgs/${org?.id ?? ''}/guardrails`;
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [sample, setSample] = useState('');
  const [localError, setLocalError] = useState<string>();

  const query = useQuery({
    queryKey: ['guardrails', org?.id],
    queryFn: () => api<unknown>(base),
    enabled: Boolean(org),
  });
  const done = () => qc.invalidateQueries({ queryKey: ['guardrails', org?.id] });
  const build = () => {
    setLocalError(undefined);
    try {
      return configOf(draft);
    } catch {
      setLocalError(t('s2.config.invalidJson'));
      return undefined;
    }
  };
  const preview = useMutation({
    mutationFn: (config: Record<string, unknown>) =>
      api<Preview>(`${base}/test`, {
        method: 'POST',
        body: { type: draft.type, action: draft.action, config, text: sample },
      }),
  });
  const create = useMutation({
    mutationFn: (config: Record<string, unknown>) =>
      api<unknown>(base, {
        method: 'POST',
        body: {
          name: draft.name.trim(),
          type: draft.type,
          stage: draft.stage,
          action: draft.action,
          config,
          ...(draft.message.trim() ? { message: draft.message.trim() } : {}),
        },
      }),
    onSuccess: () => {
      setDraft(EMPTY);
      preview.reset();
      void done();
    },
  });
  const toggle = useMutation({
    mutationFn: (policy: Policy) =>
      api<unknown>(`${base}/${policy.id}`, { method: 'PATCH', body: { enabled: !policy.enabled } }),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<unknown>(`${base}/${id}`, { method: 'DELETE' }),
    onSuccess: done,
  });

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    preview.reset();
  };
  const policies = listOf<Policy>(query.data);
  const patternError =
    draft.type === 'regex' ? patternProblem(create.error ?? preview.error) : undefined;
  const sampleError =
    fieldError(preview.error, 'text') ??
    (sample.length > MAX_SAMPLE ? t('s2.guardrails.sampleTooLong') : undefined);
  // Errors already shown next to a field are not repeated in the banner.
  const failure =
    (patternError ? undefined : (create.error ?? (sampleError ? undefined : preview.error))) ??
    toggle.error ??
    remove.error ??
    query.error;
  const result = preview.data;
  const redactedText =
    typeof result?.redactedText === 'string'
      ? result.redactedText
      : typeof result?.redacted === 'string'
        ? result.redacted
        : undefined;

  return (
    <section className="enter flex flex-col gap-6">
      <PageHeader title={t('s2.guardrails.title')} subtitle={t('s2.guardrails.subtitle')} />
      <FormError message={localError ?? (failure ? errorMessage(failure, t) : undefined)} />

      <Section title={t('s2.guardrails.title')}>
        {query.isPending ? (
          <Loading />
        ) : policies.length === 0 ? (
          <p className="text-sm text-muted">{t('s2.common.none')}</p>
        ) : (
          <ul data-testid="guardrail-list" className="flex flex-col gap-2">
            {policies.map((policy) => (
              <li
                key={policy.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium">{policy.name}</p>
                  <p className="text-xs text-muted">
                    {t(`s2.guardrails.types.${policy.type}`)} ·{' '}
                    {t(`s2.guardrails.stages.${policy.stage}`)} ·{' '}
                    {t(`s2.guardrails.actions.${policy.action}`)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted">
                    {policy.enabled ? t('s2.common.enabled') : t('s2.common.disabled')}
                  </span>
                  {canWrite ? (
                    <>
                      <Button
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        disabled={toggle.isPending}
                        onClick={() => {
                          toggle.mutate(policy);
                        }}
                      >
                        {policy.enabled ? t('s2.common.disable') : t('s2.common.enable')}
                      </Button>
                      <Button
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        disabled={remove.isPending}
                        onClick={() => {
                          remove.mutate(policy.id);
                        }}
                      >
                        {t('s2.common.delete')}
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {canWrite ? null : (
        <p data-testid="guardrails-read-only" className="text-sm text-muted">
          {t('s2.guardrails.readOnly')}
        </p>
      )}
      {canWrite ? (
        <Section title={t('s2.guardrails.newTitle')}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event: SubmitEvent) => {
              event.preventDefault();
              const config = build();
              if (config) create.mutate(config);
            }}
          >
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <Field
                name="guardrail-name"
                label={t('s2.common.name')}
                required
                maxLength={100}
                value={draft.name}
                onChange={(event) => {
                  set('name', event.target.value);
                }}
              />
              <label htmlFor="guardrail-type" className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('s2.common.type')}</span>
                <select
                  id="guardrail-type"
                  className={selectClass}
                  value={draft.type}
                  onChange={(event) => {
                    set('type', event.target.value as GuardrailType);
                  }}
                >
                  {TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`s2.guardrails.types.${type}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="guardrail-stage" className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('s2.guardrails.stage')}</span>
                <select
                  id="guardrail-stage"
                  className={selectClass}
                  value={draft.stage}
                  onChange={(event) => {
                    set('stage', event.target.value as Draft['stage']);
                  }}
                >
                  {STAGES.map((stage) => (
                    <option key={stage} value={stage}>
                      {t(`s2.guardrails.stages.${stage}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="guardrail-action" className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('s2.guardrails.action')}</span>
                <select
                  id="guardrail-action"
                  className={selectClass}
                  value={draft.action}
                  onChange={(event) => {
                    set('action', event.target.value as Draft['action']);
                  }}
                >
                  {ACTIONS.map((action) => (
                    <option key={action} value={action}>
                      {t(`s2.guardrails.actions.${action}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {draft.type === 'regex' ? (
              <p className="text-xs text-muted">{t('s2.guardrails.patternHelp')}</p>
            ) : null}
            {draft.type === 'regex' ? (
              <div className="grid gap-3 md:grid-cols-[1fr_8rem]">
                <Field
                  name="guardrail-pattern"
                  label={t('s2.guardrails.pattern')}
                  dir="ltr"
                  required
                  maxLength={MAX_PATTERN}
                  value={draft.pattern}
                  onChange={(event) => {
                    set('pattern', event.target.value);
                    create.reset();
                  }}
                  error={patternError}
                />
                <Field
                  name="guardrail-flags"
                  label={t('s2.guardrails.flags')}
                  dir="ltr"
                  value={draft.flags}
                  onChange={(event) => {
                    set('flags', event.target.value);
                  }}
                />
              </div>
            ) : null}
            {draft.type === 'keyword' ? (
              <Field
                name="guardrail-terms"
                label={t('s2.guardrails.terms')}
                required
                value={draft.terms}
                onChange={(event) => {
                  set('terms', event.target.value);
                }}
              />
            ) : null}
            {draft.type === 'pii' ? (
              <label htmlFor="guardrail-pii" className="flex max-w-xs flex-col gap-1 text-sm">
                <span className="font-medium">{t('s2.guardrails.piiType')}</span>
                <select
                  id="guardrail-pii"
                  className={selectClass}
                  value={draft.piiType}
                  onChange={(event) => {
                    set('piiType', event.target.value as Draft['piiType']);
                  }}
                >
                  {PII.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`s2.guardrails.pii.${kind}`)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {draft.type === 'max_input_tokens' ? (
              <Field
                name="guardrail-max-tokens"
                label={t('s2.guardrails.maxTokens')}
                type="number"
                min={1}
                dir="ltr"
                className="max-w-xs"
                value={draft.maxTokens}
                onChange={(event) => {
                  set('maxTokens', event.target.value);
                }}
              />
            ) : null}
            {draft.type === 'json_schema' ? (
              <label htmlFor="guardrail-schema" className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('s2.guardrails.schema')}</span>
                <textarea
                  id="guardrail-schema"
                  dir="ltr"
                  className={`${textareaClass} font-mono`}
                  value={draft.schema}
                  onChange={(event) => {
                    set('schema', event.target.value);
                  }}
                />
              </label>
            ) : null}
            <Field
              name="guardrail-message"
              label={t('s2.guardrails.message')}
              maxLength={500}
              value={draft.message}
              onChange={(event) => {
                set('message', event.target.value);
              }}
            />

            <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <legend className="px-1 text-sm font-medium">{t('s2.guardrails.testTitle')}</legend>
              <p className="text-xs text-muted">{t('s2.guardrails.testHelp')}</p>
              <label htmlFor="guardrail-sample" className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('s2.guardrails.sample')}</span>
                <textarea
                  id="guardrail-sample"
                  className={textareaClass}
                  aria-invalid={sampleError ? true : undefined}
                  value={sample}
                  onChange={(event) => {
                    setSample(event.target.value);
                    preview.reset();
                  }}
                />
                {sampleError ? <span className="text-xs text-danger">{sampleError}</span> : null}
              </label>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={preview.isPending || sample === '' || sample.length > MAX_SAMPLE}
                  onClick={() => {
                    const config = build();
                    if (config) preview.mutate(config);
                  }}
                >
                  {t('s2.guardrails.test')}
                </Button>
              </div>
              {result ? (
                <div data-testid="guardrail-preview" className="flex flex-col gap-1 text-sm">
                  <p className={result.blocked ? 'font-medium text-danger' : 'font-medium'}>
                    {result.blocked
                      ? t('s2.guardrails.result.blocked')
                      : t('s2.guardrails.result.passed')}
                  </p>
                  {result.matches ? (
                    <p className="text-muted">
                      {t('s2.guardrails.result.matches', { n: n(result.matches.length) })}
                      {result.matches.length > 0 ? (
                        <span dir="ltr"> — {result.matches.slice(0, 5).join(' · ')}</span>
                      ) : null}
                    </p>
                  ) : null}
                  {result.estimatedTokens !== undefined ? (
                    <p className="text-muted">
                      {t('s2.guardrails.result.tokens', { n: n(result.estimatedTokens) })}
                    </p>
                  ) : null}
                  {redactedText !== undefined && redactedText !== sample ? (
                    <div>
                      <p className="text-muted">{t('s2.guardrails.result.redacted')}</p>
                      <pre className="mt-1 whitespace-pre-wrap rounded bg-border/40 p-2 text-xs">
                        {redactedText}
                      </pre>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </fieldset>

            <div>
              <Button type="submit" disabled={create.isPending || !draft.name.trim()}>
                {t('s2.guardrails.create')}
              </Button>
            </div>
          </form>
        </Section>
      ) : null}
    </section>
  );
}
