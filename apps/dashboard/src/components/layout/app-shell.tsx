/** Main layout: sidebar on the «start» side (right in RTL, left in LTR) and top bar. */
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { LogOut, Search } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import { useBillingAccess } from '../../lib/billing';
import { currentOrg, logout, useSession } from '../../lib/session';
import { useSettings } from '../../settings';
import { ChangeRequestNotice } from '../change-request-notice';
import { Mark } from '../ui/mark';
import { NAV_GROUPS, visibleNav } from './nav';
import { useCommandPalette } from './use-command-palette';

const CommandPalette = lazy(() => import('./command-palette'));

const quietSelect =
  'h-8 cursor-pointer rounded-lg border border-transparent bg-transparent px-2 text-[13px] text-fg-2 hover:bg-surface-2 hover:text-fg';

export function AppShell() {
  const { t } = useTranslation();
  const s = useSettings();
  const palette = useCommandPalette();
  const user = useSession();
  const org = currentOrg();
  const navigate = useNavigate();
  const nav = visibleNav(useBillingAccess().visible);
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-62 shrink-0 flex-col border-e border-border bg-sidebar md:flex">
        <div className="flex h-14 items-center gap-2.5 px-4">
          <Mark />
          <div className="min-w-0">
            <p className="text-[15px] leading-5 font-semibold">{t('app.name')}</p>
            <p className="truncate text-[11px] leading-4 text-muted">
              {org?.name ?? t('app.tagline')}
            </p>
          </div>
        </div>
        <nav aria-label="main" className="flex-1 overflow-y-auto px-3 pb-4">
          {NAV_GROUPS.map((group) => (
            <div key={group}>
              <p className="px-2 pt-5 pb-2 text-xs text-muted">{t(`navGroup.${group}`)}</p>
              <div className="flex flex-col gap-0.5">
                {nav
                  .filter((n) => n.group === group)
                  .map((n) => (
                    <Link
                      key={n.to}
                      to={n.to}
                      activeOptions={{ exact: n.to === '/' }}
                      className="group flex h-8.5 items-center gap-2.5 rounded-lg px-2 text-[13.5px] text-fg-2 transition-colors duration-150 hover:bg-fg/5 hover:text-fg data-[status=active]:bg-surface data-[status=active]:font-medium data-[status=active]:text-fg data-[status=active]:shadow-[0_0_0_1px_var(--color-border)] dark:data-[status=active]:bg-fg/8 dark:data-[status=active]:shadow-none"
                    >
                      <n.icon
                        aria-hidden
                        className="size-4 shrink-0 text-muted transition-colors duration-150 group-hover:text-fg-2 group-data-[status=active]:text-brand"
                        strokeWidth={1.5}
                      />
                      <span className="truncate">{t(`nav.${n.key}`)}</span>
                    </Link>
                  ))}
              </div>
            </div>
          ))}
        </nav>
        {user ? (
          <div className="flex items-center gap-2.5 border-t border-border p-3">
            <Link
              to="/account"
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1 transition-colors duration-150 hover:bg-fg/5"
            >
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[13px] font-medium text-fg-2 uppercase"
              >
                {(user.name || user.email).slice(0, 1)}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] leading-4 font-medium">
                  {user.name || user.email}
                </span>
                <span className="block truncate text-[11px] leading-4 text-muted" dir="ltr">
                  {user.email}
                </span>
              </span>
            </Link>
            <button
              type="button"
              title={t('auth.logout')}
              aria-label={t('auth.logout')}
              onClick={() => {
                void logout().then(() => navigate({ to: '/login' }));
              }}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-fg/5 hover:text-fg"
            >
              <LogOut aria-hidden className="size-4 rtl:-scale-x-100" strokeWidth={1.5} />
            </button>
          </div>
        ) : null}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-1 border-b border-border bg-bg/85 px-6 backdrop-blur">
          <button
            type="button"
            onClick={() => {
              palette.setOpen(true);
            }}
            className="me-auto flex h-9 w-72 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-[13px] text-muted transition-colors duration-150 hover:border-fg/20 hover:text-fg-2"
          >
            <Search aria-hidden className="size-4" strokeWidth={1.5} />
            <span className="flex-1 truncate text-start">{t('topbar.search')}</span>
            <kbd
              className="rounded border border-border bg-surface-2 px-1.5 text-[11px] leading-5"
              dir="ltr"
            >
              ⌘K
            </kbd>
          </button>
          <label className="sr-only" htmlFor="lang">
            {t('topbar.language')}
          </label>
          <select
            id="lang"
            value={s.lang}
            onChange={(e) => {
              s.setLang(e.target.value === 'fa' ? 'fa' : 'en');
            }}
            className={quietSelect}
          >
            <option value="en">English</option>
            <option value="fa">فارسی</option>
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
            className={quietSelect}
          >
            <option value="gregory">{t('topbar.gregory')}</option>
            <option value="persian">{t('topbar.persian')}</option>
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
            className={quietSelect}
          >
            <option value="system">{t('topbar.system')}</option>
            <option value="light">{t('topbar.light')}</option>
            <option value="dark">{t('topbar.dark')}</option>
          </select>
        </header>
        <main className="mx-auto w-full max-w-[1480px] flex-1 px-6 py-6 lg:px-8">
          <ChangeRequestNotice />
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
