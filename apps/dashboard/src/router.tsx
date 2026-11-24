/**
 * Routes (TanStack Router, code-based). /login, /invite/<token> and /setup are public; the rest sit under the protected layout
 * which first restores the session with refresh and, if absent, redirects to /setup (if no user exists yet) or
 * /login. Pages are lazy-loaded to keep the initial bundle small.
 */
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { AppShell } from './components/layout/app-shell';
import { NAV } from './components/layout/nav';
import { Empty, ErrorState, Loading } from './components/ui/states';
import { restoreSession, setupRequired } from './lib/session';
import { validateLogSearch } from './lib/log-search';
import { Placeholder } from './pages/placeholder';

function NotFound() {
  const { t } = useTranslation();
  return (
    <Empty title={t('state.notFound')}>
      <Link to="/" className="text-brand underline">
        {t('state.back')}
      </Link>
    </Empty>
  );
}

const root = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFound,
  pendingComponent: () => <Loading />,
  errorComponent: ({ error, reset }) => <ErrorState error={error} onRetry={reset} />,
});

const login = createRoute({
  getParentRoute: () => root,
  path: '/login',
  component: lazyRouteComponent(() => import('./pages/login')),
});
/** Public: the invited person usually has no session (and may have no account) yet. */
const invite = createRoute({
  getParentRoute: () => root,
  path: '/invite/$token',
  component: lazyRouteComponent(() => import('./pages/invite')),
});
const setup = createRoute({
  getParentRoute: () => root,
  path: '/setup',
  component: lazyRouteComponent(() => import('./pages/setup')),
});

const app = createRoute({
  getParentRoute: () => root,
  id: 'app',
  component: AppShell,
  beforeLoad: async () => {
    if (await restoreSession()) return;
    const needsSetup = await setupRequired().catch(() => false);
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- redirect pattern in TanStack Router
    throw redirect({ to: needsSetup ? '/setup' : '/login' });
  },
});

const overview = createRoute({
  getParentRoute: () => app,
  path: '/',
  component: lazyRouteComponent(() => import('./pages/overview')),
});
const account = createRoute({
  getParentRoute: () => app,
  path: '/account',
  component: lazyRouteComponent(() => import('./pages/account')),
});
const health = createRoute({
  getParentRoute: () => app,
  path: '/health',
  component: lazyRouteComponent(() => import('./pages/health')),
});
const logs = createRoute({
  getParentRoute: () => app,
  path: '/logs',
  validateSearch: validateLogSearch,
  component: lazyRouteComponent(() => import('./pages/logs')),
});
const providers = createRoute({
  getParentRoute: () => app,
  path: '/providers',
  component: lazyRouteComponent(() => import('./pages/providers')),
});
const keys = createRoute({
  getParentRoute: () => app,
  path: '/keys',
  component: lazyRouteComponent(() => import('./pages/keys')),
});
const models = createRoute({
  getParentRoute: () => app,
  path: '/models',
  component: lazyRouteComponent(() => import('./pages/models')),
});
const organization = createRoute({
  getParentRoute: () => app,
  path: '/organization',
  component: lazyRouteComponent(() => import('./pages/organization')),
});
const guides = createRoute({
  getParentRoute: () => app,
  path: '/guides',
  component: lazyRouteComponent(() => import('./pages/guides')),
});
/** Sprint 2 pages; each entry is lazy-loaded like the pages above. */
const SPRINT2_PAGES = [
  { path: '/simulator', load: () => import('./pages/simulator') },
  { path: '/security', load: () => import('./pages/security') },
  { path: '/cost', load: () => import('./pages/cost') },
  { path: '/analytics', load: () => import('./pages/analytics') },
  { path: '/live', load: () => import('./pages/live') },
  { path: '/alerts', load: () => import('./pages/alerts') },
  { path: '/guardrails', load: () => import('./pages/guardrails') },
  { path: '/playground', load: () => import('./pages/playground') },
  { path: '/config', load: () => import('./pages/config') },
  { path: '/mcp', load: () => import('./pages/mcp') },
  // sprint2-pages
] as const;
const sprint2 = SPRINT2_PAGES.map((page) =>
  createRoute({
    getParentRoute: () => app,
    path: page.path,
    component: lazyRouteComponent(page.load),
  }),
);
const BUILT: readonly string[] = SPRINT2_PAGES.map((page) => page.path);

/**
 * Operator billing (cards 25.1, 25.2): one layout with the section tabs and the access check, a
 * lazy page per tab. Paths are relative to /billing.
 */
const billing = createRoute({
  getParentRoute: () => app,
  path: '/billing',
  component: lazyRouteComponent(() => import('./pages/billing/layout')),
});
const BILLING_PAGES = [
  { path: '/', load: () => import('./pages/billing/customers') },
  { path: 'payments', load: () => import('./pages/billing/payments') },
  { path: 'gift-codes', load: () => import('./pages/billing/gift-codes') },
  { path: 'settings', load: () => import('./pages/billing/settings') },
  { path: 'pricing', load: () => import('./pages/billing/pricing') },
  { path: 'plans', load: () => import('./pages/billing/plans') },
  { path: 'invoices', load: () => import('./pages/billing/invoices') },
  { path: 'profit', load: () => import('./pages/billing/profit') },
  // billing-pages
] as const;
const billingPages = BILLING_PAGES.map((page) =>
  createRoute({
    getParentRoute: () => billing,
    path: page.path,
    component: lazyRouteComponent(page.load),
  }),
);

const sections = NAV.filter(
  (n) =>
    ![
      '/',
      '/health',
      '/logs',
      '/providers',
      '/keys',
      '/models',
      '/organization',
      '/guides',
      '/billing',
    ].includes(n.to) && !BUILT.includes(n.to),
).map((n) =>
  createRoute({
    getParentRoute: () => app,
    path: n.to,
    component: () => <Placeholder page={n.key} />,
  }),
);

export const routeTree = root.addChildren([
  login,
  invite,
  setup,
  app.addChildren([
    overview,
    account,
    health,
    logs,
    providers,
    keys,
    models,
    organization,
    guides,
    ...sprint2,
    billing.addChildren(billingPages),
    ...sections,
  ]),
]);

export function makeRouter(history?: Parameters<typeof createRouter>[0]['history']) {
  return createRouter({ routeTree, defaultPreload: 'intent', ...(history ? { history } : {}) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
