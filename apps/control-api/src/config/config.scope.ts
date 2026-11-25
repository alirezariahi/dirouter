/**
 * Organization scoping of the config snapshot (card 17.1); free of framework imports.
 *
 * The published snapshot is one image for the whole instance, but the config endpoints are
 * guarded per organization. The rule enforced here:
 *
 * - Reads (version, diff, export) only ever see the caller organization's slice, and never a
 *   credential ciphertext or a virtual-key hash: both are replaced by `SECRET_PLACEHOLDER`.
 * - Writes (import, rollback) only replace the caller organization's slice; every other
 *   organization's entities are carried over untouched from the currently published image.
 * - An imported document cannot introduce secret material: credentials and virtual keys must
 *   already exist in the caller organization (matched by id) and keep their stored secret/hash.
 *   New credentials and keys are created through their own APIs.
 */

/** Stands in for credential ciphertexts and key hashes in everything a reader can see. */
export const SECRET_PLACEHOLDER = '***';

/** Snapshot arrays whose items carry an `organizationId`. */
export const ORG_ARRAYS = [
  'providers',
  'models',
  'combos',
  'aliases',
  'virtualKeys',
  'limits',
  'guardrails',
] as const;
type OrgArray = (typeof ORG_ARRAYS)[number];

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function items(snapshot: unknown, key: string): Json[] {
  const value = isRecord(snapshot) ? snapshot[key] : undefined;
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function credentialsOf(provider: Json): Json[] {
  return Array.isArray(provider.credentials) ? provider.credentials.filter(isRecord) : [];
}

/** The caller organization's part of a snapshot, secrets included (internal use only). */
export function sliceForOrg(snapshot: unknown, organizationId: string): Json {
  const source = isRecord(snapshot) ? snapshot : {};
  // The checksum covers the whole image, so it would be wrong for a slice.
  const { checksum: _checksum, ...rest } = source;
  const out: Json = { ...rest };
  for (const key of ORG_ARRAYS)
    out[key] = items(source, key).filter((item) => item.organizationId === organizationId);
  // Body capture levels (card 24.1) are read-only here: they change only through their own API,
  // and a merge always keeps the published ones.
  if ('bodyCapture' in source)
    out.bodyCapture = items(source, 'bodyCapture').filter(
      (item) => item.organizationId === organizationId,
    );
  return out;
}

/** What a reader may see: the organization slice with ciphertexts and key hashes replaced. */
export function orgView(snapshot: unknown, organizationId: string): Json {
  const slice = sliceForOrg(snapshot, organizationId);
  slice.providers = (slice.providers as Json[]).map((provider) => ({
    ...provider,
    credentials: credentialsOf(provider).map((credential) => ({
      ...credential,
      secret: SECRET_PLACEHOLDER,
    })),
  }));
  slice.virtualKeys = (slice.virtualKeys as Json[]).map((key) => ({
    ...key,
    hash: SECRET_PLACEHOLDER,
  }));
  return slice;
}

/** Ids that belong to the organization right now, read from the database by the caller. */
export interface OrgOwnedIds {
  projectIds: ReadonlySet<string>;
  teamIds: ReadonlySet<string>;
  /** Active virtual keys. */
  keyIds: ReadonlySet<string>;
  budgetIds: ReadonlySet<string>;
  /** Members of the organization (card 33.1 member limits). */
  userIds?: ReadonlySet<string>;
}

export interface PreparedImport {
  /** The caller organization's slice with stored secrets restored; undefined when rejected. */
  slice?: Json;
  problems: { path: string; message: string }[];
}

/**
 * Validates an imported document against the scoping rule and restores the secrets that the
 * export replaced by the placeholder. `current` is the currently published (full) image.
 * Nothing is written here; the caller rejects the import when `problems` is not empty.
 */
export function prepareImport(
  document: unknown,
  current: unknown,
  organizationId: string,
  owned: OrgOwnedIds,
): PreparedImport {
  const problems: PreparedImport['problems'] = [];
  const problem = (path: string, message: string) => {
    problems.push({ path, message });
  };
  if (!isRecord(document)) return { problems: [{ path: '(root)', message: 'must be an object' }] };

  // 1. Every entity must belong to the organization in the route.
  for (const key of ORG_ARRAYS) {
    const value = document[key];
    if (value !== undefined && !Array.isArray(value)) problem(key, 'must be an array');
    (Array.isArray(value) ? value : []).forEach((item: unknown, index) => {
      if (!isRecord(item)) problem(`${key}.${String(index)}`, 'must be an object');
      else if (item.organizationId !== organizationId)
        problem(`${key}.${String(index)}.organizationId`, 'belongs to another organization');
    });
  }
  if (problems.length > 0) return { problems };

  // 2. Ids already used by another organization cannot be claimed.
  const foreign: Record<string, Set<string>> = {};
  const foreignIds = (key: OrgArray) =>
    (foreign[key] ??= new Set(
      items(current, key)
        .filter((item) => item.organizationId !== organizationId)
        .map((item) => String(item.id)),
    ));
  for (const key of ['providers', 'models', 'combos', 'virtualKeys', 'guardrails'] as const)
    items(document, key).forEach((item, index) => {
      if (foreignIds(key).has(String(item.id)))
        problem(`${key}.${String(index)}.id`, 'id is already used by another organization');
    });
  const foreignCredentialIds = new Set(
    items(current, 'providers')
      .filter((provider) => provider.organizationId !== organizationId)
      .flatMap((provider) => credentialsOf(provider).map((credential) => String(credential.id))),
  );

  // 3. Credentials keep their stored ciphertext; a document cannot bring its own.
  const mine = sliceForOrg(current, organizationId);
  const storedSecrets = new Map(
    (mine.providers as Json[]).flatMap((provider) =>
      credentialsOf(provider).map((credential) => [String(credential.id), credential.secret]),
    ),
  );
  const providers: Json[] = items(document, 'providers').map((provider, p) => ({
    ...provider,
    credentials: credentialsOf(provider).map((credential, c) => {
      const path = `providers.${String(p)}.credentials.${String(c)}`;
      const id = String(credential.id);
      const stored = storedSecrets.get(id);
      if (foreignCredentialIds.has(id) || stored === undefined) {
        problem(
          `${path}.id`,
          'unknown credential; new credentials are created through the providers API',
        );
        return credential;
      }
      if (credential.secret !== SECRET_PLACEHOLDER && credential.secret !== stored)
        problem(`${path}.secret`, 'secrets cannot be changed through import');
      return { ...credential, secret: stored };
    }),
  }));

  // 4. Virtual keys must exist and be active; their identity fields are not importable.
  const storedKeys = new Map((mine.virtualKeys as Json[]).map((key) => [String(key.id), key]));
  const virtualKeys = items(document, 'virtualKeys').map((key, index) => {
    const path = `virtualKeys.${String(index)}`;
    const stored = storedKeys.get(String(key.id));
    if (!stored || !owned.keyIds.has(String(key.id))) {
      problem(`${path}.id`, 'unknown or inactive key; keys are created through the keys API');
      return key;
    }
    if (key.hash !== SECRET_PLACEHOLDER && key.hash !== stored.hash)
      problem(`${path}.hash`, 'key hashes cannot be changed through import');
    return {
      ...key,
      hash: stored.hash,
      prefix: stored.prefix,
      projectId: stored.projectId,
      teamId: stored.teamId,
      ...(stored.userId !== undefined ? { userId: stored.userId } : { userId: undefined }),
    };
  });

  // 5. References must stay inside the imported (own) slice.
  const providerIds = new Set(providers.map((provider) => String(provider.id)));
  const modelIds = new Set(items(document, 'models').map((model) => String(model.id)));
  const comboIds = new Set(items(document, 'combos').map((combo) => String(combo.id)));
  items(document, 'models').forEach((model, index) => {
    if (!providerIds.has(String(model.providerId)))
      problem(`models.${String(index)}.providerId`, 'provider is not part of this document');
  });
  items(document, 'combos').forEach((combo, index) => {
    (Array.isArray(combo.targets) ? combo.targets.filter(isRecord) : []).forEach((target, t) => {
      if (!modelIds.has(String(target.modelId)))
        problem(
          `combos.${String(index)}.targets.${String(t)}.modelId`,
          'model is not part of this document',
        );
    });
  });
  items(document, 'aliases').forEach((alias, index) => {
    const target = isRecord(alias.target) ? alias.target : {};
    const ok =
      target.kind === 'combo'
        ? comboIds.has(String(target.comboId))
        : modelIds.has(String(target.modelId));
    if (!ok) problem(`aliases.${String(index)}.target`, 'target is not part of this document');
  });

  // 6. Scopes and budgets must be owned by the organization in the database.
  const checkBudgets = (entity: Json, path: string) => {
    (Array.isArray(entity.budgets) ? entity.budgets.filter(isRecord) : []).forEach((budget, b) => {
      if (!owned.budgetIds.has(String(budget.id)))
        problem(`${path}.budgets.${String(b)}.id`, 'unknown budget');
    });
  };
  virtualKeys.forEach((key, index) => {
    checkBudgets(key, `virtualKeys.${String(index)}`);
  });
  // Upstream account budgets (card 32.6).
  providers.forEach((provider, p) => {
    checkBudgets(provider, `providers.${String(p)}`);
    credentialsOf(provider).forEach((credential, c) => {
      checkBudgets(credential, `providers.${String(p)}.credentials.${String(c)}`);
    });
  });
  const publicModelIds = new Set(
    items(current, 'models')
      .filter((model) => model.public === true)
      .map((model) => String(model.id)),
  );
  items(document, 'limits').forEach((limit, index) => {
    const id = String(limit.scopeId);
    const known: Record<string, boolean> = {
      organization: id === organizationId,
      team: owned.teamIds.has(id),
      project: owned.projectIds.has(id),
      user: owned.userIds?.has(id) ?? false,
      model: modelIds.has(id) || publicModelIds.has(id),
      provider: providerIds.has(id),
    };
    if (known[String(limit.scope)] === false)
      problem(`limits.${String(index)}.scopeId`, `unknown ${String(limit.scope)}`);
    checkBudgets(limit, `limits.${String(index)}`);
  });
  const unknownId = (value: unknown, ids: ReadonlySet<string>) =>
    value !== undefined && value !== null && !(typeof value === 'string' && ids.has(value));
  items(document, 'guardrails').forEach((guardrail, index) => {
    if (unknownId(guardrail.virtualKeyId, owned.keyIds))
      problem(`guardrails.${String(index)}.virtualKeyId`, 'unknown key');
    if (unknownId(guardrail.projectId, owned.projectIds))
      problem(`guardrails.${String(index)}.projectId`, 'unknown project');
  });

  if (problems.length > 0) return { problems };
  const slice: Json = { ...document, providers, virtualKeys };
  for (const key of ORG_ARRAYS) slice[key] = items(slice, key);
  return { slice, problems };
}

/**
 * The image to publish after an organization-scoped write: every other organization's entities
 * come from `current`, the caller organization's entities come from `slice`. `settings` are
 * instance-wide and chosen by the caller (who has checked the OWNER rule).
 */
export function mergeOrgSlice(
  current: unknown,
  slice: unknown,
  organizationId: string,
  settings: unknown,
): Json {
  const base = isRecord(current) ? current : {};
  const { checksum: _checksum, ...rest } = base;
  const out: Json = { ...rest, settings };
  for (const key of ORG_ARRAYS)
    out[key] = [
      ...items(base, key).filter((item) => item.organizationId !== organizationId),
      ...items(slice, key).filter((item) => item.organizationId === organizationId),
    ];
  return out;
}
