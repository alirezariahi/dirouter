/**
 * Request policy of a model or an alias (sprint 5, epic 31): automatic prompt-cache breakpoints
 * (card 31.3) and parameter defaults, overrides and removals (card 31.4). The value is sent as
 * `requestPolicy`; an empty policy is sent as `null`.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { paramList, parseParams, type RequestPolicy } from '../lib/request-policy';

function ParamsJson({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [text, setText] = useState(() =>
    value && Object.keys(value).length > 0 ? JSON.stringify(value) : '',
  );
  const invalid = parseParams(text) === 'invalid';
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={2}
        dir="ltr"
        value={text}
        placeholder='{"temperature": 0.2}'
        aria-invalid={invalid}
        onChange={(event) => {
          setText(event.target.value);
          const parsed = parseParams(event.target.value);
          if (parsed !== 'invalid') onChange(parsed);
        }}
        className="rounded border border-border bg-surface px-2 py-1 font-mono text-xs"
      />
      {invalid ? (
        <span role="alert" className="text-xs text-danger">
          {t('shaping.policy.invalidJson')}
        </span>
      ) : null}
    </div>
  );
}

function ParamNames({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[] | undefined;
  onChange: (next: string[]) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span>{label}</span>
      <input
        id={id}
        dir="ltr"
        defaultValue={(value ?? []).join(', ')}
        placeholder="top_k, presence_penalty"
        onChange={(event) => {
          onChange(paramList(event.target.value));
        }}
        className="h-8 rounded border border-border bg-surface px-2 font-mono text-xs"
      />
    </label>
  );
}

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
      <div className="grid gap-2 md:grid-cols-2">
        <ParamsJson
          label={t('shaping.policy.defaults')}
          value={value.defaults}
          onChange={(defaults) => {
            onChange({ ...value, defaults });
          }}
        />
        <ParamsJson
          label={t('shaping.policy.overrides')}
          value={value.overrides}
          onChange={(overrides) => {
            onChange({ ...value, overrides });
          }}
        />
        <ParamNames
          label={t('shaping.policy.drop')}
          value={value.drop}
          onChange={(drop) => {
            onChange({ ...value, drop });
          }}
        />
        <ParamNames
          label={t('shaping.policy.unsupported')}
          value={value.unsupported}
          onChange={(unsupported) => {
            onChange({ ...value, unsupported });
          }}
        />
      </div>
      <p className="text-xs text-muted">{t('shaping.policy.paramsHint')}</p>
    </fieldset>
  );
}
