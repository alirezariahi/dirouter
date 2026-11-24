/**
 * Organization security (cards 14.1 to 14.5): sign-in policy (mandatory MFA per role, SSO-only),
 * OIDC connections, custom roles, the append-only audit log with CSV export, and MASTER_KEY rotation.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ChangeRequests } from '../components/change-requests';
import { ScimTokens } from '../components/scim-tokens';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, FormError } from '../components/ui/field';
import { ErrorState, Loading } from '../components/ui/states';
import { api } from '../lib/api';
import type { SubmitEvent } from '../lib/form';
import { formatDate, formatNumber } from '../lib/date';
import { errorMessage, fieldError } from '../lib/errors';
import { can, currentOrg, useSession } from '../lib/session';
import { useSettings } from '../settings';

const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
type Role = (typeof ROLES)[number];
/** OWNER can never be granted through SSO (default role or group mapping); the server rejects it. */
const SSO_ROLES = ROLES.filter((role) => role !== 'OWNER');
const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
/** Splits the comma/space separated domain list of the SSO form. */
const parseDomains = (text: string) =>
  text
    .split(/[\s,،]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
/** Mirrors PERMISSIONS in control-api (rbac/permissions.ts); the server validates the final list. */
const PERMISSIONS = [
  'org:read',
  'org:write',
  'members:read',
  'members:write',
  'invites:write',
  'teams:read',
  'teams:write',
  'projects:read',
  'projects:write',
  'providers:read',
  'providers:write',
  'keys:read',
  'keys:write',
  'models:read',
  'models:write',
  'usage:read',
  'audit:read',
  'guardrails:read',
  'guardrails:write',
  'alerts:read',
  'alerts:write',
  'config:read',
  'config:write',
  'security:write',
  'health:write',
  'billing:read',
  'billing:write',
  'mcp:read',
  'mcp:write',
] as const;

interface Policy {
  mfaRequiredRoles: Role[];
  passwordLoginDisabled: boolean;
  ssoEnabled: boolean;
  changeApprovalRequired?: boolean;
}
interface SsoConnection {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  enabled: boolean;
  defaultRole?: Role;
  allowedDomains?: string[];
  protocol?: 'oidc' | 'saml';
  acsUrl?: string;
  metadataUrl?: string;
}
interface CustomRole {
  id: string;
  name: string;
  permissions: string[];
}
interface AuditItem {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  diff: unknown;
  ip: string | null;
  createdAt: string;
}
interface AuditPage {
  items: AuditItem[];
  nextCursor: string | null;
}
interface RotateResult {
  keyVersion: number;
  rotated: number;
  credentials: number;
  ssoConnections: number;
  mfaSecrets: number;
}

const list = <T,>(value: unknown): T[] =>
  Array.isArray(value)
    ? (value as T[])
    : Array.isArray((value as { items?: unknown } | undefined)?.items)
      ? (value as { items: T[] }).items
      : [];

function Section({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {help ? <p className="mt-1 text-xs text-muted">{help}</p> : null}
      </div>
      {children}
    </Card>
  );
}

function PolicySection({ base, canWrite }: { base: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string>();
  const query = useQuery({
    queryKey: ['security', base],
    queryFn: () => api<Policy>(`${base}/security`),
  });
  const save = useMutation({
    mutationFn: (
      patch: Partial<
        Pick<Policy, 'mfaRequiredRoles' | 'passwordLoginDisabled' | 'changeApprovalRequired'>
      >,
    ) => api<Policy>(`${base}/security`, { method: 'PATCH', body: patch }),
    onSuccess: () => {
      setNotice(t('s2.security.saved'));
      void qc.invalidateQueries({ queryKey: ['security', base] });
    },
    onError: () => {
      setNotice(undefined);
    },
  });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const policy = query.data;
  const toggleRole = (role: Role) => {
    const next = policy.mfaRequiredRoles.includes(role)
      ? policy.mfaRequiredRoles.filter((r) => r !== role)
      : [...policy.mfaRequiredRoles, role];
    save.mutate({ mfaRequiredRoles: next });
  };
  return (
    <Section title={t('s2.security.policy.title')}>
      <FormError message={save.isError ? errorMessage(save.error, t) : undefined} />
      <fieldset disabled={!canWrite || save.isPending} className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('s2.security.policy.mfaRoles')}</legend>
        <div className="flex flex-wrap gap-4">
          {ROLES.map((role) => (
            <label key={role} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={policy.mfaRequiredRoles.includes(role)}
                onChange={() => {
                  toggleRole(role);
                }}
              />
              <span>{t(`organization.roles.${role}`)}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">{t('s2.security.policy.mfaHelp')}</p>
      </fieldset>
      <fieldset disabled={!canWrite || save.isPending} className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={policy.passwordLoginDisabled}
            onChange={(event) => {
              save.mutate({ passwordLoginDisabled: event.target.checked });
            }}
          />
          {t('s2.security.policy.passwordDisabled')}
        </label>
        <p className="text-xs text-muted">
          {t('s2.security.policy.passwordHelp')}{' '}
          {policy.ssoEnabled ? t('s2.security.policy.ssoOn') : t('s2.security.policy.ssoOff')}
        </p>
      </fieldset>
      <fieldset disabled={!canWrite || save.isPending} className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={policy.changeApprovalRequired === true}
            onChange={(event) => {
              save.mutate({ changeApprovalRequired: event.target.checked });
            }}
          />
          {t('s3.changes.require')}
        </label>
        <p className="text-xs text-muted">{t('s3.changes.requireHelp')}</p>
      </fieldset>
      {notice ? <p className="text-xs text-muted">{notice}</p> : null}
      {canWrite ? null : <p className="text-xs text-muted">{t('s2.security.readOnly')}</p>}
    </Section>
  );
}

/**
 * Listing needs `security:write`; creating, changing and removing a connection is OWNER-only on
 * the server, so everybody else gets the same section read-only with an explanation.
 */
function SsoSection({ base, canManage }: { base: string; canManage: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [domainError, setDomainError] = useState<string>();
  const empty = {
    protocol: 'oidc' as 'oidc' | 'saml',
    name: '',
    issuer: '',
    clientId: '',
    clientSecret: '',
    samlSsoUrl: '',
    samlCert: '',
    defaultRole: 'MEMBER' as Role,
    domains: '',
  };
  const [draft, setDraft] = useState(empty);
  const query = useQuery({ queryKey: ['sso', base], queryFn: () => api<unknown>(`${base}/sso`) });
  const done = () => qc.invalidateQueries({ queryKey: ['sso', base] });
  const create = useMutation({
    mutationFn: () =>
      api<unknown>(`${base}/sso`, {
        method: 'POST',
        body: {
          name: draft.name.trim(),
          protocol: draft.protocol,
          issuer: draft.issuer.trim(),
          clientId: draft.clientId.trim(),
          ...(draft.protocol === 'saml'
            ? { samlSsoUrl: draft.samlSsoUrl.trim(), samlCert: draft.samlCert.trim() }
            : { clientSecret: draft.clientSecret }),
          defaultRole: draft.defaultRole,
          allowedDomains: parseDomains(draft.domains),
        },
      }),
    onSuccess: () => {
      setDraft(empty);
      void done();
      void qc.invalidateQueries({ queryKey: ['security', base] });
    },
  });
  const patch = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api<unknown>(`${base}/sso/${input.id}`, {
        method: 'PATCH',
        body: { enabled: input.enabled },
      }),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<unknown>(`${base}/sso/${id}`, { method: 'DELETE' }),
    onSuccess: done,
  });
  const rows = list<SsoConnection>(query.data);
  const failure = create.error ?? patch.error ?? remove.error ?? query.error;
  const set = (key: keyof typeof empty) => (event: { target: { value: string } }) => {
    setDraft((d) => ({ ...d, [key]: event.target.value }));
  };
  return (
    <Section title={t('s2.security.sso.title')} help={t('s2.security.sso.secretPolicy')}>
      <FormError message={failure ? errorMessage(failure, t) : undefined} />
      {canManage ? null : (
        <p data-testid="sso-owner-only" className="text-xs text-muted">
          {t('s2.security.sso.ownerOnly')}
        </p>
      )}
      {query.isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">{t('s2.security.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2 text-sm"
            >
              <div>
                <p className="font-medium">{row.name}</p>
                <p dir="ltr" className="text-xs text-muted">
                  {row.protocol === 'saml' ? 'SAML · ' : ''}
                  {row.issuer}
                </p>
                {row.acsUrl ? (
                  <p dir="ltr" className="text-xs text-muted">
                    ACS: {row.acsUrl} ·{' '}
                    <a className="underline" href={row.metadataUrl}>
                      {t('s3.saml.metadata')}
                    </a>
                  </p>
                ) : null}
                {row.allowedDomains?.length ? (
                  <p dir="ltr" className="text-xs text-muted">
                    {row.allowedDomains.join(', ')}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">
                  {row.enabled ? t('s2.security.sso.enabled') : t('s2.security.sso.disabledLabel')}
                </span>
                <Button
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={!canManage || patch.isPending}
                  onClick={() => {
                    patch.mutate({ id: row.id, enabled: !row.enabled });
                  }}
                >
                  {row.enabled ? t('s2.security.sso.disable') : t('s2.security.sso.enable')}
                </Button>
                <Button
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={!canManage || remove.isPending}
                  onClick={() => {
                    remove.mutate(row.id);
                  }}
                >
                  {t('s2.security.delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(event: SubmitEvent) => {
          event.preventDefault();
          if (!canManage) return;
          const domains = parseDomains(draft.domains);
          // The server rejects a connection without domains: it would accept any email address.
          if (domains.length === 0) {
            setDomainError(t('s2.security.sso.domainsRequired'));
            return;
          }
          const invalid = domains.find((domain) => !DOMAIN.test(domain));
          if (invalid) {
            setDomainError(t('s2.security.sso.domainInvalid', { domain: invalid }));
            return;
          }
          setDomainError(undefined);
          create.mutate();
        }}
      >
        <fieldset disabled={!canManage} className="grid gap-3 md:grid-cols-2">
          <label htmlFor="sso-protocol" className="flex flex-col gap-1 text-sm md:col-span-2">
            <span className="font-medium">{t('s3.saml.protocol')}</span>
            <select
              id="sso-protocol"
              value={draft.protocol}
              onChange={set('protocol')}
              className="h-10 rounded-lg border border-border bg-surface px-3"
            >
              <option value="oidc">OpenID Connect</option>
              <option value="saml">SAML 2.0</option>
            </select>
          </label>
          <Field
            name="sso-name"
            label={t('s2.security.sso.name')}
            required
            value={draft.name}
            onChange={set('name')}
          />
          <Field
            name="sso-issuer"
            label={
              draft.protocol === 'saml' ? t('s3.saml.idpEntityId') : t('s2.security.sso.issuer')
            }
            type={draft.protocol === 'saml' ? 'text' : 'url'}
            dir="ltr"
            required
            value={draft.issuer}
            onChange={set('issuer')}
          />
          <Field
            name="sso-client-id"
            label={
              draft.protocol === 'saml' ? t('s3.saml.spEntityId') : t('s2.security.sso.clientId')
            }
            dir="ltr"
            required
            value={draft.clientId}
            onChange={set('clientId')}
          />
          {draft.protocol === 'saml' ? (
            <>
              <Field
                name="sso-saml-url"
                label={t('s3.saml.ssoUrl')}
                type="url"
                dir="ltr"
                required
                value={draft.samlSsoUrl}
                onChange={set('samlSsoUrl')}
              />
              <label htmlFor="sso-saml-cert" className="flex flex-col gap-1 text-sm md:col-span-2">
                <span className="font-medium">{t('s3.saml.cert')}</span>
                <textarea
                  id="sso-saml-cert"
                  dir="ltr"
                  required
                  rows={4}
                  value={draft.samlCert}
                  onChange={set('samlCert')}
                  className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs"
                />
              </label>
            </>
          ) : (
            <Field
              name="sso-client-secret"
              label={t('s2.security.sso.clientSecret')}
              type="password"
              dir="ltr"
              autoComplete="off"
              required
              value={draft.clientSecret}
              onChange={set('clientSecret')}
            />
          )}
          <Field
            name="sso-domains"
            label={t('s2.security.sso.domains')}
            dir="ltr"
            required
            placeholder="example.com, example.org"
            value={draft.domains}
            onChange={(event) => {
              setDomainError(undefined);
              set('domains')(event);
            }}
            error={domainError ?? fieldError(create.error, 'allowedDomains')}
          />
          <label htmlFor="sso-role" className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('s2.security.sso.defaultRole')}</span>
            <select
              id="sso-role"
              value={draft.defaultRole}
              onChange={set('defaultRole')}
              className="h-10 rounded-lg border border-border bg-surface px-3"
            >
              {SSO_ROLES.map((role) => (
                <option key={role} value={role}>
                  {t(`organization.roles.${role}`)}
                </option>
              ))}
            </select>
          </label>
          <div>
            <Button type="submit" disabled={create.isPending}>
              {t('s2.security.add')}
            </Button>
          </div>
        </fieldset>
      </form>
    </Section>
  );
}

function RolesSection({ base, canWrite }: { base: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const settings = useSettings();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const query = useQuery({
    queryKey: ['custom-roles', base],
    queryFn: () => api<unknown>(`${base}/custom-roles`),
  });
  const done = () => qc.invalidateQueries({ queryKey: ['custom-roles', base] });
  const create = useMutation({
    mutationFn: () =>
      api<unknown>(`${base}/custom-roles`, {
        method: 'POST',
        body: { name: name.trim(), permissions: selected },
      }),
    onSuccess: () => {
      setName('');
      setSelected([]);
      void done();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<unknown>(`${base}/custom-roles/${id}`, { method: 'DELETE' }),
    onSuccess: done,
  });
  const rows = list<CustomRole>(query.data);
  const failure = create.error ?? remove.error ?? query.error;
  return (
    <Section title={t('s2.security.roles.title')} help={t('s2.security.roles.help')}>
      <FormError message={failure ? errorMessage(failure, t) : undefined} />
      {query.isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">{t('s2.security.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded border border-border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{row.name}</span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {t('s2.security.roles.count', {
                    n: formatNumber(row.permissions.length, settings.lang),
                  })}
                  {canWrite ? (
                    <Button
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      disabled={remove.isPending}
                      onClick={() => {
                        remove.mutate(row.id);
                      }}
                    >
                      {t('s2.security.delete')}
                    </Button>
                  ) : null}
                </span>
              </div>
              <p dir="ltr" className="mt-1 text-xs text-muted">
                {row.permissions.join(', ')}
              </p>
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event: SubmitEvent) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <Field
            name="role-name"
            label={t('s2.security.roles.name')}
            required
            maxLength={60}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <fieldset>
            <legend className="mb-1 text-sm font-medium">
              {t('s2.security.roles.permissions')}
            </legend>
            <div dir="ltr" className="grid grid-cols-2 gap-1 text-xs md:grid-cols-4">
              {PERMISSIONS.map((permission) => (
                <label key={permission} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={selected.includes(permission)}
                    onChange={() => {
                      setSelected((current) =>
                        current.includes(permission)
                          ? current.filter((p) => p !== permission)
                          : [...current, permission],
                      );
                    }}
                  />
                  {permission}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {t('s2.security.add')}
            </Button>
          </div>
        </form>
      ) : null}
    </Section>
  );
}

function AuditSection({ base }: { base: string }) {
  const { t } = useTranslation();
  const settings = useSettings();
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');
  const [pages, setPages] = useState<AuditItem[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [exportError, setExportError] = useState<unknown>();
  const query = useQuery({
    queryKey: ['audit', base, applied, cursor ?? ''],
    queryFn: () =>
      api<AuditPage>(`${base}/audit`, {
        query: { limit: 50, action: applied || undefined, cursor },
      }),
  });
  const items = [...pages, ...(query.data?.items ?? [])];
  const download = async () => {
    setExportError(undefined);
    try {
      const csv = await api<string>(`${base}/audit/export`, {
        query: { action: applied || undefined },
      });
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'audit-log.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(error);
    }
  };
  return (
    <Section title={t('s2.security.audit.title')} help={t('s2.security.audit.help')}>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event: SubmitEvent) => {
          event.preventDefault();
          setPages([]);
          setCursor(undefined);
          setApplied(action.trim());
        }}
      >
        <Field
          name="audit-action"
          label={t('s2.security.audit.action')}
          dir="ltr"
          placeholder="provider."
          value={action}
          onChange={(event) => {
            setAction(event.target.value);
          }}
        />
        <Button type="submit" variant="outline">
          {t('s2.security.audit.filter')}
        </Button>
        <Button type="button" variant="outline" onClick={() => void download()}>
          {t('s2.security.audit.export')}
        </Button>
      </form>
      <FormError
        message={
          query.isError
            ? errorMessage(query.error, t)
            : exportError
              ? errorMessage(exportError, t)
              : undefined
        }
      />
      {query.isPending && items.length === 0 ? (
        <Loading />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">{t('s2.security.none')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table data-testid="audit-table" className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th className="py-1 text-start font-medium">{t('s2.security.audit.when')}</th>
                <th className="py-1 text-start font-medium">{t('s2.security.audit.what')}</th>
                <th className="py-1 text-start font-medium">{t('s2.security.audit.target')}</th>
                <th className="py-1 text-start font-medium">{t('s2.security.audit.actor')}</th>
                <th className="py-1 text-start font-medium">{t('s2.security.audit.ip')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-border align-top">
                  <td className="whitespace-nowrap py-1.5">
                    {formatDate(item.createdAt, {
                      calendar: settings.calendar,
                      lang: settings.lang,
                      time: true,
                      seconds: true,
                    })}
                  </td>
                  <td className="py-1.5" dir="ltr">
                    {item.diff ? (
                      <details>
                        <summary className="cursor-pointer">{item.action}</summary>
                        <pre className="mt-1 max-w-md overflow-x-auto whitespace-pre-wrap text-xs text-muted">
                          {JSON.stringify(item.diff, null, 2)}
                        </pre>
                      </details>
                    ) : (
                      item.action
                    )}
                  </td>
                  <td className="py-1.5" dir="ltr">
                    {item.targetType ? `${item.targetType}:${item.targetId ?? ''}` : '—'}
                  </td>
                  <td className="py-1.5" dir="ltr">
                    {item.actorUserId ?? '—'}
                  </td>
                  <td className="py-1.5" dir="ltr">
                    {item.ip ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {query.data?.nextCursor ? (
        <div>
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => {
              setPages(items);
              setCursor(query.data.nextCursor ?? undefined);
            }}
          >
            {t('s2.security.audit.more')}
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

function RotateSection({ base }: { base: string }) {
  const { t } = useTranslation();
  const settings = useSettings();
  const [armed, setArmed] = useState(false);
  const rotate = useMutation({
    mutationFn: () => api<RotateResult>(`${base}/security/rotate-key`, { method: 'POST' }),
    onSettled: () => {
      setArmed(false);
    },
  });
  const n = (value: number) => formatNumber(value, settings.lang);
  return (
    <Section title={t('s2.security.rotate.title')} help={t('s2.security.rotate.help')}>
      <FormError message={rotate.isError ? errorMessage(rotate.error, t) : undefined} />
      <div className="flex flex-wrap items-center gap-2">
        {armed ? (
          <>
            <span className="text-sm">{t('s2.security.rotate.confirm')}</span>
            <Button
              disabled={rotate.isPending}
              onClick={() => {
                rotate.mutate();
              }}
            >
              {t('s2.security.rotate.run')}
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            onClick={() => {
              setArmed(true);
            }}
          >
            {t('s2.security.rotate.run')}
          </Button>
        )}
      </div>
      {rotate.data ? (
        <p data-testid="rotate-result" className="text-sm text-muted">
          {t('s2.security.rotate.result', {
            version: n(rotate.data.keyVersion),
            rotated: n(rotate.data.rotated),
            credentials: n(rotate.data.credentials),
            sso: n(rotate.data.ssoConnections),
            mfa: n(rotate.data.mfaSecrets),
          })}
        </p>
      ) : null}
    </Section>
  );
}

export default function SecurityPage() {
  const { t } = useTranslation();
  const user = useSession();
  const org = currentOrg();
  const membership = user?.organizations.find((o) => o.id === org?.id);
  // Effective permission (base role plus custom role) when the session exposes it; see `can`.
  const canWrite = can(membership, 'security:write');
  const isOwner = membership?.role === 'OWNER';
  if (!org) return <Loading />;
  const base = `/orgs/${org.id}`;
  return (
    <section className="enter flex flex-col gap-6">
      <header>
        <h1 className="text-2xl leading-8 font-semibold">{t('s2.security.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('s2.security.subtitle')}</p>
      </header>
      <PolicySection base={base} canWrite={canWrite} />
      {canWrite ? <SsoSection base={base} canManage={isOwner} /> : null}
      {canWrite ? <ScimTokens base={base} canManage={isOwner} /> : null}
      <ChangeRequests base={base} />
      <RolesSection base={base} canWrite={canWrite} />
      <AuditSection base={base} />
      {canWrite ? <RotateSection base={base} /> : null}
    </section>
  );
}
