/**
 * MCP servers and A2A agents (card 25.3): register and edit servers (URL, transport, encrypted
 * headers, identity forwarding), test the connection and discover tools through the gateway, edit
 * the tool allow-list of each virtual key, read the tool-call log with filters, and list agents.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  KeysControllerList200Item,
  McpControllerCallsStatus,
  McpControllerCreateBody,
  McpControllerTest200,
  McpControllerUpdateBody,
} from '../api/generated';
import { PageHeader, Section, selectClass, textareaClass } from '../components/s2/common';
import { Button } from '../components/ui/button';
import { Field, FormError } from '../components/ui/field';
import { Loading } from '../components/ui/states';
import { api } from '../lib/api';
import { formatDate } from '../lib/date';
import { errorMessage } from '../lib/errors';
import type { SubmitEvent } from '../lib/form';
import { type Draft, serverBody, type Transport } from '../lib/mcp';
import { listOf, useFormat } from '../lib/s2-format';
import { can, currentOrg, useSession } from '../lib/session';

const TRANSPORTS: readonly Transport[] = ['streamable-http', 'sse', 'a2a'];
const STATUSES: readonly McpControllerCallsStatus[] = ['success', 'error', 'denied'];
const SEPARATOR = '__';
/** The allow-list patterns the keys API accepts. */
const PATTERN = /^(\*|[a-z0-9][a-z0-9-]{0,40}__(\*|[A-Za-z0-9_.-]{1,128}))$/;

interface Server {
  id: string;
  name: string;
  slug: string;
  transport: Transport;
  url: string;
  hasHeaders: boolean;
  enabled: boolean;
  forwardIdentity: boolean;
  timeoutMs: number;
}
interface Call {
  id: string;
  occurredAt: string;
  apiKeyId: string;
  serverId: string;
  tool: string;
  arguments: unknown;
  status: McpControllerCallsStatus;
  errorMessage: string | null;
  latencyMs: number;
}

const EMPTY: Draft = {
  name: '',
  slug: '',
  transport: 'streamable-http',
  url: '',
  headers: '',
  replaceHeaders: true,
  hadHeaders: false,
  forwardIdentity: false,
  enabled: true,
  timeoutMs: '60000',
};

function draftOf(server: Server): Draft {
  return {
    id: server.id,
    name: server.name,
    slug: server.slug,
    transport: server.transport,
    url: server.url,
    headers: '',
    replaceHeaders: false,
    hadHeaders: server.hasHeaders,
    forwardIdentity: server.forwardIdentity,
    enabled: server.enabled,
    timeoutMs: String(server.timeoutMs),
  };
}

