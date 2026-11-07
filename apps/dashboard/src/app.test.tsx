/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { i18n, setupI18n } from './i18n';
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
