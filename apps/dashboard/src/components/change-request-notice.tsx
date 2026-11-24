/** Banner shown when a change was queued for a second person's approval (card 22.2). */
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CHANGE_REQUEST_EVENT } from '../lib/api';

export function ChangeRequestNotice() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<string>();
  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ summary?: string }>).detail;
      setSummary(detail.summary ?? '');
    };
    window.addEventListener(CHANGE_REQUEST_EVENT, onRequest);
    return () => {
      window.removeEventListener(CHANGE_REQUEST_EVENT, onRequest);
    };
  }, []);
  if (summary === undefined) return null;
  return (
    <div
      role="status"
      data-testid="change-request-notice"
      className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm"
    >
      <span>
        {t('s3.changes.queued')} {summary ? <strong>{summary}</strong> : null}
      </span>
      <span className="flex gap-3">
        <Link to="/security" className="underline">
          {t('s3.changes.view')}
        </Link>
        <button
          type="button"
          className="text-muted underline"
          onClick={() => {
            setSummary(undefined);
          }}
        >
          {t('s3.changes.dismiss')}
        </button>
      </span>
    </div>
  );
}
