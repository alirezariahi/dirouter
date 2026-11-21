/** Organization scoping of the config snapshot (card 17.1): slice, redaction, import rules. */
import { describe, expect, it } from 'vitest';

import {
  mergeOrgSlice,
  type OrgOwnedIds,
  orgView,
  prepareImport,
  SECRET_PLACEHOLDER,
  sliceForOrg,
} from './config.scope.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const image = () => ({
  schemaVersion: 1,
  version: 7,
  checksum: 'f'.repeat(64),
  providers: [
    {
      id: 'prv_a',
      organizationId: 'org_a',
      baseUrl: 'https://a.example',
      credentials: [{ id: 'crd_a', name: 'main', secret: 'v1.AAAA' }],
    },
    {
      id: 'prv_b',
      organizationId: 'org_b',
      baseUrl: 'https://b.example',
      credentials: [{ id: 'crd_b', name: 'main', secret: 'v1.BBBB' }],
    },
  ],
  models: [
    { id: 'mdl_a', organizationId: 'org_a', providerId: 'prv_a' },
    { id: 'mdl_b', organizationId: 'org_b', providerId: 'prv_b' },
  ],
  combos: [],
  aliases: [],
  virtualKeys: [
    {
      id: 'key_a',
      organizationId: 'org_a',
      hash: HASH_A,
      prefix: 'dr_a',
      projectId: 'prj_a',
      teamId: null,
    },
    {
      id: 'key_b',
      organizationId: 'org_b',
      hash: HASH_B,
      prefix: 'dr_b',
      projectId: 'prj_b',
      teamId: null,
    },
  ],
  limits: [],
  guardrails: [],
  settings: { failMode: 'open' },
});

const owned: OrgOwnedIds = {
  projectIds: new Set(['prj_a']),
  teamIds: new Set(['team_a']),
  keyIds: new Set(['key_a']),
  budgetIds: new Set(['bdg_a']),
};

describe('orgView', () => {
  it('returns only the caller organization and never a ciphertext or key hash', () => {
    const view = orgView(image(), 'org_a');
    const text = JSON.stringify(view);
    expect(text).not.toContain('org_b');
    expect(text).not.toContain('v1.AAAA');
    expect(text).not.toContain(HASH_A);
    expect(view.checksum).toBeUndefined();
    expect(view.providers).toEqual([
      expect.objectContaining({
        id: 'prv_a',
        credentials: [{ id: 'crd_a', name: 'main', secret: SECRET_PLACEHOLDER }],
      }),
    ]);
    expect(view.virtualKeys).toEqual([expect.objectContaining({ hash: SECRET_PLACEHOLDER })]);
  });

  it('is empty for an organization without entities and tolerates a broken image', () => {
    expect(orgView(image(), 'org_c').providers).toEqual([]);
    expect(orgView(null, 'org_a').models).toEqual([]);
  });
});

describe('prepareImport', () => {
  it('accepts its own export and restores the stored secrets by id', () => {
    const result = prepareImport(orgView(image(), 'org_a'), image(), 'org_a', owned);
    expect(result.problems).toEqual([]);
    expect(result.slice).toEqual(sliceForOrg(image(), 'org_a'));
  });

  it('rejects entities of another organization', () => {
    const doc = orgView(image(), 'org_a');
    (doc.virtualKeys as object[]).push({ id: 'key_x', organizationId: 'org_b', hash: HASH_A });
    const result = prepareImport(doc, image(), 'org_a', owned);
    expect(result.slice).toBeUndefined();
    expect(result.problems[0]?.path).toBe('virtualKeys.1.organizationId');
  });

  it('rejects ids that belong to another organization', () => {
    const doc = orgView(image(), 'org_a');
    (doc.providers as Record<string, unknown>[])[0]!.id = 'prv_b';
    const paths = prepareImport(doc, image(), 'org_a', owned).problems.map((p) => p.path);
    expect(paths).toContain('providers.0.id');
  });

  it('rejects new or changed secret material', () => {
    const changed = orgView(image(), 'org_a');
    (changed.providers as { credentials: Record<string, unknown>[] }[])[0]!.credentials[0]!.secret =
      'v1.BBBB';
    expect(prepareImport(changed, image(), 'org_a', owned).problems[0]?.path).toBe(
      'providers.0.credentials.0.secret',
    );

    const stolen = orgView(image(), 'org_a');
    (stolen.providers as { credentials: object[] }[])[0]!.credentials.push({
      id: 'crd_b',
      secret: SECRET_PLACEHOLDER,
    });
    expect(prepareImport(stolen, image(), 'org_a', owned).problems[0]?.path).toBe(
      'providers.0.credentials.1.id',
    );

    const newKey = orgView(image(), 'org_a');
    (newKey.virtualKeys as object[]).push({ id: 'key_new', organizationId: 'org_a', hash: HASH_B });
    expect(prepareImport(newKey, image(), 'org_a', owned).problems[0]?.path).toBe(
      'virtualKeys.1.id',
    );
  });

  it('keeps key identity fields and refuses revoked keys', () => {
    const doc = orgView(image(), 'org_a');
    (doc.virtualKeys as Record<string, unknown>[])[0]!.projectId = 'prj_b';
    const result = prepareImport(doc, image(), 'org_a', owned);
    expect((result.slice?.virtualKeys as { projectId: string }[])[0]?.projectId).toBe('prj_a');

    const revoked = prepareImport(orgView(image(), 'org_a'), image(), 'org_a', {
      ...owned,
      keyIds: new Set(),
    });
    expect(revoked.problems[0]?.path).toBe('virtualKeys.0.id');
  });

  it('rejects references that leave the organization', () => {
    const doc = orgView(image(), 'org_a');
    (doc.models as Record<string, unknown>[])[0]!.providerId = 'prv_b';
    (doc.limits as object[]).push({ organizationId: 'org_a', scope: 'project', scopeId: 'prj_b' });
    (doc.guardrails as object[]).push({ id: 'grd_1', organizationId: 'org_a', projectId: 'prj_b' });
    const paths = prepareImport(doc, image(), 'org_a', owned).problems.map((p) => p.path);
    expect(paths).toEqual(['models.0.providerId', 'limits.0.scopeId', 'guardrails.0.projectId']);
  });
});

describe('mergeOrgSlice', () => {
  it('replaces only the caller organization and leaves the others untouched', () => {
    const slice = sliceForOrg(image(), 'org_a');
    (slice.providers as Record<string, unknown>[])[0]!.baseUrl = 'https://new.example';
    // Entities of another organization inside the slice are ignored.
    (slice.models as object[]).push({ id: 'mdl_evil', organizationId: 'org_b' });
    const merged = mergeOrgSlice(image(), slice, 'org_a', { failMode: 'closed' });
    const before = image();
    expect(merged.providers).toEqual([
      before.providers[1],
      { ...before.providers[0], baseUrl: 'https://new.example' },
    ]);
    expect((merged.models as { id: string }[]).map((m) => m.id)).toEqual(['mdl_b', 'mdl_a']);
    expect(merged.settings).toEqual({ failMode: 'closed' });
    expect(merged.checksum).toBeUndefined();
  });
});
