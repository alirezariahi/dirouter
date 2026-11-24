/**
 * Sale pricing (card 25.2): what customers pay. A platform model's sale multiplier (or a fixed
 * price per request) and its cache share, whether it is published in the marketplace (offered to
 * customer organizations), customer groups whose multiplier scales every price for their members,
 * and which group each customer is in.
 *
 * Prices reach the gateway in the config snapshot, which control-api rebuilds after every change,
 * so a new multiplier applies to the next request without a deploy.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  cellClass,
  DataTable,
  inputClass,
  Money,
  Notice,
  numClass,
  rowClass,
} from '../../components/billing/common';
import { type CustomerWallet, useCustomers } from '../../components/billing/model';
import { Section, selectClass } from '../../components/s2/common';
import { Button } from '../../components/ui/button';
import { Field, FormError } from '../../components/ui/field';
import { ErrorState, Loading } from '../../components/ui/states';
import { api } from '../../lib/api';
import { multiplyUsd, trimUsd, useBillingAccess } from '../../lib/billing';
import { errorMessage, fieldError } from '../../lib/errors';
import type { SubmitEvent } from '../../lib/form';
import { listOf, useFormat } from '../../lib/s2-format';
import { can, currentOrg, useSession } from '../../lib/session';

interface PlatformModel {
  id: string;
  slug: string;
  displayName: string | null;
  enabled: boolean;
  pricing: { inputPerMTok: string; outputPerMTok: string };
  isPublic: boolean;
  sale: { multiplier: string; perRequestUsd: string | null; cacheMultiplier: string };
}
interface Group {
  id: string;
  name: string;
  multiplier: string;
  description: string | null;
  organizations: number;
}
interface SaleDraft {
  isPublic: boolean;
  multiplier: string;
  perRequestUsd: string;
  cacheMultiplier: string;
}

const MULTIPLIER = /^\d{1,6}(\.\d{1,8})?$/;
const USD = /^\d{1,10}(\.\d{1,8})?$/;

const draftOf = (m: PlatformModel): SaleDraft => ({
  isPublic: m.isPublic,
  multiplier: m.sale.multiplier,
  perRequestUsd: m.sale.perRequestUsd ?? '',
  cacheMultiplier: m.sale.cacheMultiplier,
});

/** The PATCH body for a model's sale settings, or the field the API would refuse. */
function saleBody(d: SaleDraft) {
  const multiplier = d.multiplier.trim();
  const perRequest = d.perRequestUsd.trim();
  const cache = d.cacheMultiplier.trim();
  if (!MULTIPLIER.test(multiplier)) return { problem: 'multiplier' as const };
  if (perRequest && !USD.test(perRequest)) return { problem: 'perRequest' as const };
  if (!MULTIPLIER.test(cache)) return { problem: 'cache' as const };
  return {
    body: {
      isPublic: d.isPublic,
      sale: { multiplier, perRequestUsd: perRequest || null, cacheMultiplier: cache },
    },
  };
}

export default function PricingPage() {
  return (
    <div className="flex flex-col gap-6">
      <ModelPrices />
      <Groups />
    </div>
  );
}

