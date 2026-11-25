/**
 * Request policy of a model or an alias (sprint 5, epic 31): automatic prompt-cache breakpoints
 * (card 31.3). The value is sent as `requestPolicy`; an empty policy is sent as `null`.
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import type { RequestPolicy } from '../lib/request-policy';

export function RequestPolicyFields({
  value,
  onChange,
}: {
  value: RequestPolicy;
  onChange: (next: RequestPolicy) => void;
}) {
  const { t } = useTranslation();
  const ttlId = useId();
  return (
    <fieldset className="flex flex-col gap-2 rounded border border-border p-3 text-sm">
      <legend className="px-1 font-medium">{t('shaping.policy.legend')}</legend>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value.autoCache === true}
          onChange={(event) => {
            const { autoCacheTtl, ...rest } = value;
            onChange(
              event.target.checked
                ? { ...rest, autoCache: true, ...(autoCacheTtl ? { autoCacheTtl } : {}) }
                : rest,
            );
          }}
        />
        <span>{t('shaping.policy.autoCache')}</span>
      </label>
      {value.autoCache ? (
        <label htmlFor={ttlId} className="flex items-center gap-2">
          <span>{t('shaping.policy.ttl')}</span>
          <select
            id={ttlId}
            value={value.autoCacheTtl ?? ''}
            onChange={(event) => {
              const ttl = event.target.value;
              const { autoCacheTtl: _old, ...rest } = value;
              onChange(ttl === '5m' || ttl === '1h' ? { ...rest, autoCacheTtl: ttl } : rest);
            }}
            className="h-8 rounded border border-border bg-surface px-2"
          >
            <option value="">{t('shaping.policy.ttlDefault')}</option>
            <option value="5m">5m</option>
            <option value="1h">1h</option>
          </select>
        </label>
      ) : null}
      <p className="text-xs text-muted">{t('shaping.policy.autoCacheHint')}</p>
    </fieldset>
  );
}
