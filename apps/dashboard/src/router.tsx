/**
 * مسیرها (TanStack Router، code-based). /login و /setup عمومی‌اند؛ بقیه زیر layout محافظت‌شده
 * که اول نشست را با refresh بازیابی می‌کند و در نبودش به /setup (اگر هنوز کاربری نیست) یا
 * /login می‌فرستد. صفحه‌ها lazy هستند تا bundle اولیه کوچک بماند.
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
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- الگوی redirect در TanStack Router
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
const sections = NAV.filter((n) => n.to !== '/').map((n) =>
  createRoute({
    getParentRoute: () => app,
    path: n.to,
    component: () => <Placeholder page={n.key} />,
  }),
);

export const routeTree = root.addChildren([
  login,
  setup,
  app.addChildren([overview, account, ...sections]),
]);

export function makeRouter(history?: Parameters<typeof createRouter>[0]['history']) {
  return createRouter({ routeTree, defaultPreload: 'intent', ...(history ? { history } : {}) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
