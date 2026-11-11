import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, FormError } from '../components/ui/field';
import { ErrorState, Loading } from '../components/ui/states';
import { API_URL } from '../config';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { text, type SubmitEvent } from '../lib/form';
import { currentOrg, useSession } from '../lib/session';

type ToolId =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'cline'
  | 'roo'
  | 'continue'
  | 'aider'
  | 'openai-python'
  | 'openai-node'
  | 'anthropic'
  | 'curl';

interface Project {
  id: string;
  name: string;
}
interface VirtualKey {
  id: string;
  name: string;
  prefix: string;
  projectId: string;
  state: 'active' | 'rotating' | 'expired' | 'revoked';
}

const TOOLS: { id: ToolId; name: string }[] = [
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'cline', name: 'Cline' },
  { id: 'roo', name: 'Roo Code' },
  { id: 'continue', name: 'Continue' },
  { id: 'aider', name: 'Aider' },
  { id: 'openai-python', name: 'OpenAI Python' },
  { id: 'openai-node', name: 'OpenAI Node.js' },
  { id: 'anthropic', name: 'Anthropic SDK' },
  { id: 'curl', name: 'curl' },
];

const gatewayUrl = API_URL.replace(/^(https?:\/\/)admin\./, '$1api.').replace(/\/api\/v1$/, '');

/** All secrets are interpolated into an in-memory string; none are written to storage. */
function toolSnippet(tool: ToolId, key: string, model = 'gpt-4.1'): string {
  const openaiBase = `${gatewayUrl}/v1`;
  switch (tool) {
    case 'claude-code':
      return `export ANTHROPIC_BASE_URL="${gatewayUrl}"\nexport ANTHROPIC_AUTH_TOKEN="${key}"\nclaude`;
    case 'codex':
      return `export DIROUTER_API_KEY="${key}"\n\n# ~/.codex/config.toml\nmodel_provider = "dirouter"\nmodel = "${model}"\n[model_providers.dirouter]\nname = "DiRouter"\nbase_url = "${openaiBase}"\nenv_key = "DIROUTER_API_KEY"\nwire_api = "chat"`;
    case 'cursor':
      return JSON.stringify({ openai: { apiKey: key, baseUrl: openaiBase } }, null, 2);
    case 'cline':
    case 'roo':
      return JSON.stringify(
        {
          apiProvider: 'openai',
          openAiBaseUrl: openaiBase,
          openAiApiKey: key,
          openAiModelId: model,
        },
        null,
        2,
      );
    case 'continue':
      return `models:\n  - name: DiRouter\n    provider: openai\n    model: ${model}\n    apiBase: ${openaiBase}\n    apiKey: ${key}`;
    case 'aider':
      return `export OPENAI_API_BASE="${openaiBase}"\nexport OPENAI_API_KEY="${key}"\naider --model openai/${model}`;
    case 'openai-python':
      return `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${openaiBase}",\n    api_key="${key}",\n)\nresponse = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(response.choices[0].message.content)`;
    case 'openai-node':
      return `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${openaiBase}",\n  apiKey: "${key}",\n});\nconst response = await client.chat.completions.create({\n  model: "${model}",\n  messages: [{ role: "user", content: "Hello!" }],\n});\nconsole.log(response.choices[0].message.content);`;
    case 'anthropic':
      return `from anthropic import Anthropic\n\nclient = Anthropic(\n    base_url="${gatewayUrl}",\n    api_key="${key}",\n)\nmessage = client.messages.create(\n    model="claude-sonnet-4-5",\n    max_tokens=1024,\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(message.content)`;
    case 'curl':
      return `curl ${openaiBase}/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "${model}",\n    "messages": [{"role": "user", "content": "Hello!"}]\n  }'`;
  }
}

const inputClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';

