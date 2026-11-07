export const NAV = [
  { to: '/', key: 'overview' },
  { to: '/providers', key: 'providers' },
  { to: '/keys', key: 'keys' },
  { to: '/models', key: 'models' },
  { to: '/logs', key: 'logs' },
  { to: '/health', key: 'health' },
  { to: '/organization', key: 'organization' },
  { to: '/guides', key: 'guides' },
] as const;
export type NavKey = (typeof NAV)[number]['key'];
