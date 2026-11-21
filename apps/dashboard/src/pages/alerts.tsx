/**
 * Alerts (card 16.2): notification channels (each with a "send test message" button and an edit
 * form), alert rules and recent events with acknowledgement. Channel secrets come back masked;
 * the edit form never posts the mask and only sends a secret the user typed again.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PageHeader, Section, selectClass } from '../components/s2/common';
import { Button } from '../components/ui/button';
import { Field, FormError } from '../components/ui/field';
import { Loading } from '../components/ui/states';
import { api } from '../lib/api';
import { listOf, useFormat } from '../lib/s2-format';
import type { SubmitEvent } from '../lib/form';
import { formatDate } from '../lib/date';
import { errorMessage, fieldError } from '../lib/errors';
import { currentOrg } from '../lib/session';
import {
  channelConfig,
  type ChannelForm,
  channelFormOf,
  channelUpdateConfig,
  RULE_TYPES,
  ruleProblem,
  THRESHOLD_RULE_TYPES,
} from '../lib/s2-helpers';

const CHANNEL_TYPES = ['webhook', 'slack', 'telegram', 'email'] as const;
type ChannelType = (typeof CHANNEL_TYPES)[number];
/** Older rows may still carry the two retired types; they are listed but cannot be created. */
type RuleType = (typeof RULE_TYPES)[number] | 'breaker_open' | 'queue_length';

interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  /** Secret values are replaced by `***`. */
  config?: Record<string, unknown>;
  /** Names of the config fields that hold a stored secret. */
  secretFields?: string[];
  hasSecret?: boolean;
}
interface ChannelEdit extends ChannelForm {
  id: string;
  type: ChannelType;
  name: string;
  secretFields: string[];
  clearSecret: boolean;
}
interface Rule {
  id: string;
  name: string;
  type: RuleType;
  threshold: number | null;
  windowMinutes: number | null;
  silenceMinutes: number | null;
  channelId: string | null;
  enabled: boolean;
}
interface AlertEvent {
  id: string;
  title: string;
  severity: string;
  createdAt: string;
  deliveredAt: string | null;
  deliveryError: string | null;
  acknowledgedAt: string | null;
}
interface TestResult {
  ok?: boolean;
  delivered?: boolean;
  error?: string | null;
}

