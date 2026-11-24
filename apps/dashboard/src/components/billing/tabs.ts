/** The billing section's tabs, in the order an operator works through them. */
export const BILLING_TABS = [
  { to: '/billing', key: 'customers' },
  { to: '/billing/payments', key: 'payments' },
  { to: '/billing/gift-codes', key: 'giftCodes' },
  { to: '/billing/pricing', key: 'pricing' },
  { to: '/billing/plans', key: 'plans' },
  { to: '/billing/invoices', key: 'invoices' },
  { to: '/billing/profit', key: 'profit' },
  { to: '/billing/settings', key: 'settings' },
] as const;
