/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from './i18n';
import { resetSessionForTests } from './lib/session';
import { makeRouter } from './router';
import { SettingsProvider } from './settings';

// jsdom این دو را ندارد (cmdk به ResizeObserver نیاز دارد).
Object.defineProperty(globalThis, 'ResizeObserver', {
  writable: true,
  value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
Object.defineProperty(Element.prototype, 'scrollIntoView', {
  writable: true,
  value: () => undefined,
});
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});

type Handler = (path: string, init: RequestInit) => { status: number; body?: unknown } | undefined;
const USER = {
  id: 'usr_1',
  email: 'o@example.com',
  name: 'Owner',
  organizations: [{ id: 'org_1', name: 'Acme', slug: 'acme', role: 'OWNER' }],
};
/** API ساختگی؛ پیش‌فرض: کاربر واردشده. */
function mockApi(handler: Handler = () => undefined) {
  const calls: { path: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
      calls.push({ path, init });
      const r =
        handler(path, init) ??
        (path === '/auth/refresh'
          ? { status: 200, body: { accessToken: 'tok' } }
          : path === '/auth/me'
            ? { status: 200, body: USER }
            : { status: 200, body: {} });
      return Promise.resolve(
        new Response(r.body === undefined ? null : JSON.stringify(r.body), {
          status: r.status,
          headers: {
            'content-type': r.status >= 400 ? 'application/problem+json' : 'application/json',
          },
        }),
      );
    }),
  );
  return calls;
}

async function renderApp(path = '/') {
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SettingsProvider>
        <RouterProvider router={router} />
      </SettingsProvider>
    </QueryClientProvider>,
  );
  await act(async () => {
    await router.load();
  });
  return router;
}

describe('dashboard shell', () => {
  afterEach(() => {
    cleanup();
  });
  beforeEach(async () => {
    localStorage.clear();
    resetSessionForTests();
    mockApi();
    setupI18n('fa');
    await i18n.changeLanguage('fa');
  });

  it('starts in Persian, right to left', async () => {
    await renderApp();
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('fa');
    expect(await screen.findByRole('link', { name: 'نمای کلی' })).toBeTruthy();
  });

  it('switching the language flips the page direction and remembers it', async () => {
    await renderApp();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('زبان'), { target: { value: 'en' } });
    });
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
    expect(await screen.findByRole('link', { name: 'Overview' })).toBeTruthy();
    expect(localStorage.getItem('dirouter.lang')).toBe('en');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'fa' } });
    });
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('switches to the dark theme', async () => {
    await renderApp();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('تم'), { target: { value: 'dark' } });
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('opens the command palette with Ctrl+K and navigates', async () => {
    const router = await renderApp();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    const input = await screen.findByPlaceholderText('به کجا برویم؟');
    expect(input).toBeTruthy();
    await act(async () => {
      fireEvent.click(await screen.findByRole('option', { name: 'لاگ درخواست‌ها' }));
    });
    expect(router.state.location.pathname).toBe('/logs');
  });

  it('shows a not-found state for unknown pages', async () => {
    await renderApp('/does-not-exist');
    expect(await screen.findByText('صفحه پیدا نشد')).toBeTruthy();
  });
});

describe('sign-in and setup', () => {
  afterEach(() => {
    cleanup();
  });
  beforeEach(async () => {
    localStorage.clear();
    resetSessionForTests();
    setupI18n('fa');
    await i18n.changeLanguage('fa');
  });

  const signedOut =
    (setupRequired: boolean, extra: Handler = () => undefined): Handler =>
    (path, init) =>
      extra(path, init) ??
      (path === '/auth/refresh'
        ? { status: 401, body: { status: 401, code: 'unauthenticated' } }
        : path === '/auth/setup'
          ? { status: 200, body: { required: setupRequired } }
          : undefined);

  it('sends a signed-out visitor to the login page, or to setup on a fresh install', async () => {
    mockApi(signedOut(false));
    let router = await renderApp('/keys');
    expect(router.state.location.pathname).toBe('/login');
    cleanup();
    resetSessionForTests();
    mockApi(signedOut(true));
    router = await renderApp('/');
    expect(router.state.location.pathname).toBe('/setup');
  });

  it('shows precise Persian errors for a wrong password and a locked account', async () => {
    let attempt = 0;
    mockApi(
      signedOut(false, (path) =>
        path === '/auth/login'
          ? ++attempt === 1
            ? { status: 401, body: { status: 401, code: 'invalid_credentials' } }
            : { status: 429, body: { status: 429, code: 'login_locked' } }
          : undefined,
      ),
    );
    await renderApp('/login');
    const submit = async () => {
      fireEvent.change(await screen.findByLabelText('ایمیل'), {
        target: { value: 'o@example.com' },
      });
      fireEvent.change(screen.getByLabelText('رمز عبور'), { target: { value: 'wrong-password' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'ورود' }));
      });
    };
    await submit();
    expect((await screen.findByRole('alert')).textContent).toBe('ایمیل یا رمز عبور درست نیست.');
    await submit();
    expect((await screen.findByRole('alert')).textContent).toContain('موقتاً قفل شده');
  });

  it('logs in and lands on the overview', async () => {
    mockApi(
      signedOut(false, (path) =>
        path === '/auth/login'
          ? { status: 200, body: { accessToken: 'tok' } }
          : path === '/auth/me'
            ? { status: 200, body: USER }
            : undefined,
      ),
    );
    const router = await renderApp('/login');
    fireEvent.change(await screen.findByLabelText('ایمیل'), { target: { value: 'o@example.com' } });
    fireEvent.change(screen.getByLabelText('رمز عبور'), {
      target: { value: 'a-long-enough-password' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ورود' }));
    });
    await act(async () => {
      await router.load();
    });
    expect(router.state.location.pathname).toBe('/');
    expect(await screen.findByText('Owner')).toBeTruthy();
  });

  it('the setup wizard goes from organization to the first virtual key', async () => {
    const calls = mockApi(
      signedOut(true, (path, init) => {
        if (path === '/auth/setup' && init.method === 'POST')
          return { status: 201, body: { accessToken: 'tok' } };
        if (path === '/auth/me') return { status: 200, body: USER };
        if (path === '/orgs/org_1/projects') return { status: 201, body: { id: 'prj_1' } };
        if (path === '/orgs/org_1/keys')
          return { status: 201, body: { key: 'dr-abcdefgh-SECRET' } };
        return undefined;
      }),
    );
    await renderApp('/setup');
    fireEvent.change(await screen.findByLabelText('نام سازمان'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText('نام شما'), { target: { value: 'Owner' } });
    fireEvent.change(screen.getByLabelText('ایمیل'), { target: { value: 'o@example.com' } });
    fireEvent.change(screen.getByLabelText('رمز تازه (حداقل ۱۰ کاراکتر)'), {
      target: { value: 'a-long-enough-password' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ادامه' }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'فعلاً رد شو' }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'ساخت کلید' }));
    });
    expect((await screen.findByTestId('new-key')).textContent).toBe('dr-abcdefgh-SECRET');
    const setupCall = calls.find((c) => c.path === '/auth/setup' && c.init.method === 'POST');
    expect(JSON.parse(setupCall?.init.body as string)).toMatchObject({
      organizationName: 'Acme',
      email: 'o@example.com',
    });
  });
});
