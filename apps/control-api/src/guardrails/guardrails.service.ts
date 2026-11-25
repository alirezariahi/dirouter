/**
 * Guardrail policy CRUD (card 15.1) and the live "test before save" preview (card 15.2).
 * The gateway is the enforcement point; the preview runs the same engine (card 23.1).
 */
import { Script } from 'node:vm';

import {
  type GuardrailPreview,
  externalConfigProblem,
  jsonSchemaProblem,
  previewGuardrailText,
} from '@dirouter/contracts';
import { Prisma } from '@dirouter/db';
import { estimateRequestTokens, roughTokens } from '@dirouter/model-catalog';
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { unsafeRegexReason } from './regex-safety.js';

export interface GuardrailInput {
  name: string;
  enabled?: boolean;
  stage?: 'request' | 'response' | 'both';
  type: string;
  action?: 'block' | 'redact' | 'flag';
  config?: Record<string, unknown>;
  message?: string;
  virtualKeyId?: string;
  projectId?: string;
}

/** Wall-clock budget for one preview regex run; a slower pattern is refused. */
const PREVIEW_REGEX_TIMEOUT_MS = 100;
const matchAllScript = new Script('Array.from(text.matchAll(re), (m) => m[0])');

/**
 * Validates a policy's config as it will be stored. Regex patterns that can backtrack
 * catastrophically are refused (see regex-safety.ts): the gateway runs them on every request.
 * A `json_schema` policy needs a schema the gateway's validator fully understands (card 23.1).
 */
export function assertValidPolicyConfig(type: string, config: unknown): void {
  const cfg = (config ?? {}) as Record<string, unknown>;
  // Moderation and the injection classifier (cards 23.2 and 23.3) name a model and its limits.
  const external = externalConfigProblem(type, cfg);
  if (external) throw new DiRouterError('invalid_request', { message: external, status: 400 });
  if (type === 'json_schema') {
    if (cfg.schema === undefined)
      throw new DiRouterError('invalid_request', {
        message: 'json_schema policy requires config.schema',
        status: 400,
      });
    const problem = jsonSchemaProblem(cfg.schema);
    if (problem)
      throw new DiRouterError('invalid_request', {
        message: `invalid JSON Schema: ${problem}`,
        status: 400,
      });
    return;
  }
  if (type !== 'regex') return;
  if (typeof cfg.pattern !== 'string')
    throw new DiRouterError('invalid_request', {
      message: 'regex policy requires config.pattern',
      status: 400,
    });
  if (cfg.flags !== undefined && typeof cfg.flags !== 'string')
    throw new DiRouterError('invalid_request', { message: 'invalid regex flags', status: 400 });
  const reason = unsafeRegexReason(cfg.pattern, cfg.flags);
  if (reason)
    throw new DiRouterError('invalid_request', {
      message: `unsafe regex pattern: ${reason}`,
      status: 400,
    });
}

/** Runs the pattern in a V8 context with a time limit, so a slow pattern cannot hold the event loop. */
function boundedMatchAll(pattern: string, flags: string, text: string): string[] {
  // matchAll needs the global flag.
  const re = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
  try {
    const found = matchAllScript.runInNewContext(
      { text, re },
      { timeout: PREVIEW_REGEX_TIMEOUT_MS },
    ) as string[];
    return [...found];
  } catch {
    throw new DiRouterError('invalid_request', {
      message: 'regex pattern is too slow on this text',
      status: 400,
    });
  }
}

/**
 * The live test (card 15.2). It runs the gateway's own engine from @dirouter/contracts on the
 * sample (card 23.1), so the verdict here is the verdict in real traffic. A regex is first run
 * once under a time limit, because the sample is caller-supplied.
 */
export function previewGuardrail(input: GuardrailInput, text: string): GuardrailPreview {
  const config = input.config ?? {};
  assertValidPolicyConfig(input.type, config);
  if (input.type === 'regex' && typeof config.pattern === 'string')
    boundedMatchAll(config.pattern, typeof config.flags === 'string' ? config.flags : 'g', text);
  return previewGuardrailText(
    {
      type: input.type,
      config,
      action: input.action ?? 'block',
      ...(input.message ? { message: input.message } : {}),
    },
    text,
    (request) => estimateRequestTokens(request, roughTokens),
  );
}

@Injectable()
export class GuardrailsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
  ) {}

  list(org: OrgContext) {
    return this.db.client.guardrailPolicy.findMany({
      where: { organizationId: org.organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(org: OrgContext, input: GuardrailInput) {
    assertValidPolicyConfig(input.type, input.config);
    const id = prefixedId('grd');
    const row = await this.db.client.guardrailPolicy.create({
      data: {
        id,
        organizationId: org.organizationId,
        name: input.name,
        enabled: input.enabled ?? true,
        stage: input.stage ?? 'both',
        type: input.type,
        action: input.action ?? 'block',
        config: (input.config ?? {}) as Prisma.InputJsonValue,
        ...(input.message ? { message: input.message } : {}),
        ...(input.virtualKeyId ? { virtualKeyId: input.virtualKeyId } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
      },
    });
    await this.audit(org, 'guardrail.created', id, { name: row.name, type: row.type });
    void this.snapshots.rebuild('guardrail created').catch(() => undefined);
    return row;
  }

  async update(org: OrgContext, id: string, patch: Partial<GuardrailInput>) {
    const stored = await this.owned(org, id);
    // Validate the policy as it will be stored, not just the patch.
    if (patch.type !== undefined || patch.config !== undefined)
      assertValidPolicyConfig(patch.type ?? stored.type, patch.config ?? stored.config);
    const row = await this.db.client.guardrailPolicy.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.action !== undefined ? { action: patch.action } : {}),
        ...(patch.config !== undefined ? { config: patch.config as Prisma.InputJsonValue } : {}),
        ...(patch.message !== undefined ? { message: patch.message } : {}),
        ...(patch.virtualKeyId !== undefined ? { virtualKeyId: patch.virtualKeyId || null } : {}),
        ...(patch.projectId !== undefined ? { projectId: patch.projectId || null } : {}),
      },
    });
    await this.audit(org, 'guardrail.updated', id, { fields: Object.keys(patch) });
    void this.snapshots.rebuild('guardrail updated').catch(() => undefined);
    return row;
  }

  async remove(org: OrgContext, id: string) {
    await this.owned(org, id);
    await this.db.client.guardrailPolicy.delete({ where: { id } });
    await this.audit(org, 'guardrail.deleted', id);
    void this.snapshots.rebuild('guardrail deleted').catch(() => undefined);
  }

  private async owned(org: OrgContext, id: string) {
    const row = await this.db.client.guardrailPolicy.findFirst({
      where: { id, organizationId: org.organizationId },
      select: { id: true, type: true, config: true },
    });
    if (!row) throw new DiRouterError('not_found', { message: 'guardrail not found', status: 404 });
    return row;
  }

  async audit(org: OrgContext, action: string, targetId: string, diff?: object) {
    await this.db.client.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: org.organizationId,
        actorUserId: org.userId,
        ...(org.ip ? { ip: org.ip } : {}),
        action,
        targetType: 'guardrail',
        targetId,
        ...(diff ? { diff } : {}),
      },
    });
  }
}