export default function McpPage() {
  const { t } = useTranslation();
  const { n, settings } = useFormat();
  const qc = useQueryClient();
  const user = useSession();
  const org = currentOrg();
  const canWrite = can(
    user?.organizations.find((o) => o.id === org?.id),
    'mcp:write',
  );
  const base = `/orgs/${org?.id ?? ''}`;
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [formError, setFormError] = useState<string>();
  const [tests, setTests] = useState<Record<string, McpControllerTest200>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});

  const servers = useQuery({
    queryKey: ['mcp-servers', org?.id],
    queryFn: () => api<unknown>(`${base}/mcp/servers`),
    enabled: Boolean(org),
  });
  const keys = useQuery({
    queryKey: ['mcp-keys', org?.id],
    queryFn: () => api<unknown>(`${base}/keys`),
    enabled: Boolean(org),
  });
  const all = listOf<Server>(servers.data);
  const mcpServers = all.filter((s) => s.transport !== 'a2a');
  const agents = all.filter((s) => s.transport === 'a2a');
  const keyList = listOf<KeysControllerList200Item>(keys.data).filter(
    (k) => k.state === 'active' || k.state === 'rotating',
  );
  const refresh = () => qc.invalidateQueries({ queryKey: ['mcp-servers', org?.id] });

  const save = useMutation({
    mutationFn: (body: McpControllerCreateBody | McpControllerUpdateBody) =>
      draft.id
        ? api<Server>(`${base}/mcp/servers/${draft.id}`, { method: 'PATCH', body })
        : api<Server>(`${base}/mcp/servers`, { method: 'POST', body }),
    onSuccess: () => {
      setDraft(EMPTY);
      void refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (server: Server) =>
      api<unknown>(`${base}/mcp/servers/${server.id}`, {
        method: 'PATCH',
        body: { enabled: !server.enabled },
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<unknown>(`${base}/mcp/servers/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const runTest = async (server: Server) => {
    setTesting((old) => ({ ...old, [server.id]: true }));
    try {
      const result = await api<McpControllerTest200>(`${base}/mcp/servers/${server.id}/test`, {
        method: 'POST',
      });
      setTests((old) => ({ ...old, [server.id]: result }));
    } catch (error) {
      setTests((old) => ({
        ...old,
        [server.id]: { ok: false, latencyMs: 0, tools: [], error: errorMessage(error, t) },
      }));
    } finally {
      setTesting((old) => ({ ...old, [server.id]: false }));
    }
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const body = serverBody(draft);
    if ('badLine' in body) {
      setFormError(t('mcpPage.invalidHeaders', { line: body.badLine }));
      return;
    }
    setFormError(undefined);
    save.mutate(body);
  };
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((old) => ({ ...old, [key]: value }));
  };

  const failure = servers.error ?? toggle.error ?? remove.error;

  const serverRow = (server: Server) => {
    const result = tests[server.id];
    const endpoint = server.transport === 'a2a' ? `/a2a/agents/${server.slug}` : '/mcp';
    return (
      <li
        key={server.id}
        data-testid="mcp-server"
        className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2 text-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium">
              {server.name} <code className="text-xs text-muted">{server.slug}</code>
            </p>
            <p className="text-xs text-muted">
              {t(`mcpPage.transports.${server.transport}`)} · <bdi dir="ltr">{server.url}</bdi>
            </p>
            <p className="text-xs text-muted">
              {server.enabled ? t('mcpPage.on') : t('mcpPage.off')}
              {server.hasHeaders ? ` · ${t('mcpPage.headersStored')}` : ''}
              {server.forwardIdentity ? ` · ${t('mcpPage.identity')}` : ''} ·{' '}
              {t('mcpPage.endpoint')}: <code dir="ltr">{endpoint}</code>
            </p>
          </div>
          {canWrite ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={testing[server.id]}
                onClick={() => void runTest(server)}
              >
                {testing[server.id] ? t('mcpPage.testing') : t('mcpPage.test')}
              </Button>
              <Button
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  setDraft(draftOf(server));
                  setFormError(undefined);
                }}
              >
                {t('mcpPage.edit')}
              </Button>
              <Button
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={toggle.isPending}
                onClick={() => {
                  toggle.mutate(server);
                }}
              >
                {server.enabled ? t('mcpPage.disable') : t('mcpPage.enable')}
              </Button>
              <Button
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={remove.isPending}
                onClick={() => {
                  remove.mutate(server.id);
                }}
              >
                {t('mcpPage.remove')}
              </Button>
            </div>
          ) : null}
        </div>
        {result ? (
          <div data-testid="mcp-test-result" className="flex flex-col gap-1">
            <p className={result.ok ? 'text-good' : 'text-danger'}>
              {result.ok
                ? result.agentName
                  ? t('mcpPage.testOkAgent', {
                      agent: result.agentName,
                      ms: n(result.latencyMs),
                      count: n(result.tools.length),
                    })
                  : t('mcpPage.testOk', { ms: n(result.latencyMs), count: n(result.tools.length) })
                : t('mcpPage.testFailed', {
                    ms: n(result.latencyMs),
                    error: result.error ?? '',
                  })}
            </p>
            {result.tools.length > 0 ? (
              <ul className="flex flex-col gap-0.5 text-xs" data-testid="mcp-tools">
                {result.tools.map((tool) => (
                  <li key={tool.name}>
                    <code dir="ltr">
                      {server.transport === 'a2a'
                        ? tool.name
                        : `${server.slug}${SEPARATOR}${tool.name}`}
                    </code>
                    {tool.description ? (
                      <span className="text-muted"> — {tool.description}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <section className="enter flex flex-col gap-6">
      <PageHeader
        title={t('mcpPage.title')}
        subtitle={t('mcpPage.subtitle', { mcp: '/mcp', a2a: '/a2a/agents/<slug>' })}
      />
      <FormError message={failure ? errorMessage(failure, t) : undefined} />

      <Section title={t('mcpPage.servers')} help={t('mcpPage.serversHelp')}>
        {servers.isPending ? (
          <Loading />
        ) : mcpServers.length === 0 ? (
          <p className="text-sm text-muted">{t('mcpPage.noServers')}</p>
        ) : (
          <ul data-testid="mcp-servers" className="flex flex-col gap-2">
            {mcpServers.map(serverRow)}
          </ul>
        )}
      </Section>

      <Section title={t('mcpPage.agents')} help={t('mcpPage.agentsHelp')}>
        {servers.isPending ? (
          <Loading />
        ) : agents.length === 0 ? (
          <p className="text-sm text-muted">{t('mcpPage.noAgents')}</p>
        ) : (
          <ul data-testid="a2a-agents" className="flex flex-col gap-2">
            {agents.map(serverRow)}
          </ul>
        )}
      </Section>

      {canWrite ? (
        <Section
          title={draft.id ? t('mcpPage.editTitle', { name: draft.name }) : t('mcpPage.register')}
        >
          <form className="flex flex-col gap-3" onSubmit={submit} data-testid="mcp-form">
            <FormError
              message={formError ?? (save.error ? errorMessage(save.error, t) : undefined)}
            />
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              <Field
                name="mcp-name"
                label={t('mcpPage.name')}
                required
                maxLength={100}
                value={draft.name}
                onChange={(event) => {
                  set('name', event.target.value);
                }}
              />
              <Field
                name="mcp-slug"
                label={t('mcpPage.slug')}
                required
                dir="ltr"
                pattern="[a-z0-9][a-z0-9\-]{0,40}"
                title={t('mcpPage.slugHelp')}
                value={draft.slug}
                onChange={(event) => {
                  set('slug', event.target.value);
                }}
              />
              <label htmlFor="mcp-transport" className="flex flex-col gap-1.5 text-sm">
                <span className="text-[13px] font-medium text-fg-2">{t('mcpPage.transport')}</span>
                <select
                  id="mcp-transport"
                  className={selectClass}
                  value={draft.transport}
                  onChange={(event) => {
                    set('transport', event.target.value as Transport);
                  }}
                >
                  {TRANSPORTS.map((transport) => (
                    <option key={transport} value={transport}>
                      {t(`mcpPage.transports.${transport}`)}
                    </option>
                  ))}
                </select>
              </label>
              <Field
                name="mcp-url"
                label={t('mcpPage.url')}
                type="url"
                required
                dir="ltr"
                maxLength={1000}
                className="lg:col-span-2"
                value={draft.url}
                onChange={(event) => {
                  set('url', event.target.value);
                }}
              />
              <Field
                name="mcp-timeout"
                label={t('mcpPage.timeout')}
                type="number"
                min={1000}
                max={300000}
                dir="ltr"
                value={draft.timeoutMs}
                onChange={(event) => {
                  set('timeoutMs', event.target.value);
                }}
              />
            </div>
            {draft.id && draft.hadHeaders ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-brand"
                  checked={draft.replaceHeaders}
                  onChange={(event) => {
                    set('replaceHeaders', event.target.checked);
                  }}
                />
                {t('mcpPage.replaceHeaders')}
              </label>
            ) : null}
            {!draft.id || !draft.hadHeaders || draft.replaceHeaders ? (
              <div className="flex flex-col gap-1.5 text-sm">
                <label htmlFor="mcp-headers" className="text-[13px] font-medium text-fg-2">
                  {t('mcpPage.headers')}
                </label>
                <textarea
                  id="mcp-headers"
                  aria-describedby="mcp-headers-help"
                  dir="ltr"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Authorization: Bearer …"
                  className={`${textareaClass} font-mono`}
                  value={draft.headers}
                  onChange={(event) => {
                    set('headers', event.target.value);
                  }}
                />
                <span id="mcp-headers-help" className="text-xs text-muted">
                  {t('mcpPage.headersHelp')}
                </span>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-4">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-brand"
                  checked={draft.forwardIdentity}
                  onChange={(event) => {
                    set('forwardIdentity', event.target.checked);
                  }}
                />
                <span>
                  {t('mcpPage.forwardIdentity')}
                  <span className="block text-xs text-muted">
                    {t('mcpPage.forwardIdentityHelp')}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-brand"
                  checked={draft.enabled}
                  onChange={(event) => {
                    set('enabled', event.target.checked);
                  }}
                />
                {t('mcpPage.enabled')}
              </label>
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={save.isPending}>
                {draft.id ? t('mcpPage.save') : t('mcpPage.create')}
              </Button>
              {draft.id ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setDraft(EMPTY);
                    setFormError(undefined);
                  }}
                >
                  {t('mcpPage.cancel')}
                </Button>
              ) : null}
            </div>
          </form>
        </Section>
      ) : (
        <p data-testid="mcp-read-only" className="text-sm text-muted">
          {t('mcpPage.readOnly')}
        </p>
      )}

      <AllowList
        base={base}
        servers={all}
        keys={keyList}
        tests={tests}
        canEdit={can(
          user?.organizations.find((o) => o.id === org?.id),
          'keys:write',
        )}
        onDiscover={async () => {
          await Promise.all(all.filter((s) => s.enabled).map((s) => runTest(s)));
        }}
        discovering={Object.values(testing).some(Boolean)}
        onSaved={() => void qc.invalidateQueries({ queryKey: ['mcp-keys', org?.id] })}
      />

      <CallLog
        base={base}
        servers={all}
        keys={listOf<KeysControllerList200Item>(keys.data)}
        orgId={org?.id}
        format={{
          n,
          date: (value) => formatDate(value, { ...settings, time: true, seconds: true }),
        }}
      />
    </section>
  );
}

function AllowList({
  base,
  servers,
  keys,
  tests,
  canEdit,
  onDiscover,
  discovering,
  onSaved,
}: {
  base: string;
  servers: Server[];
  keys: KeysControllerList200Item[];
  tests: Record<string, McpControllerTest200>;
  canEdit: boolean;
  onDiscover: () => Promise<void>;
  discovering: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [keyId, setKeyId] = useState('');
  const [mode, setMode] = useState<'all' | 'selected'>('all');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState('');
  const [error, setError] = useState<string>();
  const key = keys.find((k) => k.id === keyId);
  const known = new Set<string>(
    servers.flatMap((s) => [
      `${s.slug}${SEPARATOR}*`,
      ...(tests[s.id]?.tools ?? []).map((tool) => `${s.slug}${SEPARATOR}${tool.name}`),
    ]),
  );

  const pick = (id: string) => {
    setKeyId(id);
    setError(undefined);
    save.reset();
    const current = keys.find((k) => k.id === id)?.mcpTools ?? [];
    setMode(current.length === 0 ? 'all' : 'selected');
    setChosen(new Set(current.filter((p) => known.has(p))));
    setExtra(current.filter((p) => !known.has(p)).join(', '));
  };
  const save = useMutation({
    mutationFn: (mcpTools: string[]) =>
      api<unknown>(`${base}/keys/${keyId}`, { method: 'PATCH', body: { mcpTools } }),
    onSuccess: onSaved,
  });
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (mode === 'all') {
      save.mutate([]);
      return;
    }
    const others = extra
      .split(/[,\s]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    const bad = others.find((p) => !PATTERN.test(p));
    if (bad) {
      setError(t('mcpPage.allowList.invalidPattern', { pattern: bad }));
      return;
    }
    const patterns = [...new Set([...chosen, ...others])];
    // An empty list means "no restriction" on the server, so "selected" with nothing ticked
    // would silently open every tool; refuse it here instead.
    if (patterns.length === 0) {
      setError(t('mcpPage.allowList.emptySelection'));
      return;
    }
    setError(undefined);
    save.mutate(patterns);
  };
  const toggle = (pattern: string, on: boolean) => {
    setChosen((old) => {
      const next = new Set(old);
      if (on) next.add(pattern);
      else next.delete(pattern);
      return next;
    });
  };

  return (
    <Section
      title={t('mcpPage.allowList.title')}
      help={t('mcpPage.allowList.help')}
      action={
        <Button
          variant="outline"
          className="h-8 text-xs"
          disabled={discovering || servers.length === 0}
          onClick={() => void onDiscover()}
        >
          {discovering ? t('mcpPage.allowList.discovering') : t('mcpPage.allowList.discover')}
        </Button>
      }
    >
      <form className="flex flex-col gap-3" onSubmit={submit} data-testid="mcp-allow-list">
        <label htmlFor="mcp-allow-key" className="flex max-w-sm flex-col gap-1.5 text-sm">
          <span className="text-[13px] font-medium text-fg-2">{t('mcpPage.allowList.key')}</span>
          <select
            id="mcp-allow-key"
            className={selectClass}
            value={keyId}
            onChange={(event) => {
              pick(event.target.value);
            }}
          >
            <option value="">{t('mcpPage.allowList.chooseKey')}</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} ({k.prefix})
              </option>
            ))}
          </select>
        </label>
        {key ? (
          <>
            <p className="text-xs text-muted" data-testid="mcp-allow-current">
              {t('mcpPage.allowList.current', {
                value: key.mcpTools.length ? key.mcpTools.join(', ') : t('mcpPage.allowList.all'),
              })}
            </p>
            <div role="radiogroup" className="flex flex-wrap gap-4 text-sm">
              {(['all', 'selected'] as const).map((value) => (
                <label key={value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="mcp-allow-mode"
                    className="size-4 accent-brand"
                    checked={mode === value}
                    disabled={!canEdit}
                    onChange={() => {
                      setMode(value);
                    }}
                  />
                  {t(`mcpPage.allowList.${value}`)}
                </label>
              ))}
            </div>
            {mode === 'selected' ? (
              <div className="flex flex-col gap-3">
                {servers.map((server) => {
                  const whole = `${server.slug}${SEPARATOR}*`;
                  const tools = tests[server.id]?.tools;
                  return (
                    <fieldset
                      key={server.id}
                      className="flex flex-col gap-1.5 rounded-lg border border-border p-3"
                    >
                      <legend className="px-1 text-sm font-medium">
                        {server.name} <code className="text-xs text-muted">{server.slug}</code>
                      </legend>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 accent-brand"
                          disabled={!canEdit}
                          checked={chosen.has(whole)}
                          onChange={(event) => {
                            toggle(whole, event.target.checked);
                          }}
                        />
                        {t('mcpPage.allowList.wholeServer', { server: server.slug })}
                      </label>
                      {tools === undefined ? (
                        <p className="text-xs text-muted">{t('mcpPage.allowList.notDiscovered')}</p>
                      ) : (
                        <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                          {tools.map((tool) => {
                            const name = `${server.slug}${SEPARATOR}${tool.name}`;
                            return (
                              <label key={name} className="flex items-center gap-2 text-xs">
                                <input
                                  type="checkbox"
                                  className="size-4 accent-brand"
                                  disabled={!canEdit || chosen.has(whole)}
                                  checked={chosen.has(name) || chosen.has(whole)}
                                  onChange={(event) => {
                                    toggle(name, event.target.checked);
                                  }}
                                />
                                <code dir="ltr">{name}</code>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </fieldset>
                  );
                })}
                <Field
                  name="mcp-allow-extra"
                  label={t('mcpPage.allowList.extra')}
                  dir="ltr"
                  disabled={!canEdit}
                  placeholder={t('mcpPage.allowList.extraHelp')}
                  value={extra}
                  onChange={(event) => {
                    setExtra(event.target.value);
                  }}
                />
              </div>
            ) : null}
            <FormError message={error ?? (save.error ? errorMessage(save.error, t) : undefined)} />
            {save.isSuccess ? (
              <p role="status" className="text-sm text-good">
                {t('mcpPage.allowList.saved')}
              </p>
            ) : null}
            {canEdit ? (
              <div>
                <Button type="submit" disabled={save.isPending}>
                  {t('mcpPage.allowList.save')}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </form>
    </Section>
  );
}

function CallLog({
  base,
  servers,
  keys,
  orgId,
  format,
}: {
  base: string;
  servers: Server[];
  keys: KeysControllerList200Item[];
  orgId: string | undefined;
  format: { n: (value: number) => string; date: (value: string) => string };
}) {
  const { t } = useTranslation();
  const [serverId, setServerId] = useState('');
  const [apiKeyId, setApiKeyId] = useState('');
  const [status, setStatus] = useState<McpControllerCallsStatus | ''>('');
  const query = new URLSearchParams({ limit: '100' });
  if (serverId) query.set('serverId', serverId);
  if (apiKeyId) query.set('apiKeyId', apiKeyId);
  if (status) query.set('status', status);
  const calls = useQuery({
    queryKey: ['mcp-calls', orgId, serverId, apiKeyId, status],
    queryFn: () => api<unknown>(`${base}/mcp/calls?${query.toString()}`),
    enabled: Boolean(orgId),
  });
  const rows = listOf<Call>(calls.data);
  const serverName = (id: string) => servers.find((s) => s.id === id)?.slug ?? id;
  const keyName = (id: string) => keys.find((k) => k.id === id)?.name ?? id;
  const filter = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: { value: string; label: string }[],
  ) => (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-sm">
      <span className="text-[13px] font-medium text-fg-2">{label}</span>
      <select
        id={id}
        className={selectClass}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{t('mcpPage.calls.all')}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Section
      title={t('mcpPage.calls.title')}
      help={t('mcpPage.calls.help')}
      action={
        <Button
          variant="outline"
          className="h-8 text-xs"
          onClick={() => void calls.refetch()}
          disabled={calls.isFetching}
        >
          {t('mcpPage.calls.refresh')}
        </Button>
      }
    >
      <div className="grid gap-3 md:grid-cols-3">
        {filter(
          'mcp-call-server',
          t('mcpPage.calls.server'),
          serverId,
          setServerId,
          servers.map((s) => ({ value: s.id, label: s.slug })),
        )}
        {filter(
          'mcp-call-key',
          t('mcpPage.calls.key'),
          apiKeyId,
          setApiKeyId,
          keys.map((k) => ({ value: k.id, label: k.name })),
        )}
        {filter(
          'mcp-call-status',
          t('mcpPage.calls.status'),
          status,
          (value) => {
            setStatus(value as McpControllerCallsStatus | '');
          },
          STATUSES.map((s) => ({ value: s, label: t(`mcpPage.calls.statuses.${s}`) })),
        )}
      </div>
      {calls.isError ? <FormError message={errorMessage(calls.error, t)} /> : null}
      {calls.isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">{t('mcpPage.calls.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table data-testid="mcp-calls" className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th className="py-1.5 text-start font-medium">{t('mcpPage.calls.time')}</th>
                <th className="py-1.5 text-start font-medium">{t('mcpPage.calls.key')}</th>
                <th className="py-1.5 text-start font-medium">{t('mcpPage.calls.tool')}</th>
                <th className="py-1.5 text-start font-medium">{t('mcpPage.calls.status')}</th>
                <th className="py-1.5 text-end font-medium">{t('mcpPage.calls.latency')}</th>
                <th className="py-1.5 text-start font-medium">{t('mcpPage.calls.arguments')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((call) => (
                <tr key={call.id} className="border-t border-border align-top">
                  <td className="py-1.5 pe-3 text-xs whitespace-nowrap">
                    {format.date(call.occurredAt)}
                  </td>
                  <td className="py-1.5 pe-3 text-xs">{keyName(call.apiKeyId)}</td>
                  <td className="py-1.5 pe-3">
                    <code dir="ltr" className="text-xs">
                      {serverName(call.serverId)}
                      {SEPARATOR}
                      {call.tool}
                    </code>
                  </td>
                  <td
                    className={`py-1.5 pe-3 text-xs ${call.status === 'success' ? 'text-good' : 'text-danger'}`}
                  >
                    {t(`mcpPage.calls.statuses.${call.status}`)}
                    {call.errorMessage ? (
                      <span className="block text-muted" title={call.errorMessage}>
                        {call.errorMessage.slice(0, 80)}
                      </span>
                    ) : null}
                  </td>
                  <td className="num py-1.5 pe-3 text-end text-xs" data-testid="mcp-call-latency">
                    {format.n(call.latencyMs)} ms
                  </td>
                  <td className="py-1.5">
                    <code
                      dir="ltr"
                      data-testid="mcp-call-arguments"
                      className="block max-w-md truncate text-xs text-muted"
                      title={JSON.stringify(call.arguments)}
                    >
                      {JSON.stringify(call.arguments)}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