function ModelPrices() {
  const { t } = useTranslation();
  const { orgId, write } = useBillingAccess();
  const user = useSession();
  // Model sale settings are saved on the model itself, which also needs models:write.
  const canEdit =
    write &&
    can(
      user?.organizations.find((o) => o.id === currentOrg()?.id),
      'models:write',
    );
  const models = useQuery({
    queryKey: ['billing', orgId, 'platform-models'],
    queryFn: () => api<unknown>(`/orgs/${orgId}/models`),
    enabled: Boolean(orgId),
  });
  const rows = listOf<PlatformModel>(models.data);

  return (
    <Section title={t('billing.pricing.models')} help={t('billing.pricing.modelsHelp')}>
      {models.isError ? (
        <ErrorState error={models.error} onRetry={() => void models.refetch()} />
      ) : models.isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">{t('billing.pricing.noModels')}</p>
      ) : (
        <DataTable
          testId="model-price-table"
          minWidth={1100}
          caption={t('billing.pricing.models')}
          columns={[
            { key: 'model', label: t('billing.pricing.col.model') },
            { key: 'cost', label: t('billing.pricing.col.cost'), numeric: true },
            { key: 'multiplier', label: t('billing.pricing.col.multiplier') },
            { key: 'perRequest', label: t('billing.pricing.col.perRequest') },
            { key: 'cache', label: t('billing.pricing.col.cache') },
            { key: 'sale', label: t('billing.pricing.col.sale'), numeric: true },
            { key: 'public', label: t('billing.pricing.col.public') },
            { key: 'actions', label: t('billing.common.actions'), numeric: true },
          ]}
        >
          {rows.map((m) => (
            <ModelRow key={m.id} model={m} canEdit={canEdit} />
          ))}
        </DataTable>
      )}
      {write && !canEdit ? <Notice>{t('billing.pricing.needsModelsWrite')}</Notice> : null}
    </Section>
  );
}

function ModelRow({ model, canEdit }: { model: PlatformModel; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { orgId } = useBillingAccess();
  const [draft, setDraft] = useState<SaleDraft>(() => draftOf(model));
  const [problem, setProblem] = useState<string>();
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<PlatformModel>(`/orgs/${orgId}/models/${model.id}`, { method: 'PATCH', body }),
    onSuccess: async (saved) => {
      setDraft(draftOf(saved));
      await qc.invalidateQueries({ queryKey: ['billing', orgId, 'platform-models'] });
    },
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(model));
  const set = <K extends keyof SaleDraft>(key: K, value: SaleDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setProblem(undefined);
    save.reset();
  };
  const valid = MULTIPLIER.test(draft.multiplier.trim());
  const label = model.displayName ?? model.slug;
  const input = (key: 'multiplier' | 'perRequestUsd' | 'cacheMultiplier', aria: string) => (
    <input
      className={`${inputClass} h-9 w-24`}
      dir="ltr"
      inputMode="decimal"
      aria-label={aria}
      disabled={!canEdit || save.isPending}
      value={draft[key]}
      placeholder={key === 'perRequestUsd' ? '—' : undefined}
      onChange={(e) => {
        set(key, e.target.value);
      }}
    />
  );

  return (
    <tr className={rowClass} data-testid="model-price-row">
      <td className={cellClass}>
        <p className="font-medium">{label}</p>
        <code dir="ltr" className="text-xs text-muted">
          {model.slug}
        </code>
        {problem || save.error ? (
          <p role="alert" className="mt-1 text-xs text-danger">
            {problem ? t(`billing.pricing.problem.${problem}`) : errorMessage(save.error, t)}
          </p>
        ) : save.isSuccess ? (
          <p role="status" className="mt-1 text-xs text-good">
            {t('billing.pricing.saved')}
          </p>
        ) : null}
      </td>
      <td className={`${numClass} text-xs text-fg-2`}>
        <bdi>
          {model.pricing.inputPerMTok} / {model.pricing.outputPerMTok}
        </bdi>
      </td>
      <td className={cellClass}>
        {input('multiplier', t('billing.pricing.multiplierOf', { model: label }))}
      </td>
      <td className={cellClass}>
        {input('perRequestUsd', t('billing.pricing.perRequestOf', { model: label }))}
      </td>
      <td className={cellClass}>
        {input('cacheMultiplier', t('billing.pricing.cacheOf', { model: label }))}
      </td>
      <td className={`${numClass} text-xs`} data-testid="sale-price">
        {draft.perRequestUsd.trim() ? (
          <span>
            <Money value={draft.perRequestUsd.trim()} /> {t('billing.pricing.perRequest')}
          </span>
        ) : valid ? (
          <bdi>
            {trimUsd(multiplyUsd(model.pricing.inputPerMTok, draft.multiplier.trim()))} /{' '}
            {trimUsd(multiplyUsd(model.pricing.outputPerMTok, draft.multiplier.trim()))}
          </bdi>
        ) : (
          '—'
        )}
      </td>
      <td className={cellClass}>
        <label className="flex items-center gap-2 text-sm whitespace-nowrap">
          <input
            type="checkbox"
            checked={draft.isPublic}
            disabled={!canEdit || save.isPending}
            onChange={(e) => {
              set('isPublic', e.target.checked);
            }}
          />
          <span className="sr-only">{t('billing.pricing.publishOf', { model: label })}</span>
          <span aria-hidden>
            {t(draft.isPublic ? 'billing.pricing.published' : 'billing.pricing.private')}
          </span>
        </label>
      </td>
      <td className="px-4 py-2 text-end">
        <Button
          variant={dirty ? 'primary' : 'outline'}
          disabled={!canEdit || !dirty || save.isPending}
          aria-label={t('billing.pricing.saveOf', { model: label })}
          onClick={() => {
            const result = saleBody(draft);
            if ('problem' in result) setProblem(result.problem);
            else save.mutate(result.body);
          }}
        >
          {t('billing.common.save')}
        </Button>
      </td>
    </tr>
  );
}

