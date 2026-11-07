import './styles.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { setupI18n } from './i18n';
import { ApiError } from './lib/api';
import { makeRouter } from './router';
import { SettingsProvider } from './settings';

setupI18n();
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // خطای دسترسی یا اعتبارسنجی با تکرار درست نمی‌شود.
      retry: (count, error) => count < 2 && !(error instanceof ApiError && error.status < 500),
    },
  },
});
const router = makeRouter();

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
createRoot(el).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <RouterProvider router={router} />
      </SettingsProvider>
    </QueryClientProvider>
  </StrictMode>,
);
