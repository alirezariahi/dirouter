/**
 * Virtual key management (card 7.5). Full secrets returned by create/rotate live only in
 * the mounted SecretDialog: they are never cached, persisted, or copied into the list.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  KeysControllerCreateBody,
  KeysControllerList200Item as VirtualKey,
  KeysControllerUpdateBody,
  OrgsControllerProjects200Item as Project,
} from '../api/generated';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, FormError } from '../components/ui/field';
import { Empty, ErrorState, Loading } from '../components/ui/states';
import { api } from '../lib/api';
import { formatDate, formatNumber } from '../lib/date';
import { errorMessage, fieldError } from '../lib/errors';
import { text, type SubmitEvent } from '../lib/form';
import { rangeBounds, useRange } from '../lib/range';
import { currentOrg, useSession } from '../lib/session';
import { useSettings } from '../settings';

type Period = 'daily' | 'monthly';
type KeyBody = KeysControllerCreateBody | KeysControllerUpdateBody;
interface TopUsage {
  items: { id: string; requests: number; errors: number; tokens: number; costUsd: string }[];
}

const list = (value: string) => [
  ...new Set(
    value
      .split(/[\n,]/)
      .map((part) => part.trim())
      .filter(Boolean),
  ),
];
const optionalInteger = (value: string) => (value.trim() ? Number(value) : null);
const dateInput = (value: string | null) => {
  if (!value) return '';
  const date = new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
};

function TextListField({
  label,
  name,
  defaultValue,
  placeholder,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder: string;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <textarea
        id={id}
        name={name}
        rows={2}
        defaultValue={defaultValue}
        placeholder={placeholder}
        dir="ltr"
        className="rounded-md border border-border bg-surface px-3 py-2 outline-none focus:border-brand"
      />
    </label>
  );
}

function KeyFields({ initial, error }: { initial?: VirtualKey; error?: unknown }) {
  const { t } = useTranslation();
  const budget = (period: Period) => initial?.budgets.find((b) => b.period === period);
  return (
    <>
      <Field
        label={t('keys.name')}
        name="name"
        required
        maxLength={100}
        defaultValue={initial?.name}
        autoFocus
        error={fieldError(error, 'name')}
      />
      <TextListField
        label={t('keys.allowedModels')}
        name="allowedModels"
        defaultValue={initial?.allowedModels.join(', ')}
        placeholder="gpt-4.1, claude-sonnet-4"
      />
      <p className="-mt-2 text-xs text-muted">{t('keys.listHint')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {(['rpm', 'tpm', 'maxConcurrency'] as const).map((name) => (
          <Field
            key={name}
            label={t(`keys.${name}`)}
            name={name}
            type="number"
            min={1}
            step={1}
            defaultValue={initial?.[name] ?? ''}
            dir="ltr"
          />
        ))}
      </div>
      <Field
        label={t('keys.expiry')}
        name="expiresAt"
        type="datetime-local"
        defaultValue={dateInput(initial?.expiresAt ?? null)}
        dir="ltr"
      />
      <TextListField
        label={t('keys.ipAllowlist')}
        name="ipAllowlist"
        defaultValue={initial?.ipAllowlist.join(', ')}
        placeholder="192.0.2.10, 2001:db8::/32"
      />
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t('keys.budgets')}</legend>
        <div className="flex flex-col gap-3">
          {(['daily', 'monthly'] as const).map((period) => (
            <div key={period} className="rounded-md border border-border p-3">
              <p className="mb-2 text-sm font-medium">{t(`keys.period.${period}`)}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label={t('keys.budgetUsd')}
                  name={`${period}Usd`}
                  type="number"
                  min="0.00000001"
                  step="any"
                  defaultValue={budget(period)?.limitUsd ?? ''}
                  dir="ltr"
                />
                <Field
                  label={t('keys.budgetTokens')}
                  name={`${period}Tokens`}
                  type="number"
                  min={1}
                  step={1}
                  defaultValue={budget(period)?.limitTokens ?? ''}
                  dir="ltr"
                />
              </div>
            </div>
          ))}
        </div>
      </fieldset>
    </>
  );
}

function bodyFrom(form: FormData): KeyBody {
  const budgets: NonNullable<KeysControllerCreateBody['budgets']> = [];
  for (const period of ['daily', 'monthly'] as const) {
    const limitUsd = text(form, `${period}Usd`).trim();
    const tokens = text(form, `${period}Tokens`).trim();
    if (limitUsd || tokens)
      budgets.push({
        period,
        ...(limitUsd ? { limitUsd } : {}),
        ...(tokens ? { limitTokens: Number(tokens) } : {}),
      });
  }
  const expiresAt = text(form, 'expiresAt');
  return {
    name: text(form, 'name').trim(),
    allowedModels: list(text(form, 'allowedModels')),
    ipAllowlist: list(text(form, 'ipAllowlist')),
    rpm: optionalInteger(text(form, 'rpm')),
    tpm: optionalInteger(text(form, 'tpm')),
    maxConcurrency: optionalInteger(text(form, 'maxConcurrency')),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    budgets,
  };
}

function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLElement>('input, button, select, textarea')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const items = panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
      );
      if (!items?.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <button
        type="button"
        className="absolute inset-0"
        aria-label={t('keys.close')}
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative max-h-[90vh] w-full overflow-y-auto rounded-lg border border-border bg-surface p-5 shadow-xl ${wide ? 'max-w-2xl' : 'max-w-md'}`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <Button
            variant="ghost"
            className="size-8 px-0"
            aria-label={t('keys.close')}
            onClick={onClose}
          >
            ×
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Do not put this response in React Query's cache or any persistent store. */
function SecretDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  return (
    <Dialog title={t('keys.secretTitle')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-sm">{t('keys.secretWarning')}</p>
        <code
          data-testid="one-time-secret"
          dir="ltr"
          className="break-all rounded-md bg-surface-2 p-3 text-sm select-all"
        >
          {secret}
        </code>
        {copyError ? <p role="alert">{t('keys.copyError')}</p> : null}
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard
              .writeText(secret)
              .then(() => {
                setCopied(true);
              })
              .catch(() => {
                setCopyError(true);
              });
          }}
        >
          {copied ? t('keys.copied') : t('keys.copy')}
        </Button>
        <Button onClick={onClose}>{t('keys.done')}</Button>
      </div>
    </Dialog>
  );
}

