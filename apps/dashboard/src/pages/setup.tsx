/**
 * Setup wizard (card 7.2): 1) organization and owner 2) first provider (optional) 3) first key
 * virtual. Goal: under 3 minutes from install to first key.
 */
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, FormError } from '../components/ui/field';
import { API_URL } from '../config';
import { api } from '../lib/api';
import { text, type SubmitEvent } from '../lib/form';
import { errorMessage, fieldError } from '../lib/errors';
import { currentOrg, setup } from '../lib/session';

const PROVIDER_TYPES = [
  'openai',
  'anthropic',
  'gemini',
  'azure-openai',
  'openai-compatible',
] as const;

export default function SetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<(typeof PROVIDER_TYPES)[number]>('openai');
  const [key, setKey] = useState<string>();
  const [copied, setCopied] = useState(false);
  const gatewayUrl = API_URL.replace(/^(https?:\/\/)admin\./, '$1api.').replace(/\/api\/v1$/, '');

  const run = (fn: (form: FormData) => Promise<void>) => async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await fn(new FormData(e.currentTarget));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const org = () => currentOrg()?.id ?? '';

  const step1 = run(async (f) => {
    await setup({
      organizationName: text(f, 'organizationName'),
      name: text(f, 'name'),
      email: text(f, 'email'),
      password: text(f, 'password'),
    });
    setStep(2);
  });
  const step2 = run(async (f) => {
    const baseUrl = text(f, 'baseUrl').trim();
    await api(`/orgs/${org()}/providers`, {
      method: 'POST',
      body: {
        name: text(f, 'providerName'),
        type,
        ...(baseUrl ? { baseUrl } : {}),
        credentials: [{ name: 'default', secret: text(f, 'secret') }],
      },
    });
    setStep(3);
  });
  const step3 = run(async (f) => {
    const project = await api<{ id: string }>(`/orgs/${org()}/projects`, {
      method: 'POST',
      body: { name: 'Default' },
    });
    const created = await api<{ key: string }>(`/orgs/${org()}/keys`, {
      method: 'POST',
      body: { name: text(f, 'keyName'), projectId: project.id },
    });
    setKey(created.key);
  });

  const message = error ? errorMessage(error, t) : undefined;
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <p className="text-xs text-muted">{t('setup.step', { n: step })}</p>
        <h1 className="mb-4 text-xl font-bold">{t('setup.title')}</h1>
        {step === 1 ? (
          <form onSubmit={(e) => void step1(e)} className="flex flex-col gap-3">
            <h2 className="font-medium">{t('setup.orgStep')}</h2>
            <FormError message={message} />
            <Field
              label={t('setup.organizationName')}
              name="organizationName"
              required
              error={fieldError(error, 'organizationName')}
            />
            <Field label={t('setup.name')} name="name" required autoComplete="name" />
            <Field
              label={t('auth.email')}
              name="email"
              type="email"
              required
              dir="ltr"
              autoComplete="username"
              error={fieldError(error, 'email')}
            />
            <Field
              label={t('auth.newPassword')}
              name="password"
              type="password"
              required
              minLength={10}
              dir="ltr"
              autoComplete="new-password"
              error={fieldError(error, 'password')}
            />
            <Button type="submit" disabled={busy}>
              {t('setup.next')}
            </Button>
          </form>
        ) : null}
        {step === 2 ? (
          <form onSubmit={(e) => void step2(e)} className="flex flex-col gap-3">
            <h2 className="font-medium">{t('setup.providerStep')}</h2>
            <FormError message={message} />
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('setup.providerType')}</span>
              <select
                value={type}
                onChange={(e) => {
                  setType(e.target.value as (typeof PROVIDER_TYPES)[number]);
                }}
                className="h-10 rounded-md border border-border bg-surface px-2"
              >
                {PROVIDER_TYPES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label={t('setup.providerName')}
              name="providerName"
              required
              defaultValue={type}
            />
            {type === 'openai-compatible' || type === 'azure-openai' ? (
              <Field
                label={t('setup.baseUrl')}
                name="baseUrl"
                type="url"
                required
                dir="ltr"
                error={fieldError(error, 'baseUrl')}
              />
            ) : null}
            <Field
              label={t('setup.apiKey')}
              name="secret"
              type="password"
              required
              dir="ltr"
              autoComplete="off"
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {t('setup.next')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setError(undefined);
                  setStep(3);
                }}
              >
                {t('setup.skip')}
              </Button>
            </div>
          </form>
        ) : null}
        {step === 3 && !key ? (
          <form onSubmit={(e) => void step3(e)} className="flex flex-col gap-3">
            <h2 className="font-medium">{t('setup.keyStep')}</h2>
            <FormError message={message} />
            <Field label={t('setup.keyName')} name="keyName" required defaultValue="my-first-key" />
            <Button type="submit" disabled={busy}>
              {t('setup.createKey')}
            </Button>
          </form>
        ) : null}
        {key ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">{t('setup.keyReady')}</p>
            <code
              data-testid="new-key"
              dir="ltr"
              className="break-all rounded-md bg-border/40 p-3 text-sm"
            >
              {key}
            </code>
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(key).then(() => {
                  setCopied(true);
                });
              }}
            >
              {copied ? t('setup.copied') : t('setup.copy')}
            </Button>
            <p className="text-sm text-muted">{t('setup.usage')}</p>
            <code dir="ltr" className="rounded-md bg-border/40 p-3 text-xs">
              {gatewayUrl}/v1
            </code>
            <Button onClick={() => void navigate({ to: '/' })}>{t('setup.finish')}</Button>
          </div>
        ) : null}
      </Card>
    </main>
  );
}