export default function AlertsPage() {
  const { t } = useTranslation();
  const { n, settings } = useFormat();
  const qc = useQueryClient();
  const org = currentOrg();
  const base = `/orgs/${org?.id ?? ''}/alerts`;
  const enabled = Boolean(org);
  const emptyChannel = {
    name: '',
    type: 'webhook' as ChannelType,
    url: '',
    secret: '',
    botToken: '',
    chatId: '',
    to: '',
  };
  const emptyRule = {
    name: '',
    type: 'error_rate' as RuleType,
    threshold: '',
    windowMinutes: '5',
    silenceMinutes: '30',
    channelId: '',
  };
  const [channel, setChannel] = useState(emptyChannel);
  const [rule, setRule] = useState(emptyRule);
  const [testNotice, setTestNotice] = useState<{ id: string; text: string; ok: boolean }>();
  const [edit, setEdit] = useState<ChannelEdit>();
  const [ruleError, setRuleError] = useState<string>();

  const channels = useQuery({
    queryKey: ['alert-channels', org?.id],
    queryFn: () => api<unknown>(`${base}/channels`),
    enabled,
  });
  const rules = useQuery({
    queryKey: ['alert-rules', org?.id],
    queryFn: () => api<unknown>(`${base}/rules`),
    enabled,
  });
  const events = useQuery({
    queryKey: ['alert-events', org?.id],
    queryFn: () => api<unknown>(`${base}/events`, { query: { limit: 50 } }),
    enabled,
    refetchInterval: 30_000,
  });
  const refresh = (key: string) => () => qc.invalidateQueries({ queryKey: [key, org?.id] });

  const createChannel = useMutation({
    mutationFn: () =>
      api<unknown>(`${base}/channels`, {
        method: 'POST',
        body: {
          name: channel.name.trim(),
          type: channel.type,
          config: channelConfig(channel.type, channel),
        },
      }),
    onSuccess: () => {
      setChannel(emptyChannel);
      void refresh('alert-channels')();
    },
  });
  const updateChannel = useMutation({
    mutationFn: (draft: ChannelEdit) =>
      api<unknown>(`${base}/channels/${draft.id}`, {
        method: 'PATCH',
        body: {
          name: draft.name.trim(),
          config: channelUpdateConfig(draft.type, draft, draft.clearSecret ? ['secret'] : []),
        },
      }),
    onSuccess: () => {
      setEdit(undefined);
      void refresh('alert-channels')();
    },
  });
  const removeChannel = useMutation({
    mutationFn: (id: string) => api<unknown>(`${base}/channels/${id}`, { method: 'DELETE' }),
    onSuccess: refresh('alert-channels'),
  });
  const testChannel = useMutation({
    mutationFn: (id: string) => api<TestResult>(`${base}/channels/${id}/test`, { method: 'POST' }),
    onSuccess: (result, id) => {
      const ok = result.ok !== false && result.delivered !== false && !result.error;
      setTestNotice({
        id,
        ok,
        text: ok ? t('s2.alerts.testOk') : t('s2.alerts.testFailed', { error: result.error ?? '' }),
      });
    },
    onError: (error, id) => {
      setTestNotice({
        id,
        ok: false,
        text: t('s2.alerts.testFailed', { error: errorMessage(error, t) }),
      });
    },
  });
  const createRule = useMutation({
    mutationFn: () =>
      api<unknown>(`${base}/rules`, {
        method: 'POST',
        body: {
          name: rule.name.trim(),
          type: rule.type,
          ...(rule.threshold !== '' ? { threshold: Number(rule.threshold) } : {}),
          ...(rule.windowMinutes !== '' ? { windowMinutes: Number(rule.windowMinutes) } : {}),
          ...(rule.silenceMinutes !== '' ? { silenceMinutes: Number(rule.silenceMinutes) } : {}),
          channelId: rule.channelId || null,
        },
      }),
    onSuccess: () => {
      setRule(emptyRule);
      void refresh('alert-rules')();
    },
  });
  const toggleRule = useMutation({
    mutationFn: (item: Rule) =>
      api<unknown>(`${base}/rules/${item.id}`, {
        method: 'PATCH',
        body: { enabled: !item.enabled },
      }),
    onSuccess: refresh('alert-rules'),
  });
  const removeRule = useMutation({
    mutationFn: (id: string) => api<unknown>(`${base}/rules/${id}`, { method: 'DELETE' }),
    onSuccess: refresh('alert-rules'),
  });
  const ack = useMutation({
    mutationFn: (id: string) => api<unknown>(`${base}/events/${id}/ack`, { method: 'POST' }),
    onSuccess: refresh('alert-events'),
  });

  const channelRows = listOf<Channel>(channels.data);
  const ruleRows = listOf<Rule>(rules.data);
  const eventRows = listOf<AlertEvent>(events.data);
  const channelName = new Map(channelRows.map((c) => [c.id, c.name]));
  const failure =
    createChannel.error ??
    updateChannel.error ??
    removeChannel.error ??
    createRule.error ??
    toggleRule.error ??
    removeRule.error ??
    ack.error ??
    channels.error ??
    rules.error ??
    events.error;
  const setC = (key: keyof typeof emptyChannel) => (event: { target: { value: string } }) => {
    setChannel((c) => ({ ...c, [key]: event.target.value }));
  };
  const setR = (key: keyof typeof emptyRule) => (event: { target: { value: string } }) => {
    setRuleError(undefined);
    setRule((r) => ({ ...r, [key]: event.target.value }));
  };
  const setE = (key: keyof ChannelForm | 'name') => (event: { target: { value: string } }) => {
    setEdit((current) => (current ? { ...current, [key]: event.target.value } : current));
  };
  const thresholdRequired = THRESHOLD_RULE_TYPES.includes(rule.type);
  /** Placeholder of a secret input: says a value is stored and that blank keeps it. */
  const stored = (draft: ChannelEdit, field: string) =>
    draft.secretFields.includes(field) ? t('s2.alerts.secretStored') : undefined;
  const date = (iso: string) =>
    formatDate(iso, { calendar: settings.calendar, lang: settings.lang, time: true });

  return (
    <section className="flex flex-col gap-4">
      <PageHeader title={t('s2.alerts.title')} subtitle={t('s2.alerts.subtitle')} />
      <FormError message={failure ? errorMessage(failure, t) : undefined} />

      <Section title={t('s2.alerts.channels')}>
        {channels.isPending ? (
          <Loading />
        ) : channelRows.length === 0 ? (
          <p className="text-sm text-muted">{t('s2.common.none')}</p>
        ) : (
          <ul data-testid="channel-list" className="flex flex-col gap-2">
            {channelRows.map((item) => (
              <li key={item.id} className="rounded border border-border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{item.name}</span>{' '}
                    <span className="text-xs text-muted">
                      {t(`s2.alerts.channelTypes.${item.type}`)}
                      {item.hasSecret ? ` · ${t('s2.alerts.hasSecret')}` : ''}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    <Button
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      aria-expanded={edit?.id === item.id}
                      onClick={() => {
                        updateChannel.reset();
                        setEdit((current) =>
                          current?.id === item.id
                            ? undefined
                            : {
                                id: item.id,
                                type: item.type,
                                name: item.name,
                                secretFields: item.secretFields ?? [],
                                clearSecret: false,
                                ...channelFormOf(item.type, item.config),
                              },
                        );
                      }}
                    >
                      {t('s2.alerts.edit')}
                    </Button>
                    <Button
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      disabled={testChannel.isPending}
                      onClick={() => {
                        setTestNotice(undefined);
                        testChannel.mutate(item.id);
                      }}
                    >
                      {t('s2.alerts.sendTest')}
                    </Button>
                    <Button
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      disabled={removeChannel.isPending}
                      onClick={() => {
                        removeChannel.mutate(item.id);
                      }}
                    >
                      {t('s2.common.delete')}
                    </Button>
                  </span>
                </div>
                {testNotice?.id === item.id ? (
                  <p
                    role="status"
                    className={`mt-1 text-xs ${testNotice.ok ? 'text-muted' : 'text-danger'}`}
                  >
                    {testNotice.text}
                  </p>
                ) : null}
                {edit?.id === item.id ? (
                  <form
                    data-testid="channel-edit"
                    className="mt-3 grid gap-3 border-t border-border pt-3 md:grid-cols-2 lg:grid-cols-3"
                    onSubmit={(event: SubmitEvent) => {
                      event.preventDefault();
                      updateChannel.mutate(edit);
                    }}
                  >
                    <Field
                      name="edit-channel-name"
                      label={t('s2.common.name')}
                      required
                      value={edit.name}
                      onChange={setE('name')}
                    />
                    {edit.type === 'telegram' ? (
                      <>
                        <Field
                          name="edit-channel-bot"
                          label={t('s2.alerts.botToken')}
                          type="password"
                          autoComplete="off"
                          dir="ltr"
                          required={!edit.secretFields.includes('botToken')}
                          placeholder={stored(edit, 'botToken')}
                          value={edit.botToken}
                          onChange={setE('botToken')}
                        />
                        <Field
                          name="edit-channel-chat"
                          label={t('s2.alerts.chatId')}
                          dir="ltr"
                          required
                          value={edit.chatId}
                          onChange={setE('chatId')}
                        />
                      </>
                    ) : (
                      <Field
                        name="edit-channel-url"
                        label={t('s2.alerts.url')}
                        type="url"
                        dir="ltr"
                        required={
                          !edit.secretFields.includes(
                            edit.type === 'webhook' ? 'url' : 'webhookUrl',
                          )
                        }
                        placeholder={stored(edit, edit.type === 'webhook' ? 'url' : 'webhookUrl')}
                        value={edit.url}
                        onChange={setE('url')}
                      />
                    )}
                    {edit.type === 'webhook' ? (
                      <div className="flex flex-col gap-1">
                        <Field
                          name="edit-channel-secret"
                          label={t('s2.alerts.secret')}
                          type="password"
                          autoComplete="off"
                          dir="ltr"
                          disabled={edit.clearSecret}
                          placeholder={stored(edit, 'secret')}
                          value={edit.secret}
                          onChange={setE('secret')}
                        />
                        {edit.secretFields.includes('secret') ? (
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={edit.clearSecret}
                              onChange={(event) => {
                                setEdit({ ...edit, clearSecret: event.target.checked, secret: '' });
                              }}
                            />
                            {t('s2.alerts.secretClear')}
                          </label>
                        ) : null}
                      </div>
                    ) : null}
                    {edit.type === 'email' ? (
                      <Field
                        name="edit-channel-to"
                        label={t('s2.alerts.to')}
                        type="email"
                        dir="ltr"
                        required
                        value={edit.to}
                        onChange={setE('to')}
                      />
                    ) : null}
                    <div className="flex items-end gap-2">
                      <Button type="submit" disabled={updateChannel.isPending}>
                        {t('s2.common.save')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setEdit(undefined);
                        }}
                      >
                        {t('s2.alerts.cancel')}
                      </Button>
                    </div>
                    {edit.secretFields.length > 0 ? (
                      <p className="text-xs text-muted md:col-span-2 lg:col-span-3">
                        {t('s2.alerts.secretHelp')}
                      </p>
                    ) : null}
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <form
          className="grid gap-3 md:grid-cols-2 lg:grid-cols-3"
          onSubmit={(event: SubmitEvent) => {
            event.preventDefault();
            createChannel.mutate();
          }}
        >
          <Field
            name="channel-name"
            label={t('s2.common.name')}
            required
            value={channel.name}
            onChange={setC('name')}
          />
          <label htmlFor="channel-type" className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('s2.common.type')}</span>
            <select
              id="channel-type"
              className={selectClass}
              value={channel.type}
              onChange={setC('type')}
            >
              {CHANNEL_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`s2.alerts.channelTypes.${type}`)}
                </option>
              ))}
            </select>
          </label>
          {channel.type === 'telegram' ? (
            <>
              <Field
                name="channel-bot"
                label={t('s2.alerts.botToken')}
                type="password"
                autoComplete="off"
                dir="ltr"
                required
                value={channel.botToken}
                onChange={setC('botToken')}
              />
              <Field
                name="channel-chat"
                label={t('s2.alerts.chatId')}
                dir="ltr"
                required
                value={channel.chatId}
                onChange={setC('chatId')}
              />
            </>
          ) : (
            <Field
              name="channel-url"
              label={t('s2.alerts.url')}
              type="url"
              dir="ltr"
              required
              value={channel.url}
              onChange={setC('url')}
            />
          )}
          {channel.type === 'webhook' ? (
            <Field
              name="channel-secret"
              label={t('s2.alerts.secret')}
              type="password"
              autoComplete="off"
              dir="ltr"
              value={channel.secret}
              onChange={setC('secret')}
            />
          ) : null}
          {channel.type === 'email' ? (
            <Field
              name="channel-to"
              label={t('s2.alerts.to')}
              type="email"
              dir="ltr"
              required
              value={channel.to}
              onChange={setC('to')}
            />
          ) : null}
          <div className="flex items-end">
            <Button type="submit" disabled={createChannel.isPending}>
              {t('s2.common.add')}
            </Button>
          </div>
          {channel.type === 'email' ? (
            <p className="text-xs text-muted md:col-span-2 lg:col-span-3">
              {t('s2.alerts.emailHelp')}
            </p>
          ) : null}
        </form>
      </Section>

      <Section title={t('s2.alerts.rules')}>
        {rules.isPending ? (
          <Loading />
        ) : ruleRows.length === 0 ? (
          <p className="text-sm text-muted">{t('s2.common.none')}</p>
        ) : (
          <ul data-testid="rule-list" className="flex flex-col gap-2">
            {ruleRows.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium">{item.name}</p>
                  <p className="text-xs text-muted">
                    {t(`s2.alerts.ruleTypes.${item.type}`)}
                    {item.threshold !== null
                      ? ` · ${t('s2.alerts.threshold')}: ${n(item.threshold)}`
                      : ''}
                    {item.windowMinutes !== null
                      ? ` · ${t('s2.alerts.window')}: ${n(item.windowMinutes)}`
                      : ''}
                    {' · '}
                    {item.channelId
                      ? (channelName.get(item.channelId) ?? item.channelId)
                      : t('s2.alerts.noChannel')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted">
                    {item.enabled ? t('s2.common.enabled') : t('s2.common.disabled')}
                  </span>
                  <Button
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={toggleRule.isPending}
                    onClick={() => {
                      toggleRule.mutate(item);
                    }}
                  >
                    {item.enabled ? t('s2.common.disable') : t('s2.common.enable')}
                  </Button>
                  <Button
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={removeRule.isPending}
                    onClick={() => {
                      removeRule.mutate(item.id);
                    }}
                  >
                    {t('s2.common.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form
          className="grid gap-3 md:grid-cols-3 lg:grid-cols-6"
          onSubmit={(event: SubmitEvent) => {
            event.preventDefault();
            const problem = ruleProblem(rule);
            if (problem) {
              setRuleError(t(`s2.alerts.ruleProblems.${problem}`));
              return;
            }
            setRuleError(undefined);
            createRule.mutate();
          }}
        >
          <Field
            name="rule-name"
            label={t('s2.common.name')}
            required
            value={rule.name}
            onChange={setR('name')}
          />
          <label htmlFor="rule-type" className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('s2.common.type')}</span>
            <select
              id="rule-type"
              className={selectClass}
              value={rule.type}
              onChange={setR('type')}
            >
              {RULE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`s2.alerts.ruleTypes.${type}`)}
                </option>
              ))}
            </select>
          </label>
          <Field
            name="rule-threshold"
            label={t('s2.alerts.threshold')}
            type="number"
            min={0}
            step="any"
            dir="ltr"
            required={thresholdRequired}
            value={rule.threshold}
            onChange={setR('threshold')}
            error={ruleError ?? fieldError(createRule.error, 'threshold')}
          />
          <Field
            name="rule-window"
            label={t('s2.alerts.window')}
            type="number"
            min={1}
            max={1440}
            dir="ltr"
            value={rule.windowMinutes}
            onChange={setR('windowMinutes')}
          />
          <Field
            name="rule-silence"
            label={t('s2.alerts.silence')}
            type="number"
            min={1}
            max={10080}
            dir="ltr"
            value={rule.silenceMinutes}
            onChange={setR('silenceMinutes')}
          />
          <label htmlFor="rule-channel" className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('s2.alerts.channel')}</span>
            <select
              id="rule-channel"
              className={selectClass}
              value={rule.channelId}
              onChange={setR('channelId')}
            >
              <option value="">{t('s2.alerts.noChannel')}</option>
              {channelRows.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div>
            <Button type="submit" disabled={createRule.isPending}>
              {t('s2.common.add')}
            </Button>
          </div>
        </form>
      </Section>

      <Section title={t('s2.alerts.events')}>
        {events.isPending ? (
          <Loading />
        ) : eventRows.length === 0 ? (
          <p className="text-sm text-muted">{t('s2.common.none')}</p>
        ) : (
          <ul data-testid="event-list" className="flex flex-col">
            {eventRows.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2 text-sm"
              >
                <div>
                  <p className="font-medium">{item.title}</p>
                  <p className="text-xs text-muted">
                    {date(item.createdAt)} · <span dir="ltr">{item.severity}</span> ·{' '}
                    {item.deliveredAt ? t('s2.alerts.delivered') : t('s2.alerts.notDelivered')}
                    {item.deliveryError ? ` (${item.deliveryError})` : ''}
                  </p>
                </div>
                {item.acknowledgedAt ? (
                  <span className="text-xs text-muted">{t('s2.alerts.acked')}</span>
                ) : (
                  <Button
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={ack.isPending}
                    onClick={() => {
                      ack.mutate(item.id);
                    }}
                  >
                    {t('s2.alerts.ack')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </section>
  );
}
