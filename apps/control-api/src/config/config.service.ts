/**
 * Versioned config: list/diff/rollback and YAML export/import (card 17.1).
 * YAML export is JSON text, which is valid YAML 1.2; import accepts JSON or a simple YAML subset.
 * Import validates the whole image before anything is written (atomic on invalid input).
 *
 * Scoping rule (the snapshot is one image for every organization, the routes are per organization):
 * - Reads return only the caller organization's slice, with credential ciphertexts and key hashes
 *   replaced by a placeholder (see config.scope.ts).
 * - Import and rollback replace only the caller organization's slice of the published image; other
 *   organizations' entities are carried over unchanged. When the instance has more than one
 *   organization they additionally require the OWNER role.
 * - Gateway `settings` are instance-wide: any write that changes them (PUT settings, or an import
 *   or rollback whose settings differ from the current ones) requires the OWNER role.
 */
import { ConfigSnapshot, GatewaySettings } from '@dirouter/contracts';
import { DiRouterError, ForbiddenError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { diff, parseConfigText } from './config.diff.js';
import {
  mergeOrgSlice,
  type OrgOwnedIds,
  orgView,
  prepareImport,
  sliceForOrg,
} from './config.scope.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';

@Injectable()
export class ConfigService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
  ) {}

  list() {
    return this.prisma.client.configVersion.findMany({
      orderBy: { version: 'desc' },
      select: { version: true, checksum: true, reason: true, createdAt: true },
      take: 100,
    });
  }

  async #row(version: number) {
    const row = Number.isInteger(version)
      ? await this.prisma.client.configVersion.findUnique({ where: { version } })
      : null;
    if (!row) throw new DiRouterError('not_found', { message: 'version not found', status: 404 });
    return row;
  }

  async #latest() {
    const latest = await this.prisma.client.configVersion.findFirst({
      orderBy: { version: 'desc' },
    });
    if (!latest)
      throw new DiRouterError('not_found', { message: 'no config version yet', status: 404 });
    return latest;
  }

  /** One version as the caller organization may see it: own slice, secrets replaced. */
  async get(org: OrgContext, version: number) {
    const row = await this.#row(version);
    const { baseChecksum: _baseChecksum, ...rest } = row;
    return { ...rest, snapshot: orgView(row.snapshot, org.organizationId) };
  }

  async diff(org: OrgContext, from: number, to: number) {
    const [a, b] = await Promise.all([this.#row(from), this.#row(to)]);
    return {
      from,
      to,
      changes: diff(
        orgView(a.snapshot, org.organizationId),
        orgView(b.snapshot, org.organizationId),
      ).slice(0, 1000),
    };
  }

  #requireOwner(org: OrgContext, why: string): void {
    if (org.role !== 'OWNER')
      throw new ForbiddenError('forbidden', { message: `Requires the OWNER role: ${why}` });
  }

  /**
   * Import and rollback publish an image for the whole instance. With a single organization the
   * `config:write` permission is enough; with several, only an OWNER may do it (and even then
   * only the caller organization's slice is replaced). Changing the instance-wide gateway
   * settings always requires OWNER.
   */
  async #authorizeImageWrite(org: OrgContext, settingsChange: boolean): Promise<void> {
    if (settingsChange) this.#requireOwner(org, 'this changes the instance-wide gateway settings');
    const organizations = await this.prisma.client.organization.count({
      where: { deletedAt: null },
    });
    if (organizations > 1) this.#requireOwner(org, 'the instance has more than one organization');
  }

  async #ownedIds(org: OrgContext): Promise<OrgOwnedIds> {
    const where = { organizationId: org.organizationId };
    const db = this.prisma.client;
    const [projects, teams, keys, budgets] = await Promise.all([
      db.project.findMany({ where, select: { id: true } }),
      db.team.findMany({ where, select: { id: true } }),
      db.apiKey.findMany({
        where: {
          ...where,
          status: 'ACTIVE',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { id: true },
      }),
      db.budget.findMany({ where, select: { id: true } }),
    ]);
    const ids = (rows: { id: string }[]) => new Set(rows.map((row) => row.id));
    return {
      projectIds: ids(projects),
      teamIds: ids(teams),
      keyIds: ids(keys),
      budgetIds: ids(budgets),
    };
  }

  #invalid(message: string, issues: { path: string; message: string }[]): never {
    throw new DiRouterError('invalid_request', {
      message,
      status: 400,
      meta: { issues: issues.slice(0, 20) },
    });
  }

  async #audit(org: OrgContext, action: string, targetId: string, diff: object) {
    await this.prisma.client.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: org.organizationId,
        actorUserId: org.userId,
        ...(org.ip ? { ip: org.ip } : {}),
        action,
        targetType: 'config',
        targetId,
        diff,
      },
    });
  }

  async rollback(org: OrgContext, version: number, reason: string) {
    const [target, latest] = await Promise.all([this.#row(version), this.#latest()]);
    const current = latest.snapshot as { settings?: unknown };
    const settings = (target.snapshot as { settings?: unknown }).settings ?? {};
    const settingsChange = diff(current.settings ?? {}, settings).length > 0;
    await this.#authorizeImageWrite(org, settingsChange);
    // Only the caller organization's slice goes back in time. A key that was revoked or has
    // expired since that version stays out: rollback must not bring a revoked key back to life.
    const slice = sliceForOrg(target.snapshot, org.organizationId);
    const { keyIds } = await this.#ownedIds(org);
    slice.virtualKeys = (slice.virtualKeys as { id?: unknown }[]).filter((key) =>
      keyIds.has(String(key.id)),
    );
    const parsed = ConfigSnapshot.safeParse(
      mergeOrgSlice(latest.snapshot, slice, org.organizationId, settings),
    );
    if (!parsed.success)
      throw new DiRouterError('invalid_request', {
        message: 'stored snapshot is invalid',
        status: 400,
      });
    const published = await this.snapshots.publishSnapshot(
      parsed.data,
      `rollback to v${String(version)}: ${reason}`,
    );
    await this.#audit(org, 'config.rolled_back', String(published), {
      rolledBackTo: version,
      reason,
      settingsChanged: settingsChange,
    });
    return { version: published, rolledBackTo: version };
  }

  /** Stored gateway settings plus the effective values after defaults (card 17.1). */
  async getSettings() {
    const stored = await this.snapshots.gatewaySettings();
    return { stored, effective: GatewaySettings.parse(stored) };
  }

  /**
   * Replace the gateway settings. The whole object is validated first, so an invalid payload
   * changes nothing; a valid one is stored and published as a new config version immediately.
   * The settings apply to every organization of the instance, so only an OWNER may write them.
   */
  async putSettings(org: OrgContext, input: unknown) {
    this.#requireOwner(org, 'gateway settings are instance-wide');
    const parsed = GatewaySettings.safeParse(input);
    if (!parsed.success)
      this.#invalid(
        'invalid gateway settings',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    const before = await this.snapshots.gatewaySettings();
    // Store what the user sent (not the defaulted form) so later default changes still apply.
    const json = JSON.stringify(input ?? {});
    await this.prisma.client.$executeRaw`
      INSERT INTO "gateway_settings" ("id", "settings", "updated_by", "updated_at")
      VALUES ('global', ${json}::jsonb, ${org.userId}, now())
      ON CONFLICT ("id") DO UPDATE
        SET "settings" = EXCLUDED."settings",
            "updated_by" = EXCLUDED."updated_by",
            "updated_at" = now()`;
    const version = await this.snapshots.rebuild('gateway settings updated');
    // Paths only: a proxy URL may carry credentials, so values stay out of the audit trail.
    await this.#audit(org, 'config.settings_updated', 'global', {
      version,
      changed: diff(before, input ?? {})
        .map((change) => change.path)
        .slice(0, 100),
    });
    return { version, stored: input ?? {}, effective: parsed.data };
  }

  /** Export of the caller organization's slice; secrets are placeholders that import restores. */
  async exportYaml(org: OrgContext) {
    const latest = await this.#latest();
    return {
      version: latest.version,
      yaml: JSON.stringify(orgView(latest.snapshot, org.organizationId), null, 2),
    };
  }

  async importYaml(org: OrgContext, text: string, reason: string) {
    const raw = parseConfigText(text);
    const latest = await this.#latest();
    const currentSettings = (latest.snapshot as { settings?: unknown }).settings ?? {};
    const settings = (raw as { settings?: unknown } | null)?.settings ?? currentSettings;
    const settingsChange = diff(currentSettings, settings).length > 0;
    await this.#authorizeImageWrite(org, settingsChange);
    const prepared = prepareImport(
      raw,
      latest.snapshot,
      org.organizationId,
      await this.#ownedIds(org),
    );
    if (!prepared.slice) this.#invalid('invalid config snapshot', prepared.problems);
    const parsed = ConfigSnapshot.safeParse(
      mergeOrgSlice(latest.snapshot, prepared.slice, org.organizationId, settings),
    );
    if (!parsed.success)
      this.#invalid(
        'invalid config snapshot',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    const version = await this.snapshots.publishSnapshot(parsed.data, `import: ${reason}`);
    await this.#audit(org, 'config.imported', String(version), {
      reason,
      settingsChanged: settingsChange,
    });
    return { version };
  }
}
