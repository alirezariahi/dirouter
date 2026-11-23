/**
 * Agent profiles (card 20.5): an organization saves how a coding agent should use DiRouter (tool,
 * main model, fast background model), previews the generated files with a placeholder key, and
 * sets it up in one step: a dedicated key limited to the profile's models is created and the files
 * and installer come back with it embedded, shown once like any new key.
 */
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { slugify } from '../common/ids.js';
import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { KeysService } from '../keys/keys.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { type AgentTool, generateProfile, installScript, KEY_PLACEHOLDER } from './templates.js';

export interface ProfileInput {
  name: string;
  tool: AgentTool;
  mainModel: string;
  fastModel?: string | undefined;
  options?: { disableNonessentialTraffic?: boolean | undefined } | undefined;
}

type Row = NonNullable<Awaited<ReturnType<PrismaService['client']['agentProfile']['findFirst']>>>;

const view = (p: Row) => ({
  id: p.id,
  name: p.name,
  tool: p.tool,
  mainModel: p.mainModel,
  fastModel: p.fastModel,
  options: p.options,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

@Injectable()
export class AgentProfilesService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KeysService) private readonly keys: KeysService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  async list(ctx: OrgContext) {
    const rows = await this.db.agentProfile.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { name: 'asc' },
    });
    return rows.map(view);
  }

  async #load(ctx: OrgContext, id: string) {
    const row = await this.db.agentProfile.findFirst({
      where: { id, organizationId: ctx.organizationId },
    });
    if (!row) throw new DiRouterError('not_found', { message: 'Profile not found' });
    return row;
  }

  async create(ctx: OrgContext, input: ProfileInput) {
    const id = prefixedId('apf');
    try {
      await this.db.agentProfile.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          name: input.name,
          tool: input.tool,
          mainModel: input.mainModel,
          fastModel: input.fastModel ?? input.mainModel,
          options: input.options ?? {},
          createdById: ctx.userId,
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002')
        throw new DiRouterError('conflict', { message: `A profile named '${input.name}' exists` });
      throw error;
    }
    return view(await this.#load(ctx, id));
  }

  async update(ctx: OrgContext, id: string, input: Partial<ProfileInput>) {
    await this.#load(ctx, id);
    await this.db.agentProfile.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.tool !== undefined ? { tool: input.tool } : {}),
        ...(input.mainModel !== undefined ? { mainModel: input.mainModel } : {}),
        ...(input.fastModel !== undefined ? { fastModel: input.fastModel } : {}),
        ...(input.options !== undefined ? { options: input.options } : {}),
      },
    });
    return view(await this.#load(ctx, id));
  }

  async remove(ctx: OrgContext, id: string) {
    await this.#load(ctx, id);
    await this.db.agentProfile.delete({ where: { id } });
  }

  #files(p: Row, apiKey: string) {
    const options = (p.options ?? {}) as { disableNonessentialTraffic?: boolean };
    const slug = slugify(p.name);
    const files = generateProfile({
      tool: p.tool as AgentTool,
      slug,
      gatewayUrl: this.env.PUBLIC_GATEWAY_URL,
      apiKey,
      mainModel: p.mainModel,
      fastModel: p.fastModel,
      ...(options.disableNonessentialTraffic ? { disableNonessentialTraffic: true } : {}),
    });
    return { files, script: installScript(slug, files) };
  }

  /** The files with a placeholder instead of a key. */
  async preview(ctx: OrgContext, id: string) {
    return this.#files(await this.#load(ctx, id), KEY_PLACEHOLDER);
  }

  /**
   * One-click setup: a new key for this profile (only its models, in the given project) and the
   * files with that key. The key is shown here once and never again.
   */
  async setup(
    ctx: OrgContext,
    id: string,
    input: { projectId: string; expiresAt?: string | undefined },
  ) {
    const profile = await this.#load(ctx, id);
    const key = await this.keys.create(ctx, {
      name: `${profile.name} (${profile.tool})`.slice(0, 100),
      projectId: input.projectId,
      allowedModels: [...new Set([profile.mainModel, profile.fastModel])],
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    });
    return { keyId: key.id, key: key.key, ...this.#files(profile, key.key) };
  }
}
