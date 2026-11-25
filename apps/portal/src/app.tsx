/** Layout and routes. `/` and the auth pages are public; `/app/*` needs a session. */
import { useEffect, useState } from 'react';

import { useI18n } from './lib/i18n';
import { Link } from './lib/link';
import { navigate, usePath } from './lib/router';
import { me, restore, signOut } from './lib/session';
import { AuthPage, OAuthCallbackPage } from './pages/auth';
import { BillingPage } from './pages/billing';
import { HomePage } from './pages/home';
import { InvoicesPage } from './pages/invoices';
import { KeysPage } from './pages/keys';
import { MarketPage } from './pages/market';
import { VerifyEmailPage, VerifyNotice } from './pages/verify';
import { UsagePage } from './pages/usage';

export function App() {
  const { t, toggle } = useI18n();
  const path = usePath();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(me());
  const signedIn = () => {
    setUser(me());
  };

  useEffect(() => {
    void restore()
      .then(setUser)
      .finally(() => {
        setReady(true);
      });
  }, []);
  useEffect(() => {
    if (ready && !user && path.startsWith('/app')) navigate('/signin', true);
  }, [ready, user, path]);

  const nav = user
    ? [
        ['/app', t.home],
        ['/app/keys', t.keys],
        ['/app/usage', t.usage],
        ['/app/billing', t.billing],
        ['/app/invoices', t.invoices],
        ['/', t.market],
      ]
    : [['/', t.market]];

  let page;
  if (path === '/signin') page = <AuthPage mode="signin" onSignedIn={signedIn} />;
  else if (path === '/signup') page = <AuthPage mode="signup" onSignedIn={signedIn} />;
  else if (path === '/oauth/callback') page = <OAuthCallbackPage onSignedIn={signedIn} />;
  else if (path === '/verify-email')
    page = !ready ? null : <VerifyEmailPage onVerified={signedIn} />;
  else if (path.startsWith('/app'))
    page =
      !ready || !user ? null : (
        <>
          <VerifyNotice />
          {path === '/app/keys' ? (
            <KeysPage verified={user.emailVerified} />
          ) : path === '/app/billing' ? (
            <BillingPage />
          ) : path === '/app/usage' ? (
            <UsagePage />
          ) : path === '/app/invoices' ? (
            <InvoicesPage />
          ) : (
            <HomePage />
          )}
        </>
      );
  else page = <MarketPage signedIn={Boolean(user)} />;

  return (
    <div className="min-h-screen bg-stone-50 text-stone-800">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-6">
            <Link href={user ? '/app' : '/'} className="text-lg font-bold text-teal-800">
              {t.brand}
            </Link>
            <nav className="flex gap-4 text-sm">
              {nav.map(([href = '', label]) => (
                <Link
                  key={href}
                  href={href}
                  className={
                    path === href
                      ? 'font-medium text-stone-900'
                      : 'text-stone-500 hover:text-stone-900'
                  }
                >
                  {label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <button type="button" className="text-stone-500 hover:text-stone-900" onClick={toggle}>
              {t.language}
            </button>
            {user ? (
              <button
                type="button"
                className="text-stone-500 hover:text-stone-900"
                onClick={() =>
                  void signOut().then(() => {
                    setUser(undefined);
                    navigate('/');
                  })
                }
              >
                {t.signOut}
              </button>
            ) : (
              <Link href="/signin" className="font-medium text-teal-700 hover:underline">
                {t.signIn}
              </Link>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{page}</main>
    </div>
  );
}