function Groups() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { orgId, write } = useBillingAccess();
  const base = `/orgs/${orgId}/billing`;
  const [name, setName] = useState('');
  const [multiplier, setMultiplier] = useState('');
  const [description, setDescription] = useState('');
  const groups = useQuery({
    queryKey: ['billing', orgId, 'groups'],
    queryFn: () => api<Group[]>(`${base}/groups`),
    enabled: Boolean(orgId),
  });
  const customers = useCustomers(orgId);
  const refresh = () => qc.invalidateQueries({ queryKey: ['billing', orgId] });
  const create = useMutation({
    mutationFn: () =>
      api<Group>(`${base}/groups`, {
        method: 'POST',
        body: {
          name: name.trim(),
          multiplier: multiplier.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
        },
      }),
    onSuccess: async () => {
      setName('');
      setMultiplier('');
      setDescription('');
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<Group>(`${base}/groups/${id}`, { method: 'PATCH', body }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<unknown>(`${base}/groups/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const assign = useMutation({
    mutationFn: ({ customer, group }: { customer: string; group: string | null }) =>
      api<unknown>(`${base}/wallets/${customer}/group`, {
        method: 'PUT',
        body: { customerGroupId: group },
      }),
    onSuccess: refresh,
  });
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    create.mutate();
  };
  const list = groups.data ?? [];
  const failure = update.error ?? remove.error ?? assign.error ?? groups.error ?? customers.error;

  return (
    <>
      <Section title={t('billing.groups.title')} help={t('billing.groups.help')}>
        <FormError message={failure ? errorMessage(failure, t) : undefined} />
        {groups.isPending ? (
          <Loading />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted">{t('billing.groups.none')}</p>
        ) : (
          <DataTable
            testId="group-table"
            caption={t('billing.groups.title')}
            columns={[
              { key: 'name', label: t('billing.groups.col.name') },
              { key: 'multiplier', label: t('billing.groups.col.multiplier') },
              { key: 'members', label: t('billing.groups.col.members'), numeric: true },
              { key: 'actions', label: t('billing.common.actions'), numeric: true },
            ]}
          >
            {list.map((g) => (
              <GroupRow
                key={`${g.id}:${g.multiplier}`}
                group={g}
                disabled={!write || update.isPending || remove.isPending}
                onSave={(value) => {
                  update.mutate({ id: g.id, body: { multiplier: value } });
                }}
                onDelete={() => {
                  if (window.confirm(t('billing.groups.deleteConfirm', { name: g.name })))
                    remove.mutate(g.id);
                }}
              />
            ))}
          </DataTable>
        )}
        <form
          onSubmit={submit}
          aria-label={t('billing.groups.create')}
          className="flex flex-col gap-2 border-t border-border pt-4"
        >
          <h3 className="text-sm font-medium">{t('billing.groups.create')}</h3>
          <fieldset
            disabled={!write || create.isPending}
            className="flex flex-wrap items-end gap-3"
          >
            <Field
              label={t('billing.groups.name')}
              name="groupName"
              required
              maxLength={100}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              error={fieldError(create.error, 'name')}
            />
            <Field
              label={t('billing.groups.multiplier')}
              name="groupMultiplier"
              required
              dir="ltr"
              inputMode="decimal"
              className="w-28"
              value={multiplier}
              onChange={(e) => {
                setMultiplier(e.target.value);
              }}
              error={fieldError(create.error, 'multiplier')}
            />
            <div className="min-w-56 flex-1">
              <Field
                label={t('billing.groups.description')}
                name="groupDescription"
                maxLength={500}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
              />
            </div>
            <Button type="submit">{t('billing.groups.add')}</Button>
          </fieldset>
          <FormError message={create.error ? errorMessage(create.error, t) : undefined} />
        </form>
      </Section>

      <Section title={t('billing.groups.assign')} help={t('billing.groups.assignHelp')}>
        {customers.isPending ? (
          <Loading />
        ) : (customers.data ?? []).length === 0 ? (
          <p className="text-sm text-muted">{t('billing.customers.none')}</p>
        ) : (
          <DataTable
            testId="group-assignment-table"
            caption={t('billing.groups.assign')}
            columns={[
              { key: 'customer', label: t('billing.customers.col.name') },
              { key: 'group', label: t('billing.groups.col.group') },
            ]}
          >
            {(customers.data ?? []).map((c: CustomerWallet) => (
              <tr key={c.organizationId} className={rowClass}>
                <td className={cellClass}>{c.name}</td>
                <td className="px-4 py-2">
                  <select
                    className={`${selectClass} h-9`}
                    aria-label={t('billing.groups.groupOf', { name: c.name })}
                    disabled={!write || assign.isPending}
                    value={c.customerGroupId ?? ''}
                    onChange={(e) => {
                      assign.mutate({ customer: c.organizationId, group: e.target.value || null });
                    }}
                  >
                    <option value="">{t('billing.groups.listPrice')}</option>
                    {list.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name} (×{trimUsd(g.multiplier)})
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Section>
    </>
  );
}

function GroupRow({
  group,
  disabled,
  onSave,
  onDelete,
}: {
  group: Group;
  disabled: boolean;
  onSave: (multiplier: string) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { n } = useFormat();
  const shown = trimUsd(group.multiplier);
  const [value, setValue] = useState(shown);
  const valid = MULTIPLIER.test(value.trim()) && Number(value) > 0;
  return (
    <tr className={rowClass} data-testid="group-row">
      <td className={cellClass}>
        <p className="font-medium">{group.name}</p>
        {group.description ? <p className="text-xs text-muted">{group.description}</p> : null}
      </td>
      <td className="px-4 py-2">
        <input
          className={`${inputClass} h-9 w-24`}
          dir="ltr"
          inputMode="decimal"
          aria-label={t('billing.groups.multiplierOf', { name: group.name })}
          aria-invalid={valid ? undefined : true}
          disabled={disabled}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
          }}
        />
      </td>
      <td className={numClass}>{n(group.organizations)}</td>
      <td className="px-4 py-2 text-end">
        <span className="inline-flex gap-2">
          <Button
            variant="outline"
            disabled={disabled || !valid || value.trim() === shown}
            onClick={() => {
              onSave(value.trim());
            }}
          >
            {t('billing.common.save')}
          </Button>
          <Button variant="ghost" className="text-danger" disabled={disabled} onClick={onDelete}>
            {t('billing.common.remove')}
          </Button>
        </span>
      </td>
    </tr>
  );
}
