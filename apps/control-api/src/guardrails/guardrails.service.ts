/**
 * Guardrail policy CRUD (card 15.1) and the live "test before save" preview (card 15.2).
 * The gateway is still the enforcement point; this module only stores the policies in the
 * snapshot and offers a local preview of the same detectors.
 */
import { Script } from 'node:vm';

import { Prisma } from '@dirouter/db';
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

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRETS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];
const IRAN_NATIONAL_ID = /\b\d{10}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;

function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function validIranNationalId(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false;
  if (new Set(value).size === 1) return false;
  const check = Number(value[9]);
  const sum = value
    .slice(0, 9)
    .split('')
    .reduce((acc, digit, index) => acc + Number(digit) * (10 - index), 0);
  const remainder = sum % 11;
  // Same rule as the gateway (apps/gateway/src/guardrails.ts): the preview must agree with enforcement.
  return remainder < 2 ? check === remainder : check === 11 - remainder;
}

/** Wall-clock budget for one preview regex run; a slower pattern is refused. */
const PREVIEW_REGEX_TIMEOUT_MS = 100;
const matchAllScript = new Script('Array.from(text.matchAll(re), (m) => m[0])');

/**
 * Refuses regex policies whose pattern can backtrack catastrophically (see regex-safety.ts).
 * Used when a policy is saved and when it is previewed: the gateway runs these on every request.
 */
export function assertSafeRegexPolicy(type: string, config: unknown): void {
  if (type !== 'regex') return;
  const cfg = (config ?? {}) as Record<string, unknown>;
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

export function previewGuardrail(input: GuardrailInput, text: string) {
  const config = input.config ?? {};
  const matches: string[] = [];
  if (input.type === 'regex' && typeof config.pattern === 'string') {
    assertSafeRegexPolicy(input.type, config);
    const flags = typeof config.flags === 'string' ? config.flags : 'gu';
    for (const match of boundedMatchAll(config.pattern, flags, text))
      if (match) matches.push(match);
  } else if (input.type === 'keyword') {
    const terms = Array.isArray(config.terms)
      ? config.terms.filter((t): t is string => typeof t === 'string')
      : typeof config.terms === 'string'
        ? config.terms.split(',')
        : [];
    const haystack = config.caseSensitive === true ? text : text.toLowerCase();
    for (const term of terms.map((t) => t.trim()).filter(Boolean)) {
      if (haystack.includes(config.caseSensitive === true ? term : term.toLowerCase()))
        matches.push(term);
    }
  } else if (input.type === 'pii') {
    for (const match of text.matchAll(EMAIL)) matches.push(match[0]);
    for (const match of text.matchAll(CARD)) if (luhn(match[0])) matches.push(match[0]);
    for (const match of text.matchAll(IRAN_NATIONAL_ID))
      if (validIranNationalId(match[0])) matches.push(match[0]);
  } else if (input.type === 'secret') {
    for (const pattern of SECRETS)
      for (const match of text.matchAll(pattern)) matches.push(match[0].slice(0, 24) + '…');
  } else if (input.type === 'prompt_injection') {
    const phrases = [
      'ignore previous',
      'ignore all previous',
      'disregard the system',
      'reveal your system prompt',
      'you are now',
      'دستورات قبلی را نادیده',
    ];
    const lower = text.toLowerCase();
    for (const phrase of phrases) if (lower.includes(phrase)) matches.push(phrase);
  } else if (input.type === 'json_schema') {
    try {
      JSON.parse(text);
    } catch {
      return { blocked: true, matches, valid: false, redacted: text };
    }
    return { blocked: false, matches, valid: true, redacted: text };
  } else if (input.type === 'max_input_tokens') {
    const max = Number(config.maxTokens ?? 0);
    const estimated = Math.ceil(text.length / 4);
    return {
      blocked: max > 0 && estimated > max,
      matches,
      estimatedTokens: estimated,
      redacted: text,
    };
  }
  const blocked = matches.length > 0 && (input.action ?? 'block') === 'block';
  const redacted = matches.length > 0 && input.action === 'redact';
  let output = text;
  for (const match of matches) {
    if (match.length > 2) output = output.split(match).join('[REDACTED]');
  }
  return { blocked, matches, redacted, redactedText: redacted ? output : text };
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
    assertSafeRegexPolicy(input.type, input.config);
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
      assertSafeRegexPolicy(patch.type ?? stored.type, patch.config ?? stored.config);
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