export default function KeysPage() {
  const { t } = useTranslation();
  const settings = useSettings();
  useSession();
  const org = currentOrg();
  const orgId = org?.id ?? '';
  const canWrite = Boolean(org && org.role !== 'VIEWER');
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [dialog, setDialog] = useState<'create' | 'edit' | 'rotate' | 'revoke' | 'secret'>();
  const [selected, setSelected] = useState<VirtualKey>();
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [createPending, setCreatePending] = useState(false);
  const [rotatePending, setRotatePending] = useState(false);
  const range = useRange();
  const bounds = rangeBounds(range);

  const projects = useQuery({
    queryKey: ['projects', orgId],
    queryFn: () => api<Project[]>(`/orgs/${orgId}/projects`),
    enabled: Boolean(orgId),
  });
  const keys = useQuery({
    queryKey: ['keys', orgId],
    queryFn: () => api<VirtualKey[]>(`/orgs/${orgId}/keys`),
    enabled: Boolean(orgId),
  });
  const usage = useQuery({
    queryKey: ['key-usage', orgId, bounds.from, bounds.to],
    queryFn: () =>
      api<TopUsage>(
        `/orgs/${orgId}/stats/top?${new URLSearchParams({ from: bounds.from, to: bounds.to, by: 'key', metric: 'cost', limit: '100' })}`,
      ),
    enabled: Boolean(orgId),
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['keys', orgId] }),
      queryClient.invalidateQueries({ queryKey: ['key-usage', orgId] }),
    ]);
  };
  const invalidate = { onSuccess: () => void refresh() };
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: KeysControllerUpdateBody }) =>
      api<VirtualKey>(`/orgs/${orgId}/keys/${id}`, { method: 'PATCH', body }),
    ...invalidate,
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api<VirtualKey>(`/orgs/${orgId}/keys/${id}/revoke`, { method: 'POST' }),
    ...invalidate,
  });

  const close = useCallback(() => {
    // Clearing state unmounts SecretDialog; no full secret survives its close or page unmount.
    setDialog(undefined);
    setSelected(undefined);
    setSecret('');
    setError(undefined);
  }, []);
  const open = (next: typeof dialog, key?: VirtualKey) => {
    setDialog(next);
    setSelected(key);
    setError(undefined);
    setNotice('');
  };
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const body = bodyFrom(new FormData(event.currentTarget));
    setError(undefined);
    try {
      if (dialog === 'create') {
        const projectId = text(new FormData(event.currentTarget), 'projectId');
        setCreatePending(true);
        try {
          const created = await api<VirtualKey & { key: string }>(`/orgs/${orgId}/keys`, {
            method: 'POST',
            body: { ...body, projectId },
          });
          setSecret(created.key);
          setDialog('secret');
          await refresh();
        } finally {
          setCreatePending(false);
        }
      } else if (dialog === 'edit' && selected) {
        await update.mutateAsync({ id: selected.id, body });
        close();
      }
    } catch (err) {
      setError(err);
    }
  };
  const doRotate = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!selected) return;
    setError(undefined);
    try {
      const hours = Number(text(new FormData(event.currentTarget), 'graceHours'));
      setRotatePending(true);
      try {
        const rotated = await api<VirtualKey & { key: string }>(
          `/orgs/${orgId}/keys/${selected.id}/rotate`,
          {
            method: 'POST',
            body: { graceSeconds: hours * 3600 },
          },
        );
        setSecret(rotated.key);
        setDialog('secret');
        await refresh();
      } finally {
        setRotatePending(false);
      }
    } catch (err) {
      setError(err);
    }
  };
  const doRevoke = async () => {
    if (!selected) return;
    setError(undefined);
    try {
      await revoke.mutateAsync(selected.id);
      close();
      setNotice(t('keys.revokedNotice'));
    } catch (err) {
      setError(err);
    }
  };

  if (keys.isError) return <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />;
  if (!keys.data) return <Loading />;

  const usageById = new Map(usage.data?.items.map((item) => [item.id, item]));
  const rows = keys.data.filter((key) => {
    const term = search.trim().toLocaleLowerCase();
    return (
      (!term || `${key.name} ${key.prefix} ${key.id}`.toLocaleLowerCase().includes(term)) &&
      (!projectFilter || key.projectId === projectFilter) &&
      (!stateFilter || key.state === stateFilter)
    );
  });
  const n = (value: number) => formatNumber(value, settings.lang);
  const date = (value: string | null) =>
    value
      ? formatDate(value, { calendar: settings.calendar, lang: settings.lang, time: true })
      : t('keys.never');
  const projectName = (id: string) =>
    projects.data?.find((project) => project.id === id)?.name ?? id;
  const errorText = error ? errorMessage(error, t) : undefined;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t('keys.title')}</h1>
        {canWrite ? (
          <Button
            onClick={() => {
              open('create');
            }}
          >
            {t('keys.create')}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="key-search">
          {t('keys.search')}
        </label>
        <input
          id="key-search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          placeholder={t('keys.search')}
          className="h-9 min-w-56 rounded-md border border-border bg-surface px-3 text-sm"
        />
        <label className="sr-only" htmlFor="key-project">
          {t('keys.project')}
        </label>
        <select
          id="key-project"
          value={projectFilter}
          onChange={(event) => {
            setProjectFilter(event.target.value);
          }}
          className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
        >
          <option value="">{t('keys.allProjects')}</option>
          {projects.data?.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="key-state">
          {t('keys.stateLabel')}
        </label>
        <select
          id="key-state"
          value={stateFilter}
          onChange={(event) => {
            setStateFilter(event.target.value);
          }}
          className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
        >
          <option value="">{t('keys.allStates')}</option>
          {(['active', 'rotating', 'expired', 'revoked'] as const).map((state) => (
            <option key={state} value={state}>
              {t(`keys.state.${state}`)}
            </option>
          ))}
        </select>
      </div>
      {notice ? (
        <p role="status" className="text-sm text-emerald-600">
          {notice}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <Empty title={t('keys.empty')} />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="text-muted">
              <tr className="border-b border-border">
                {(
                  ['name', 'project', 'status', 'limits', 'usage', 'lastUsed', 'actions'] as const
                ).map((column) => (
                  <th key={column} className="px-3 py-2 text-start font-medium">
                    {t(`keys.col.${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((key) => {
                const stats = usageById.get(key.id);
                return (
                  <tr
                    key={key.id}
                    className="border-b border-border/60 align-top"
                    data-testid="key-row"
                  >
                    <td className="px-3 py-3">
                      <p className="font-medium">{key.name}</p>
                      <code dir="ltr" className="text-xs text-muted">
                        {key.prefix}…
                      </code>
                      <p
                        className="mt-1 max-w-48 truncate text-xs text-muted"
                        dir="ltr"
                        title={key.allowedModels.join(', ')}
                      >
                        {key.allowedModels.length
                          ? key.allowedModels.join(', ')
                          : t('keys.allModels')}
                      </p>
                    </td>
                    <td className="px-3 py-3">{projectName(key.projectId)}</td>
                    <td className="px-3 py-3">
                      <span className={key.state === 'active' ? 'text-emerald-600' : 'text-muted'}>
                        {t(`keys.state.${key.state}`)}
                      </span>
                      {key.expiresAt ? (
                        <p className="mt-1 text-xs text-muted">
                          {t('keys.expires')}: {date(key.expiresAt)}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-xs" dir="ltr">
                      <p>
                        {key.rpm === null ? '—' : n(key.rpm)} RPM ·{' '}
                        {key.tpm === null ? '—' : n(key.tpm)} TPM
                      </p>
                      {key.budgets.map((budget) => (
                        <p key={budget.id}>
                          {t(`keys.period.${budget.period}`)}:{' '}
                          {budget.limitUsd ? `$${budget.limitUsd}` : '—'} /{' '}
                          {budget.limitTokens === null ? '—' : n(budget.limitTokens)}
                        </p>
                      ))}
                      {key.ipAllowlist.length ? (
                        <p className="max-w-44 truncate" title={key.ipAllowlist.join(', ')}>
                          {key.ipAllowlist.join(', ')}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3" dir="ltr">
                      {stats ? (
                        <>
                          <p>${Number(stats.costUsd).toFixed(4)}</p>
                          <p className="text-xs text-muted">
                            {n(stats.requests)} {t('keys.requests')} · {n(stats.tokens)}{' '}
                            {t('keys.tokens')}
                          </p>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs">{date(key.lastUsedAt)}</td>
                    <td className="px-3 py-3">
                      {canWrite ? (
                        <div className="flex flex-wrap gap-1">
                          <Button
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => {
                              open('edit', key);
                            }}
                          >
                            {t('keys.edit')}
                          </Button>
                          {key.state === 'active' ? (
                            <Button
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              onClick={() => {
                                open('rotate', key);
                              }}
                            >
                              {t('keys.rotate')}
                            </Button>
                          ) : null}
                          {key.state !== 'revoked' ? (
                            <Button
                              variant="ghost"
                              className="h-7 px-2 text-xs text-danger"
                              onClick={() => {
                                open('revoke', key);
                              }}
                            >
                              {t('keys.revoke')}
                            </Button>
                          ) : null}
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {dialog === 'create' || (dialog === 'edit' && selected) ? (
        <Dialog
          title={t(dialog === 'create' ? 'keys.createTitle' : 'keys.editTitle')}
          onClose={close}
          wide
        >
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
            <FormError message={errorText} />
            {dialog === 'create' ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('keys.project')}</span>
                <select
                  name="projectId"
                  required
                  className="h-10 rounded-md border border-border bg-surface px-2"
                >
                  <option value="">{t('keys.selectProject')}</option>
                  {projects.data?.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                {fieldError(error, 'projectId') ? (
                  <span className="text-xs text-danger">{fieldError(error, 'projectId')}</span>
                ) : null}
              </label>
            ) : null}
            <KeyFields initial={selected} error={error} />
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={createPending || update.isPending || projects.isPending}
              >
                {t('keys.save')}
              </Button>
              <Button variant="ghost" onClick={close}>
                {t('keys.cancel')}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {dialog === 'rotate' && selected ? (
        <Dialog title={t('keys.rotateTitle', { name: selected.name })} onClose={close}>
          <form onSubmit={(event) => void doRotate(event)} className="flex flex-col gap-3">
            <FormError message={errorText} />
            <p className="text-sm">{t('keys.rotateWarning')}</p>
            <Field
              label={t('keys.graceHours')}
              name="graceHours"
              type="number"
              min={0}
              max={720}
              step={1}
              required
              defaultValue={24}
              dir="ltr"
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={rotatePending}>
                {t('keys.rotate')}
              </Button>
              <Button variant="ghost" onClick={close}>
                {t('keys.cancel')}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {dialog === 'revoke' && selected ? (
        <Dialog title={t('keys.revokeTitle', { name: selected.name })} onClose={close}>
          <div className="flex flex-col gap-3">
            <FormError message={errorText} />
            <p className="text-sm">{t('keys.revokeWarning')}</p>
            <div className="flex gap-2">
              <Button
                className="bg-danger text-white"
                disabled={revoke.isPending}
                onClick={() => void doRevoke()}
              >
                {t('keys.confirmRevoke')}
              </Button>
              <Button variant="ghost" onClick={close}>
                {t('keys.cancel')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {dialog === 'secret' && secret ? <SecretDialog secret={secret} onClose={close} /> : null}
    </section>
  );
}
