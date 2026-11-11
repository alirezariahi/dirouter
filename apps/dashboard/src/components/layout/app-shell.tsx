/** Main layout: sidebar on the «start» side (right in RTL, left in LTR) and top bar. */
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { logout, useSession } from '../../lib/session';
import { useSettings } from '../../settings';
import { Button } from '../ui/button';
import { lazy, Suspense } from 'react';

import { useCommandPalette } from './use-command-palette';

const CommandPalette = lazy(() => import('./command-palette'));
import { NAV } from './nav';

export function AppShell() {
  const { t } = useTranslation();
  const s = useSettings();
  const palette = useCommandPalette();
  const user = useSession();
  const navigate = useNavigate();
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-e border-border bg-surface md:block">
        <div className="px-5 py-4">
          <p className="text-lg font-bold">{t('app.name')}</p>
          <p className="text-xs text-muted">{t('app.tagline')}</p>
        </div>
        <nav aria-label="main" className="flex flex-col gap-0.5 px-3">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: n.to === '/' }}
              className="rounded-md px-3 py-2 text-sm hover:bg-border/50 data-[status=active]:bg-brand/10 data-[status=active]:font-medium data-[status=active]:text-brand"
            >
              {t(`nav.${n.key}`)}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2">
          <Button
            variant="outline"
            className="me-auto w-64 justify-between text-muted"
            onClick={() => {
              palette.setOpen(true);
            }}
          >
            <span>{t('topbar.search')}</span>
            <kbd className="rounded border border-border px-1.5 text-xs" dir="ltr">
              ⌘K
            </kbd>
          </Button>
          <label className="sr-only" htmlFor="lang">
            {t('topbar.language')}
          </label>
          <select
            id="lang"
            value={s.lang}
            onChange={(e) => {
              s.setLang(e.target.value === 'en' ? 'en' : 'fa');
            }}
            className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
          >
            <option value="fa">فارسی</option>
            <option value="en">English</option>
          </select>
          <label className="sr-only" htmlFor="calendar">
            {t('topbar.calendar')}
          </label>
          <select
            id="calendar"
            value={s.calendar}
            onChange={(e) => {
              s.setCalendar(e.target.value === 'gregory' ? 'gregory' : 'persian');
            }}
            className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
          >
            <option value="persian">{t('topbar.persian')}</option>
            <option value="gregory">{t('topbar.gregory')}</option>
          </select>
          <label className="sr-only" htmlFor="theme">
            {t('topbar.theme')}
          </label>
          <select
            id="theme"
            value={s.theme}
            onChange={(e) => {
              s.setTheme(e.target.value as 'light' | 'dark' | 'system');
            }}
            className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
          >
            <option value="system">{t('topbar.system')}</option>
            <option value="light">{t('topbar.light')}</option>
            <option value="dark">{t('topbar.dark')}</option>
          </select>
          {user ? (
            <>
              <Link to="/account" className="text-sm text-muted hover:text-fg">
                {user.name || user.email}
              </Link>
              <Button
                variant="ghost"
                onClick={() => {
                  void logout().then(() => navigate({ to: '/login' }));
                }}
              >
                {t('auth.logout')}
              </Button>
            </>
          ) : null}
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
      {palette.everOpened ? (
        <Suspense fallback={null}>
          <CommandPalette open={palette.open} onOpenChange={palette.setOpen} />
        </Suspense>
      ) : null}
    </div>
  );
}
