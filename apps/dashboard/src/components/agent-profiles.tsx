/**
 * Agent profiles (card 20.5): saved coding-agent setups. Preview shows the generated files with a
 * placeholder key; setup creates a dedicated key and returns the files and an installer with it,
 * held only in memory and shown once.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { text, type SubmitEvent } from '../lib/form';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Field, FormError } from './ui/field';

const TOOLS = [
  ['claude-code', 'Claude Code'],
  ['codex', 'Codex'],
  ['opencode', 'OpenCode'],
  ['gemini-cli', 'Gemini CLI'],
  ['aider', 'Aider'],
  ['env', 'Environment variables'],
] as const;

interface Profile {
  id: string;
  name: string;
  tool: string;
  mainModel: string;
  fastModel: string;
}
interface Generated {
  files: { name: string; content: string; description: string }[];
  script: string;
  key?: string;
}

const selectClass = 'h-10 rounded-lg border border-border bg-surface px-3 text-sm';

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/x-shellscript' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function AgentProfiles({
  base,
  projects,
  canWrite,
}: {
  base: string;
  projects: { id: string; name: string }[];
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<Generated & { profile: string }>();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [copied, setCopied] = useState(false);
  const profiles = useQuery({
    queryKey: ['agent-profiles', base],
    queryFn: () => api<Profile[]>(`${base}/agent-profiles`),
  });

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function create(event: SubmitEvent) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const target = event.currentTarget;
    const fastModel = text(form, 'fastModel');
    void run(async () => {
      await api(`${base}/agent-profiles`, {
        method: 'POST',
        body: {
          name: text(form, 'name'),
          tool: text(form, 'tool'),
          mainModel: text(form, 'mainModel'),
          ...(fastModel ? { fastModel } : {}),
          options: { disableNonessentialTraffic: form.get('quiet') === 'on' },
        },
      });
      target.reset();
      await profiles.refetch();
    });
  }

  const show = (profile: Profile, generated: Generated) => {
    setCopied(false);
    setOutput({ ...generated, profile: profile.name });
  };

  return (
    <Card>
      <h2 className="text-lg font-semibold">{t('s3.agentProfiles.title')}</h2>
      <p className="mt-1 text-sm text-muted">{t('s3.agentProfiles.subtitle')}</p>
      <div className="mt-3">
        <FormError message={error ? errorMessage(error, t) : undefined} />
      </div>

      <ul className="mt-3 flex flex-col divide-y divide-border" data-testid="agent-profiles">
        {profiles.data?.length === 0 ? (
          <li className="py-2 text-sm text-muted">{t('s3.agentProfiles.empty')}</li>
        ) : null}
        {profiles.data?.map((profile) => (
          <li key={profile.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="text-sm">
              <span className="font-medium">{profile.name}</span>{' '}
              <span className="text-muted" dir="ltr">
                {profile.tool} · {profile.mainModel} / {profile.fastModel}
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void run(async () => {
                    show(
                      profile,
                      await api<Generated>(`${base}/agent-profiles/${profile.id}/preview`),
                    );
                  });
                }}
              >
                {t('s3.agentProfiles.preview')}
              </Button>
              {canWrite ? (
                <>
                  <Button
                    disabled={busy || !projectId}
                    onClick={() => {
                      void run(async () => {
                        const created = await api<Generated>(
                          `${base}/agent-profiles/${profile.id}/setup`,
                          { method: 'POST', body: { projectId } },
                        );
                        show(profile, created);
                      });
                    }}
                  >
                    {t('s3.agentProfiles.setup')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      void run(async () => {
                        await api(`${base}/agent-profiles/${profile.id}`, { method: 'DELETE' });
                        await profiles.refetch();
                      });
                    }}
                  >
                    {t('s3.agentProfiles.remove')}
                  </Button>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {canWrite ? (
        <>
          <label className="mt-3 flex max-w-sm flex-col gap-1 text-sm">
            <span className="font-medium">{t('s3.agentProfiles.project')}</span>
            <select
              className={selectClass}
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
              }}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={create}>
            <Field name="name" label={t('s3.agentProfiles.name')} required maxLength={100} />
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('s3.agentProfiles.tool')}</span>
              <select name="tool" className={selectClass} defaultValue="claude-code">
                {TOOLS.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <Field name="mainModel" label={t('s3.agentProfiles.mainModel')} required dir="ltr" />
            <Field
              name="fastModel"
              label={t('s3.agentProfiles.fastModel')}
              placeholder={t('s3.agentProfiles.fastHint')}
              dir="ltr"
            />
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="quiet" />
              {t('s3.agentProfiles.quiet')}
            </label>
            <div>
              <Button type="submit" disabled={busy}>
                {t('s3.agentProfiles.create')}
              </Button>
            </div>
          </form>
        </>
      ) : null}

      {output ? (
        <div className="mt-4 flex flex-col gap-3" data-testid="agent-profile-output">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{output.profile}</span>
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  download('dirouter-install.sh', output.script);
                }}
              >
                {t('s3.agentProfiles.download')}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(output.script).then(() => {
                    setCopied(true);
                  });
                }}
              >
                {copied ? t('s3.agentProfiles.copied') : t('s3.agentProfiles.copy')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setOutput(undefined);
                }}
              >
                {t('s3.agentProfiles.close')}
              </Button>
            </div>
          </div>
          {output.key ? <p className="text-sm text-warn">{t('s3.agentProfiles.keyOnce')}</p> : null}
          <p className="text-sm text-muted">{t('s3.agentProfiles.installHint')}</p>
          {output.files.map((file) => (
            <div key={file.name}>
              <p className="text-sm">
                <code dir="ltr">{file.name}</code>:{' '}
                <span className="text-muted">{file.description}</span>
              </p>
              <pre
                className="mt-1 overflow-x-auto rounded-lg bg-border/40 p-3 text-xs leading-5"
                dir="ltr"
              >
                <code>{file.content}</code>
              </pre>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
