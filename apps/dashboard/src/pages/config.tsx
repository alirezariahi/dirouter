/**
 * Gateway settings and config versions (card 17.1): edit the gateway-wide settings JSON, browse
 * versions with a diff against the previous one, roll back, and export/import the configuration.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PageHeader, Section, textareaClass } from '../components/s2/common';
import { Button } from '../components/ui/button';
import { FormError } from '../components/ui/field';
import { Loading } from '../components/ui/states';
import { api, ApiError } from '../lib/api';
import { listOf, useFormat } from '../lib/s2-format';
import { formatDate } from '../lib/date';
import { errorMessage } from '../lib/errors';
import { can, currentOrg, useSession } from '../lib/session';
import { parseObject } from '../lib/s2-helpers';

interface SettingsView {
  stored: Record<string, unknown>;
  effective: Record<string, unknown>;
}
interface Version {
  version: number;
  checksum: string;
  reason: string;
  createdAt: string;
}
interface Diff {
  from: number;
  to: number;
  changes: { path: string; before?: unknown; after?: unknown }[];
}

const short = (value: unknown) => {
  const text = value === undefined ? '—' : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
};

export default function ConfigPage() {
  const { t } = useTranslation();
  const { n, settings: display } = useFormat();
  const qc = useQueryClient();
  const user = useSession();
  const org = currentOrg();
  const membership = user?.organizations.find((o) => o.id === org?.id);
  // Rollback and import need `config:write` (effective permission, see `can`); the gateway-wide
  // settings are instance-wide and can only be changed by an OWNER.
  const canWrite = can(membership, 'config:write');
  const canEditSettings = membership?.role === 'OWNER';
  const base = `/orgs/${org?.id ?? ''}/config`;
  const enabled = Boolean(org);
  // Until the user types, the editor shows what is stored.
  const [draft, setDraft] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const [openVersion, setOpenVersion] = useState<number>();
  const [armed, setArmed] = useState<number>();
  const [importText, setImportText] = useState('');

  const current = useQuery({
    queryKey: ['gateway-settings', org?.id],
    queryFn: () => api<SettingsView>(`${base}/settings`),
    enabled,
  });
  const versions = useQuery({
    queryKey: ['config-versions', org?.id],
    queryFn: () => api<unknown>(`${base}/versions`),
    enabled,
  });
  const diff = useQuery({
    queryKey: ['config-diff', org?.id, openVersion],
    queryFn: () => api<Diff>(`${base}/versions/${String(openVersion)}/diff`),
    enabled: enabled && openVersion !== undefined,
  });
  const text = draft ?? (current.data ? JSON.stringify(current.data.stored, null, 2) : '');
  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['gateway-settings', org?.id] });
    void qc.invalidateQueries({ queryKey: ['config-versions', org?.id] });
  };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ version: number }>(`${base}/settings`, { method: 'PUT', body }),
    onSuccess: (result) => {
      setNotice(t('s2.config.published', { version: n(result.version) }));
      refreshAll();
    },
  });
  const rollback = useMutation({
    mutationFn: (version: number) =>
      api<{ version: number }>(`${base}/versions/${String(version)}/rollback`, {
        method: 'POST',
        body: { reason: 'dashboard rollback' },
      }),
    onSuccess: (result) => {
      setNotice(t('s2.config.rolledBack', { version: n(result.version) }));
      setArmed(undefined);
      refreshAll();
    },
  });
  const importConfig = useMutation({
    mutationFn: () =>
      api<{ version: number }>(`${base}/import.yaml`, {
        method: 'POST',
        body: { yaml: importText, reason: 'dashboard import' },
      }),
    onSuccess: (result) => {
      setNotice(t('s2.config.published', { version: n(result.version) }));
      setImportText('');
      refreshAll();
    },
  });
  const download = async () => {
    setLocalError(undefined);
    try {
      const exported = await api<{ version: number; yaml: string }>(`${base}/export.yaml`);
      const url = URL.createObjectURL(new Blob([exported.yaml], { type: 'application/yaml' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `dirouter-config-v${String(exported.version)}.yaml`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setLocalError(errorMessage(error, t));
    }
  };

  const failure =
    save.error ?? rollback.error ?? importConfig.error ?? current.error ?? versions.error;
  // Publishing can be refused for non-owners (several organizations on the instance, or a change
  // of the gateway-wide settings); say that instead of a generic "forbidden".
  const describe = (error: unknown) =>
    error instanceof ApiError && error.status === 403 && error.code === 'forbidden'
      ? t('s2.config.ownerRequired')
      : errorMessage(error, t);
  const rows = listOf<Version>(versions.data);
  const date = (iso: string) =>
    formatDate(iso, { calendar: display.calendar, lang: display.lang, time: true });

  return (
    <section className="enter flex flex-col gap-6">
      <PageHeader title={t('s2.config.title')} subtitle={t('s2.config.subtitle')} />
      <FormError message={localError ?? (failure ? describe(failure) : undefined)} />
      {notice ? (
        <p role="status" className="text-sm text-muted">
          {notice}
        </p>
      ) : null}

      <Section title={t('s2.config.settings')} help={t('s2.config.settingsHelp')}>
        {current.isPending ? (
          <Loading />
        ) : (
          <>
            <textarea
              aria-label={t('s2.config.settings')}
              dir="ltr"
              spellCheck={false}
              readOnly={!canEditSettings}
              className={`${textareaClass} min-h-48 font-mono`}
              value={text}
              onChange={(event) => {
                setDraft(event.target.value);
                setNotice(undefined);
              }}
            />
            {canEditSettings ? null : (
              <p data-testid="settings-owner-only" className="text-xs text-muted">
                {t('s2.config.settingsOwnerOnly')}
              </p>
            )}
            {canEditSettings ? (
              <div>
                <Button
                  disabled={save.isPending}
                  onClick={() => {
                    const body = parseObject(text);
                    if (!body) {
                      setLocalError(t('s2.config.invalidJson'));
                      return;
                    }
                    setLocalError(undefined);
                    save.mutate(body);
                  }}
                >
                  {t('s2.common.save')}
                </Button>
              </div>
            ) : null}
            <details>
              <summary className="cursor-pointer text-sm">{t('s2.config.effective')}</summary>
              <pre
                dir="ltr"
                className="mt-2 max-h-80 overflow-auto rounded bg-border/30 p-3 text-xs"
              >
                {JSON.stringify(current.data?.effective ?? {}, null, 2)}
              </pre>
            </details>
          </>
        )}
      </Section>

      <Section
        title={t('s2.config.versions')}
        action={
          <Button variant="outline" onClick={() => void download()}>
            {t('s2.config.export')}
          </Button>
        }
      >
        {versions.isPending ? (
          <Loading />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">{t('s2.common.none')}</p>
        ) : (
          <ul data-testid="config-versions" className="flex flex-col">
            {rows.map((row) => (
              <li key={row.version} className="border-t border-border py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    className="text-start"
                    aria-expanded={openVersion === row.version}
                    onClick={() => {
                      setOpenVersion((value) => (value === row.version ? undefined : row.version));
                    }}
                  >
                    <span className="font-medium">
                      {t('s2.config.version')} {n(row.version)}
                    </span>{' '}
                    <span className="text-xs text-muted">
                      {date(row.createdAt)} · {row.reason}
                    </span>
                  </button>
                  {canWrite ? (
                    armed === row.version ? (
                      <span className="flex items-center gap-2">
                        <span className="text-xs">
                          {t('s2.config.rollbackConfirm', { version: n(row.version) })}
                        </span>
                        <Button
                          className="h-7 px-2 text-xs"
                          disabled={rollback.isPending}
                          onClick={() => {
                            rollback.mutate(row.version);
                          }}
                        >
                          {t('s2.config.rollback')}
                        </Button>
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          setArmed(row.version);
                        }}
                      >
                        {t('s2.config.rollback')}
                      </Button>
                    )
                  ) : null}
                </div>
                {openVersion === row.version ? (
                  <div className="mt-2">
                    <p className="text-xs font-medium">{t('s2.config.diff')}</p>
                    {diff.isPending ? (
                      <Loading />
                    ) : !diff.data || diff.data.changes.length === 0 ? (
                      <p className="text-xs text-muted">{t('s2.config.noDiff')}</p>
                    ) : (
                      <ul dir="ltr" className="mt-1 flex flex-col gap-1 text-xs">
                        {diff.data.changes.slice(0, 100).map((change) => (
                          <li
                            key={change.path}
                            className="rounded bg-border/30 px-2 py-1 font-mono"
                          >
                            <span className="font-semibold">{change.path}</span>
                            <br />
                            <span className="text-danger">- {short(change.before)}</span>
                            <br />
                            <span className="text-good">+ {short(change.after)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">{t('s2.config.scopeHelp')}</p>
        {canWrite ? <p className="text-xs text-muted">{t('s2.config.rollbackWarn')}</p> : null}
        {canWrite && !canEditSettings ? (
          <p className="text-xs text-muted">{t('s2.config.ownerHint')}</p>
        ) : null}
      </Section>

      {canWrite ? (
        <Section title={t('s2.config.import')} help={t('s2.config.importHelp')}>
          <textarea
            aria-label={t('s2.config.import')}
            dir="ltr"
            spellCheck={false}
            className={`${textareaClass} min-h-32 font-mono`}
            value={importText}
            onChange={(event) => {
              setImportText(event.target.value);
            }}
          />
          <div>
            <Button
              disabled={importConfig.isPending || importText.trim().length < 2}
              onClick={() => {
                importConfig.mutate();
              }}
            >
              {t('s2.config.importRun')}
            </Button>
          </div>
        </Section>
      ) : null}
    </section>
  );
}
