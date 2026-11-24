/**
 * Billing section (cards 25.1, 25.2): the operator's tools for customers' money. Only the platform
 * organization has it, and only members with `billing:read`; everyone else gets the same answer
 * the API gives them (not found). Without `billing:write` every page is read-only.
 */
import { Link, Outlet } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { BILLING_TABS } from '../../components/billing/tabs';
import { PageHeader } from '../../components/s2/common';
import { Empty } from '../../components/ui/states';
import { useBillingAccess } from '../../lib/billing';

export default function BillingLayout() {
  const { t } = useTranslation();
  const access = useBillingAccess();
  if (!access.visible)
    return (
      <Empty title={t('billing.gate.title')}>
        <span data-testid="billing-gate">{t('billing.gate.body')}</span>
      </Empty>
    );
  return (
    <section className="enter flex flex-col gap-6">
      <PageHeader title={t('billing.title')} subtitle={t('billing.subtitle')} />
      <nav
        aria-label={t('billing.title')}
        className="-mt-2 flex flex-wrap gap-0.5 self-start rounded-lg bg-surface-2 p-0.5"
      >
        {BILLING_TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            activeOptions={{ exact: true }}
            className="rounded-lg px-3 py-1.5 text-[13px] font-medium whitespace-nowrap text-fg-2 transition-colors duration-150 hover:text-fg data-[status=active]:bg-surface data-[status=active]:text-fg data-[status=active]:shadow-[0_1px_2px_rgba(0,0,0,0.08)] dark:data-[status=active]:bg-fg/10 dark:data-[status=active]:shadow-none"
          >
            {t(`billing.tabs.${tab.key}`)}
          </Link>
        ))}
      </nav>
      {access.write ? null : (
        <p className="-mt-2 text-[13px] text-muted">{t('billing.readOnly')}</p>
      )}
      <Outlet />
    </section>
  );
}
