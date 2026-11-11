import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, FormError } from '../components/ui/field';
import { ErrorState, Loading } from '../components/ui/states';
import { api } from '../lib/api';
import { errorMessage, fieldError } from '../lib/errors';
import { text, type SubmitEvent } from '../lib/form';
import { currentOrg, useSession } from '../lib/session';

type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
interface Organization {
  id: string;
  name: string;
  slug: string;
  role: Role;
}
interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: string;
}
interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}
interface Team {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}
interface Project extends Team {
  teamId: string | null;
}
interface CreatedInvitation extends Invitation {
  token: string;
  url: string;
}

const ROLES: Role[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];
const rank: Record<Role, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
const inputClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';

export default function OrganizationPage() {
  const { t } = useTranslation();
  const user = useSession();
  const [selectedOrg, setSelectedOrg] = useState(currentOrg()?.id);
  const membership = user?.organizations.find((item) => item.id === selectedOrg) ?? currentOrg();
  const orgId = membership?.id;
  const role = membership?.role;
  const base = `/orgs/${orgId ?? ''}`;
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<string>();
  const [invitationUrl, setInvitationUrl] = useState<string>();
  const [copied, setCopied] = useState(false);

  const enabled = Boolean(orgId);
  const organization = useQuery({
    queryKey: ['organization', orgId, 'details'],
    queryFn: () => api<Organization>(base),
    enabled,
  });
  const members = useQuery({
    queryKey: ['organization', orgId, 'members'],
    queryFn: () => api<Member[]>(`${base}/members`),
    enabled,
  });
  const invitations = useQuery({
    queryKey: ['organization', orgId, 'invitations'],
    queryFn: () => api<Invitation[]>(`${base}/invitations`),
    enabled,
  });
  const teams = useQuery({
    queryKey: ['organization', orgId, 'teams'],
    queryFn: () => api<Team[]>(`${base}/teams`),
    enabled,
  });
  const projects = useQuery({
    queryKey: ['organization', orgId, 'projects'],
    queryFn: () => api<Project[]>(`${base}/projects`),
    enabled,
  });

  const mutation = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['organization', orgId] });
    },
    onError: setError,
  });

  async function perform(action: () => Promise<unknown>, message = t('organization.saved')) {
    setError(undefined);
    setNotice(undefined);
    try {
      await mutation.mutateAsync(action);
      setNotice(message);
    } catch {
      // The mutation exposes the translated API error in the shared alert.
    }
  }

  const submit =
    (action: (form: FormData, element: HTMLFormElement) => Promise<unknown>, message?: string) =>
    async (event: SubmitEvent) => {
      event.preventDefault();
      const element = event.currentTarget;
      await perform(() => action(new FormData(element), element), message);
    };

  const canManage = role === 'OWNER' || role === 'ADMIN';
  const canProjects = canManage || role === 'MEMBER';
  const queries = [organization, members, invitations, teams, projects];
  const pending = queries.find((query) => query.isPending);
  const failed = queries.find((query) => query.isError);
  if (pending) return <Loading />;
  if (failed) return <ErrorState error={failed.error} onRetry={() => void failed.refetch()} />;
  if (!organization.data || !role) return null;

  const allowedRoles = ROLES.filter(
    (candidate) => rank[candidate] <= rank[role] && (candidate !== 'OWNER' || role === 'OWNER'),
  );
  const roleSelect = (value: Role, onChange: (role: Role) => void, label: string) => (
    <select
      aria-label={label}
      className={inputClass}
      value={value}
      onChange={(event) => {
        onChange(event.target.value as Role);
      }}
    >
      {allowedRoles.map((item) => (
        <option key={item} value={item}>
          {t(`organization.roles.${item}`)}
        </option>
      ))}
    </select>
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t('organization.title')}</h1>
        {(user?.organizations.length ?? 0) > 1 ? (
          <label className="flex items-center gap-2 text-sm">
            <span>{t('organization.current')}</span>
            <select
              className={inputClass}
              value={orgId}
              onChange={(event) => {
                setSelectedOrg(event.target.value);
                setError(undefined);
                setNotice(undefined);
                setInvitationUrl(undefined);
              }}
            >
              {user?.organizations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <FormError message={error ? errorMessage(error, t) : undefined} />
      {notice ? (
        <p role="status" className="rounded-md bg-brand/10 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}

      <Card>
        <h2 className="mb-3 font-semibold">{t('organization.details')}</h2>
        <form
          key={`${organization.data.id}-${organization.data.name}`}
          onSubmit={(event) =>
            void submit(async (form, _element) => {
              await api<Organization>(base, {
                method: 'PATCH',
                body: { name: text(form, 'name') },
              });
            })(event)
          }
          className="flex flex-wrap items-end gap-3"
        >
          <Field
            label={t('organization.name')}
            name="name"
            defaultValue={organization.data.name}
            required
            maxLength={100}
            disabled={!canManage}
            error={fieldError(error, 'name')}
          />
          <p className="pb-3 text-sm text-muted" dir="ltr">
            {organization.data.slug}
          </p>
          {canManage ? (
            <Button type="submit" disabled={mutation.isPending}>
              {t('organization.save')}
            </Button>
          ) : null}
        </form>
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">{t('organization.members')}</h2>
        <ul className="flex flex-col gap-2">
          {members.data?.map((member) => {
            const editable = canManage && (role === 'OWNER' || member.role !== 'OWNER');
            return (
              <li
                key={member.userId}
                className="flex flex-wrap items-center gap-3 border-t border-border py-3 first:border-0 first:pt-0"
                data-testid={`member-${member.userId}`}
              >
                <div className="min-w-40 flex-1">
                  <p className="font-medium">{member.name}</p>
                  <p className="text-sm text-muted" dir="ltr">
                    {member.email}
                  </p>
                </div>
                {editable ? (
                  roleSelect(
                    member.role,
                    (nextRole) => {
                      void perform(() =>
                        api(`${base}/members/${member.userId}`, {
                          method: 'PATCH',
                          body: { role: nextRole },
                        }),
                      );
                    },
                    t('organization.memberRole', { name: member.name }),
                  )
                ) : (
                  <span>{t(`organization.roles.${member.role}`)}</span>
                )}
                {editable ? (
                  <Button
                    variant="outline"
                    className="text-danger"
                    disabled={mutation.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          t('organization.removeConfirm', {
                            name: member.name,
                          }),
                        )
                      ) {
                        void perform(() =>
                          api(`${base}/members/${member.userId}`, { method: 'DELETE' }),
                        );
                      }
                    }}
                  >
                    {t('organization.remove')}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>

      {canManage ? (
        <Card>
          <h2 className="mb-3 font-semibold">{t('organization.invite')}</h2>
          <form
            onSubmit={(event) =>
              void submit(async (form, element) => {
                const created = await api<CreatedInvitation>(`${base}/invitations`, {
                  method: 'POST',
                  body: { email: text(form, 'email'), role: text(form, 'role') },
                });
                setInvitationUrl(created.url);
                setCopied(false);
                element.reset();
              }, t('organization.invited'))(event)
            }
            className="flex flex-wrap items-end gap-3"
          >
            <Field
              label={t('organization.email')}
              name="email"
              type="email"
              required
              dir="ltr"
              error={fieldError(error, 'email')}
            />
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('organization.role')}</span>
              <select name="role" className={inputClass} defaultValue="MEMBER">
                {allowedRoles.map((item) => (
                  <option key={item} value={item}>
                    {t(`organization.roles.${item}`)}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" disabled={mutation.isPending}>
              {t('organization.sendInvite')}
            </Button>
          </form>
          {invitationUrl ? (
            <div className="mt-4 rounded-md border border-border p-3">
              <p className="mb-2 text-sm">{t('organization.inviteLinkOnce')}</p>
              <code className="block break-all text-sm" dir="ltr" data-testid="invitation-url">
                {invitationUrl}
              </code>
              <Button
                variant="outline"
                className="mt-2"
                onClick={() => {
                  void navigator.clipboard.writeText(invitationUrl).then(() => {
                    setCopied(true);
                  });
                }}
              >
                {copied ? t('organization.copied') : t('organization.copy')}
              </Button>
            </div>
          ) : null}
          <h3 className="mb-2 mt-5 text-sm font-medium">{t('organization.pendingInvites')}</h3>
          {invitations.data?.length ? (
            <ul className="flex flex-col gap-2">
              {invitations.data.map((invitation) => (
                <li key={invitation.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <span dir="ltr">{invitation.email}</span>
                  <span className="text-muted">{t(`organization.roles.${invitation.role}`)}</span>
                  <Button
                    variant="ghost"
                    className="ms-auto h-8 text-danger"
                    disabled={mutation.isPending}
                    onClick={() => {
                      void perform(() =>
                        api(`${base}/invitations/${invitation.id}`, { method: 'DELETE' }),
                      );
                    }}
                  >
                    {t('organization.revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">{t('organization.noInvites')}</p>
          )}
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-3 font-semibold">{t('organization.teams')}</h2>
        {canManage ? (
          <form
            onSubmit={(event) =>
              void submit(async (form, element) => {
                await api(`${base}/teams`, {
                  method: 'POST',
                  body: {
                    name: text(form, 'name'),
                    ...(text(form, 'slug') ? { slug: text(form, 'slug') } : {}),
                  },
                });
                element.reset();
              })(event)
            }
            className="mb-4 flex flex-wrap items-end gap-3"
            aria-label={t('organization.newTeam')}
          >
            <Field label={t('organization.teamName')} name="name" required maxLength={100} />
            <Field label={t('organization.slugOptional')} name="slug" dir="ltr" />
            <Button type="submit" disabled={mutation.isPending}>
              {t('organization.createTeam')}
            </Button>
          </form>
        ) : null}
        {teams.data?.length ? (
          <ul className="flex flex-col gap-2">
            {teams.data.map((team) => (
              <li
                key={team.id}
                className="border-t border-border pt-2"
                data-testid={`team-${team.id}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{team.name}</span>
                  <code className="text-xs text-muted" dir="ltr">
                    {team.slug}
                  </code>
                </div>
                {canManage ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm text-brand">
                      {t('organization.edit')}
                    </summary>
                    <form
                      onSubmit={(event) =>
                        void submit(async (form, _element) => {
                          await api(`${base}/teams/${team.id}`, {
                            method: 'PATCH',
                            body: { name: text(form, 'name'), slug: text(form, 'slug') },
                          });
                        })(event)
                      }
                      className="mt-2 flex flex-wrap items-end gap-3"
                    >
                      <Field
                        label={t('organization.teamName')}
                        name="name"
                        defaultValue={team.name}
                        required
                      />
                      <Field
                        label={t('organization.slug')}
                        name="slug"
                        defaultValue={team.slug}
                        required
                        dir="ltr"
                      />
                      <Button type="submit" variant="outline" disabled={mutation.isPending}>
                        {t('organization.save')}
                      </Button>
                      <Button
                        className="text-danger"
                        variant="ghost"
                        disabled={mutation.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              t('organization.deleteTeamConfirm', {
                                name: team.name,
                              }),
                            )
                          )
                            void perform(() =>
                              api(`${base}/teams/${team.id}`, { method: 'DELETE' }),
                            );
                        }}
                      >
                        {t('organization.delete')}
                      </Button>
                    </form>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t('organization.noTeams')}</p>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">{t('organization.projects')}</h2>
        {canProjects ? (
          <form
            onSubmit={(event) =>
              void submit(async (form, element) => {
                await api(`${base}/projects`, {
                  method: 'POST',
                  body: {
                    name: text(form, 'name'),
                    ...(text(form, 'slug') ? { slug: text(form, 'slug') } : {}),
                    teamId: text(form, 'teamId') || null,
                  },
                });
                element.reset();
              })(event)
            }
            className="mb-4 flex flex-wrap items-end gap-3"
            aria-label={t('organization.newProject')}
          >
            <Field label={t('organization.projectName')} name="name" required maxLength={100} />
            <Field label={t('organization.slugOptional')} name="slug" dir="ltr" />
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('organization.team')}</span>
              <select name="teamId" className={inputClass} defaultValue="">
                <option value="">{t('organization.noTeam')}</option>
                {teams.data?.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" disabled={mutation.isPending}>
              {t('organization.createProject')}
            </Button>
          </form>
        ) : null}
        {projects.data?.length ? (
          <ul className="flex flex-col gap-2">
            {projects.data.map((project) => (
              <li
                key={project.id}
                className="border-t border-border pt-2"
                data-testid={`project-${project.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{project.name}</span>
                  <code className="text-xs text-muted" dir="ltr">
                    {project.slug}
                  </code>
                  <span className="text-xs text-muted">
                    {teams.data?.find((team) => team.id === project.teamId)?.name ??
                      t('organization.noTeam')}
                  </span>
                </div>
                {canProjects ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm text-brand">
                      {t('organization.edit')}
                    </summary>
                    <form
                      onSubmit={(event) =>
                        void submit(async (form, _element) => {
                          await api(`${base}/projects/${project.id}`, {
                            method: 'PATCH',
                            body: {
                              name: text(form, 'name'),
                              slug: text(form, 'slug'),
                              teamId: text(form, 'teamId') || null,
                            },
                          });
                        })(event)
                      }
                      className="mt-2 flex flex-wrap items-end gap-3"
                    >
                      <Field
                        label={t('organization.projectName')}
                        name="name"
                        defaultValue={project.name}
                        required
                      />
                      <Field
                        label={t('organization.slug')}
                        name="slug"
                        defaultValue={project.slug}
                        required
                        dir="ltr"
                      />
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t('organization.team')}</span>
                        <select
                          name="teamId"
                          className={inputClass}
                          defaultValue={project.teamId ?? ''}
                        >
                          <option value="">{t('organization.noTeam')}</option>
                          {teams.data?.map((team) => (
                            <option key={team.id} value={team.id}>
                              {team.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Button type="submit" variant="outline" disabled={mutation.isPending}>
                        {t('organization.save')}
                      </Button>
                      <Button
                        className="text-danger"
                        variant="ghost"
                        disabled={mutation.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              t('organization.deleteProjectConfirm', {
                                name: project.name,
                              }),
                            )
                          )
                            void perform(() =>
                              api(`${base}/projects/${project.id}`, { method: 'DELETE' }),
                            );
                        }}
                      >
                        {t('organization.delete')}
                      </Button>
                    </form>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t('organization.noProjects')}</p>
        )}
      </Card>
    </section>
  );
}
