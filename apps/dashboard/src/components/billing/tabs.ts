/** The billing section's tabs, in the order an operator works through them. */
export const BILLING_TABS = [
  { to: '/billing', key: 'customers' },
  { to: '/billing/payments', key: 'payments' },
  { to: '/billing/gift-codes', key: 'giftCodes' },
  { to: '/billing/settings', key: 'settings' },
] as const;
