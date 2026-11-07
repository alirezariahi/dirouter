/** مسیرها (TanStack Router، code-based) با بارگذاری تنبل صفحه‌ها برای bundle کوچک. */
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  lazyRouteComponent,
} from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { AppShell } from './components/layout/app-shell';
import { NAV } from './components/layout/nav';
import { Empty, ErrorState, Loading } from './components/ui/states';
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
  component: AppShell,
  notFoundComponent: NotFound,
  pendingComponent: () => <Loading />,
  errorComponent: ({ error, reset }) => <ErrorState error={error} onRetry={reset} />,
});

const overview = createRoute({
  getParentRoute: () => root,
  path: '/',
  component: lazyRouteComponent(() => import('./pages/overview')),
});

const sections = NAV.filter((n) => n.to !== '/').map((n) =>
  createRoute({
    getParentRoute: () => root,
    path: n.to,
    component: () => <Placeholder page={n.key} />,
  }),
);

export const routeTree = root.addChildren([overview, ...sections]);

export function makeRouter(history?: Parameters<typeof createRouter>[0]['history']) {
  return createRouter({ routeTree, defaultPreload: 'intent', ...(history ? { history } : {}) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