export default function GuidesPage() {
  const { t } = useTranslation();
  const session = useSession();
  const org = currentOrg();
  const base = `/orgs/${org?.id ?? ''}`;
  const role = session?.organizations.find((item) => item.id === org?.id)?.role;
  const canCreateKey = role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER';
  const [tool, setTool] = useState<ToolId>('claude-code');
  const [selectedKey, setSelectedKey] = useState('');
  const [enteredKey, setEnteredKey] = useState('');
  const [projectId, setProjectId] = useState('');
  const [model, setModel] = useState('gpt-4.1');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>();
  const [copied, setCopied] = useState(false);

  const keys = useQuery({
    queryKey: ['guides', org?.id, 'keys'],
    queryFn: () => api<VirtualKey[]>(`${base}/keys`),
    enabled: Boolean(org),
  });
  const projects = useQuery({
    queryKey: ['guides', org?.id, 'projects'],
    queryFn: () => api<Project[]>(`${base}/projects`),
    enabled: Boolean(org),
  });

  const usableKeys = keys.data?.filter((key) => key.state === 'active' || key.state === 'rotating');
  const secret = enteredKey;
  const snippet = toolSnippet(tool, secret || 'YOUR_DIROUTER_KEY', model);

  if (keys.isPending || projects.isPending) return <Loading />;
  const failed = keys.isError ? keys : projects.isError ? projects : undefined;
  if (failed)
    return (
      <ErrorState
        error={failed.error}
        onRetry={() => {
          void failed.refetch();
        }}
      />
    );

  async function createKey(event: SubmitEvent) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setCreating(true);
    setError(undefined);
    try {
      const created = await api<VirtualKey & { key: string }>(`${base}/keys`, {
        method: 'POST',
        body: { name: text(form, 'name'), projectId: text(form, 'projectId') },
      });
      setEnteredKey(created.key);
      setSelectedKey(created.id);
      setCopied(false);
      await keys.refetch();
    } catch (err) {
      setError(err);
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold">{t('guides.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('guides.subtitle')}</p>
      </div>
      <FormError message={error ? errorMessage(error, t) : undefined} />

      <Card>
        <h2 className="mb-3 font-semibold">{t('guides.chooseKey')}</h2>
        <p className="mb-3 text-sm text-muted">{t('guides.keySafety')}</p>
        <label className="flex max-w-lg flex-col gap-1 text-sm">
          <span className="font-medium">{t('guides.existingKey')}</span>
          <select
            className={inputClass}
            value={selectedKey}
            onChange={(event) => {
              setSelectedKey(event.target.value);
              setEnteredKey('');
              setCopied(false);
            }}
          >
            <option value="">{t('guides.enterKeyInstead')}</option>
            {usableKeys?.map((key) => (
              <option key={key.id} value={key.id}>
                {key.name} · {key.prefix}
              </option>
            ))}
          </select>
        </label>
        <Field
          className="mt-3 max-w-lg font-mono"
          label={t('guides.manualKey')}
          value={enteredKey}
          onChange={(event) => {
            setEnteredKey(event.target.value);
            setCopied(false);
          }}
          type="password"
          dir="ltr"
          autoComplete="off"
          placeholder="dr-…"
        />

        {canCreateKey ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium text-brand">
              {t('guides.createKey')}
            </summary>
            <form
              onSubmit={(event) => void createKey(event)}
              className="mt-3 flex flex-wrap items-end gap-3"
            >
              <Field
                label={t('guides.keyName')}
                name="name"
                defaultValue="tool-connection"
                required
              />
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('guides.project')}</span>
                <select
                  className={inputClass}
                  name="projectId"
                  required
                  value={projectId || projects.data?.[0]?.id || ''}
                  onChange={(event) => {
                    setProjectId(event.target.value);
                  }}
                >
                  {!projects.data?.length ? (
                    <option value="">{t('guides.noProjects')}</option>
                  ) : null}
                  {projects.data?.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" disabled={creating || !projects.data?.length}>
                {creating ? t('guides.creating') : t('guides.createKey')}
              </Button>
            </form>
          </details>
        ) : null}
        {enteredKey && selectedKey ? (
          <div className="mt-3 rounded-md bg-brand/10 p-3">
            <p className="mb-2 text-sm">{t('guides.newKeyOnce')}</p>
            <code
              className="block break-all font-mono text-sm"
              dir="ltr"
              data-testid="guide-new-key"
            >
              {enteredKey}
            </code>
          </div>
        ) : null}
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(12rem,1fr)_minmax(0,3fr)]">
        <Card className="p-2">
          <h2 className="px-2 py-2 text-sm font-semibold">{t('guides.tools')}</h2>
          <div role="tablist" aria-label={t('guides.tools')} className="flex flex-col gap-1">
            {TOOLS.map((item) => (
              <button
                key={item.id}
                id={`guide-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={tool === item.id}
                aria-controls="guide-snippet"
                onClick={() => {
                  setTool(item.id);
                  setCopied(false);
                }}
                className={`rounded-md px-3 py-2 text-start text-sm ${tool === item.id ? 'bg-brand text-brand-fg' : 'hover:bg-surface-2'}`}
              >
                {item.name}
              </button>
            ))}
          </div>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold">{TOOLS.find((item) => item.id === tool)?.name}</h2>
          <p className="mt-2 text-sm leading-7 text-muted">
            {t(`guides.tools.${tool}.description`)}
          </p>
          <label className="mt-4 flex max-w-sm flex-col gap-1 text-sm">
            <span className="font-medium">{t('guides.model')}</span>
            <input
              className={inputClass}
              dir="ltr"
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                setCopied(false);
              }}
            />
          </label>
          <div className="mt-4 flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{t('guides.snippet')}</span>
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(snippet).then(() => {
                  setCopied(true);
                  setEnteredKey('');
                  setSelectedKey('');
                });
              }}
            >
              {copied ? t('guides.copied') : t('guides.copy')}
            </Button>
          </div>
          <pre
            id="guide-snippet"
            role="tabpanel"
            aria-labelledby={`guide-tab-${tool}`}
            className="mt-2 overflow-x-auto rounded-md bg-border/40 p-4 text-sm leading-6"
            dir="ltr"
            data-testid="guide-snippet"
          >
            <code>{snippet}</code>
          </pre>
          {!secret ? (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
              {t('guides.addSecretHint')}
            </p>
          ) : null}
        </Card>
      </div>
    </section>
  );
}
