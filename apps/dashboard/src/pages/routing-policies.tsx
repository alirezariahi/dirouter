/**
 * Routing policies (sprint 5): what runs on a request before the model is chosen, one tab per
 * policy kind.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RulesPanel } from '../components/routing-policies/rules-panel';
import { SplitsPanel } from '../components/routing-policies/splits-panel';
import { PageHeader, Segmented } from '../components/s2/common';
import { can, currentOrg, useSession } from '../lib/session';

const TABS = ['rules', 'splits'] as const;
type Tab = (typeof TABS)[number];

const PANELS: Record<Tab, typeof RulesPanel> = { rules: RulesPanel, splits: SplitsPanel };

export default function RoutingPoliciesPage() {
  const { t } = useTranslation();
  const user = useSession();
  const org = currentOrg();
  const canWrite = can(
    user?.organizations.find((o) => o.id === org?.id),
    'models:write',
  );
  const base = `/orgs/${org?.id ?? ''}`;
  const [tab, setTab] = useState<Tab>('rules');
  const Panel = PANELS[tab];

  return (
    <section className="enter flex flex-col gap-6">
      <PageHeader title={t('routingPolicies.title')} subtitle={t('routingPolicies.subtitle')}>
        <Segmented
          value={tab}
          onChange={setTab}
          options={TABS.map((value) => ({ value, label: t(`routingPolicies.tabs.${value}`) }))}
        />
      </PageHeader>
      {canWrite ? null : <p className="text-sm text-muted">{t('routingPolicies.readOnly')}</p>}
      {org ? <Panel base={base} canWrite={canWrite} /> : null}
    </section>
  );
}
