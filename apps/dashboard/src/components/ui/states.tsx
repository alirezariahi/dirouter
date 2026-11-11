/** Consistent loading, empty and error states across all pages (card 7.1). */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../lib/api';
import { Button } from './button';

export function Loading({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-3 p-8 text-muted">
      <span className="size-4 animate-spin rounded-full border-2 border-border border-t-brand" />
      {label ?? t('state.loading')}
    </div>
  );
}

export function Empty({ title, children }: { title?: string; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2 p-10 text-center">
      <p className="font-medium">{title ?? t('state.empty')}</p>
      {children ? <div className="text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  const requestId = error instanceof ApiError ? error.problem.requestId : undefined;
  return (
    <div role="alert" className="flex flex-col items-center gap-3 p-10 text-center">
      <p className="font-medium text-danger">{t('state.error')}</p>
      <p className="text-sm text-muted">{message}</p>
      {requestId ? <code className="text-xs text-muted">{requestId}</code> : null}
      {onRetry ? (
        <Button variant="outline" onClick={onRetry}>
          {t('state.retry')}
        </Button>
      ) : null}
    </div>
  );
}
