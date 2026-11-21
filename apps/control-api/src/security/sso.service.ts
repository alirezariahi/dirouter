/**
 * OIDC single sign-on (card 14.2).
 *
 * Flow: authorization code + PKCE (S256) + state + nonce. The state, PKCE verifier and nonce are kept
 * in Valkey for ten minutes and are single-use; the state is also bound to the browser that started
 * the flow through an HttpOnly cookie (login CSRF). ID tokens are verified against the IdP JWKS,
 * issuer and audience; `email_verified` is required. Group names are mapped to application roles;
 * unknown groups fall back to the connection's default role, and OWNER is never assigned.
 *
 * Who may sign in: a new user is provisioned just in time; an existing account is only accepted
 * when it already is a member of the connection's organization. The resulting session is valid for
 * that organization only (see AuthService.issueSsoSession and OrgGuard).
 *
 * The client secret is stored encrypted with MASTER_KEY (AAD = connection ID) and never returned.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { decrypt, DiRouterError, encrypt, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { AuthService, type ClientInfo, type Session } from '../auth/auth.service.js';
import { hashPassword } from '../auth/crypto.js';
import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import type { Role } from '../rbac/permissions.js';
import {
  assertOutboundUrlAllowed,
  assertSsoRolesAllowed,
  emailDomainAllowed,
  normalizeAllowedDomains,
  parseOutboundUrl,
  resolveRedirectUri,
  resolveSsoRole,
  ssoRoleForExistingMember,
} from './sso-policy.js';

export { mapGroupsToRole } from './sso-policy.js';

export const STATE_TTL_SECONDS = 600;
const STATE_PREFIX = 'sso:state:';
const DISCOVERY_TTL_MS = 5 * 60_000;

export interface SsoInput {
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  enabled?: boolean;
  defaultRole?: Role;
  allowedDomains?: string[];
  groupRoleMap?: Record<string, Role>;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface StateRecord {
  connectionId: string;
  redirectUri: string;
  verifier: string;
  nonce: string;
  /** SHA-256 of the random value in the browser's state cookie. */
  bindingHash: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

export function buildAuthorizationUrl(
  discovery: Pick<Discovery, 'authorization_endpoint'>,
  input: {
    clientId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    challenge: string;
  },
): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', 'openid email profile groups');
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

const pkceChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

@Injectable()
export class SsoService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
    @Inject(ENV) private readonly env: Env,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  list(org: OrgContext) {
    return this.prisma.client.ssoConnection
      .findMany({
        where: { organizationId: org.organizationId },
        orderBy: { createdAt: 'asc' },
      })
      .then((rows) => rows.map((row) => this.#public(row)));
  }

  get #production(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  async create(org: OrgContext, input: SsoInput) {
    const defaultRole = input.defaultRole ?? 'MEMBER';
    assertSsoRolesAllowed(org.role, { defaultRole, groupRoleMap: input.groupRoleMap });
    const allowedDomains = normalizeAllowedDomains(input.allowedDomains);
    const issuer = input.issuer.replace(/\/+$/, '');
    await assertOutboundUrlAllowed(issuer, this.#production);
    const id = prefixedId('sso');
    const row = await this.prisma.client.ssoConnection.create({
      data: {
        id,
        organizationId: org.organizationId,
        name: input.name,
        issuer,
        clientId: input.clientId,
        clientSecretEnc: encrypt(this.env.MASTER_KEY, input.clientSecret, `sso:${id}`),
        keyVersion: this.env.MASTER_KEY.currentVersion,
        enabled: input.enabled ?? true,
        defaultRole,
        allowedDomains,
        groupRoleMap: (input.groupRoleMap ?? {}) as never,
      },
    });
    await this.audit(org, 'sso.created', id, {
      name: row.name,
      issuer: row.issuer,
      enabled: row.enabled,
      defaultRole: row.defaultRole,
      allowedDomains: row.allowedDomains,
      groupRoleMap: row.groupRoleMap,
    });
    return this.#public(row);
  }

  async update(org: OrgContext, id: string, patch: Partial<SsoInput>) {
    const current = await this.owned(org, id);
    // The roles are validated as they will be stored, not only the patched part: changing the
    // issuer or the client of a connection re-targets every role its mapping hands out.
    assertSsoRolesAllowed(org.role, {
      defaultRole: patch.defaultRole ?? current.defaultRole,
      groupRoleMap: patch.groupRoleMap ?? (current.groupRoleMap as Record<string, Role>),
    });
    const allowedDomains =
      patch.allowedDomains !== undefined
        ? normalizeAllowedDomains(patch.allowedDomains)
        : undefined;
    // A connection saved before domains became mandatory cannot stay enabled without them.
    if (!allowedDomains && (patch.enabled ?? current.enabled))
      normalizeAllowedDomains(current.allowedDomains);
    const issuer = patch.issuer?.replace(/\/+$/, '');
    if (issuer !== undefined) await assertOutboundUrlAllowed(issuer, this.#production);
    const row = await this.prisma.client.ssoConnection.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(issuer !== undefined ? { issuer } : {}),
        ...(patch.clientId !== undefined ? { clientId: patch.clientId } : {}),
        ...(patch.clientSecret !== undefined
          ? {
              clientSecretEnc: encrypt(this.env.MASTER_KEY, patch.clientSecret, `sso:${id}`),
              keyVersion: this.env.MASTER_KEY.currentVersion,
            }
          : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.defaultRole !== undefined ? { defaultRole: patch.defaultRole } : {}),
        ...(allowedDomains ? { allowedDomains } : {}),
        ...(patch.groupRoleMap !== undefined ? { groupRoleMap: patch.groupRoleMap as never } : {}),
      },
    });
    this.#discoveryCache.delete(current.issuer);
    // The diff lists what changed; the client secret is only ever named, never written.
    await this.audit(org, 'sso.updated', id, {
      fields: Object.keys(patch),
      ...(patch.name !== undefined ? { name: row.name } : {}),
      ...(issuer !== undefined ? { issuer: row.issuer, previousIssuer: current.issuer } : {}),
      ...(patch.clientId !== undefined ? { clientId: row.clientId } : {}),
      ...(patch.enabled !== undefined ? { enabled: row.enabled } : {}),
      ...(patch.defaultRole !== undefined ? { defaultRole: row.defaultRole } : {}),
      ...(allowedDomains ? { allowedDomains } : {}),
      ...(patch.groupRoleMap !== undefined ? { groupRoleMap: row.groupRoleMap } : {}),
    });
    return this.#public(row);
  }

  async remove(org: OrgContext, id: string) {
    const current = await this.owned(org, id);
    await this.prisma.client.ssoConnection.delete({ where: { id } });
    this.#discoveryCache.delete(current.issuer);
    await this.audit(org, 'sso.deleted', id, { name: current.name, issuer: current.issuer });
  }

  /** Login page lookup by email domain; returns nothing when SSO is not available. */
  async lookup(email: string): Promise<{ connectionId: string; name: string } | null> {
    const domain = email.toLowerCase().split('@')[1];
    if (!domain) return null;
    const rows = await this.prisma.client.ssoConnection.findMany({
      where: { enabled: true, organization: { deletedAt: null } },
      orderBy: { createdAt: 'asc' },
    });
    const match = rows.find((row) => row.allowedDomains.includes(domain));
    return match ? { connectionId: match.id, name: match.name } : null;
  }

  /**
   * `binding` goes into an HttpOnly cookie of the browser that starts the flow; the callback only
   * accepts the state together with that cookie. `requestedRedirectUri` is merely checked against
   * the configured dashboard URL, never trusted.
   */
  async start(
    connectionId: string,
    requestedRedirectUri?: string,
  ): Promise<{ authorizationUrl: string; state: string; binding: string }> {
    const redirectUri = resolveRedirectUri(
      this.env.PUBLIC_DASHBOARD_URL,
      requestedRedirectUri,
      this.#production,
    );
    const connection = await this.enabled(connectionId);
    const discovery = await this.discover(connection.issuer);
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const binding = randomBytes(32).toString('base64url');
    const record: StateRecord = {
      connectionId,
      redirectUri,
      verifier,
      nonce,
      bindingHash: sha256(binding),
    };
    await this.valkey.client.set(
      `${STATE_PREFIX}${state}`,
      JSON.stringify(record),
      'EX',
      STATE_TTL_SECONDS,
      'NX',
    );
    return {
      state,
      binding,
      authorizationUrl: buildAuthorizationUrl(discovery, {
        clientId: connection.clientId,
        redirectUri,
        state,
        nonce,
        challenge: pkceChallenge(verifier),
      }),
    };
  }

  async callback(
    code: string,
    state: string,
    binding: string | undefined,
    client: ClientInfo,
  ): Promise<Session & { organizationId: string }> {
    const key = `${STATE_PREFIX}${state}`;
    const raw = await this.valkey.client.get(key);
    // DEL doubles as the single-use check: of two requests with the same state only one continues.
    const claimed = await this.valkey.client.del(key);
    if (!raw || claimed !== 1)
      throw new DiRouterError('invalid_request', { message: 'invalid SSO state' });
    const record = JSON.parse(raw) as StateRecord;
    // Login CSRF: the response must come back to the browser that started the flow. Without this an
    // attacker could finish their own login in a victim's browser.
    const presented = Buffer.from(sha256(binding ?? ''));
    const expected = Buffer.from(record.bindingHash);
    if (!binding || presented.length !== expected.length || !timingSafeEqual(presented, expected))
      throw new DiRouterError('invalid_request', {
        message: 'SSO sign-in was not started in this browser',
      });
    const connection = await this.enabled(record.connectionId);
    const discovery = await this.discover(connection.issuer);
    const secret = decrypt(this.env.MASTER_KEY, connection.clientSecretEnc, `sso:${connection.id}`);

    const response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: record.redirectUri,
        client_id: connection.clientId,
        client_secret: secret,
        code_verifier: record.verifier,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new DiRouterError('unauthenticated', {
        message: `SSO token exchange failed (HTTP ${String(response.status)})`,
      });
    }
    const tokens = (await response.json()) as { id_token?: string };
    if (typeof tokens.id_token !== 'string')
      throw new DiRouterError('unauthenticated', { message: 'SSO response has no id_token' });

    const { payload } = await jwtVerify(
      tokens.id_token,
      createRemoteJWKSet(new URL(discovery.jwks_uri)),
      {
        issuer: discovery.issuer,
        audience: connection.clientId,
        algorithms: ['RS256', 'ES256', 'PS256'],
      },
    );
    if (payload.nonce !== record.nonce)
      throw new DiRouterError('unauthenticated', { message: 'SSO nonce mismatch' });
    if (typeof payload.sub !== 'string' || payload.sub === '')
      throw new DiRouterError('unauthenticated', { message: 'SSO token has no subject' });
    if (typeof payload.email !== 'string' || payload.email_verified !== true) {
      throw new DiRouterError('unauthenticated', {
        message: 'SSO did not return a verified email address',
      });
    }

    const email = payload.email.toLowerCase();
    if (!emailDomainAllowed(email, connection.allowedDomains)) {
      throw new DiRouterError('forbidden', {
        message: 'This email domain is not allowed for the SSO connection',
      });
    }
    const groups = Array.isArray(payload.groups)
      ? payload.groups.filter((group): group is string => typeof group === 'string')
      : [];
    const resolved = resolveSsoRole(
      connection.groupRoleMap as Record<string, unknown>,
      groups,
      connection.defaultRole,
    );

    const db = this.prisma.client;
    const existing = await db.user.findUnique({ where: { email } });
    if (existing && (!existing.isActive || existing.deletedAt))
      throw new DiRouterError('unauthenticated', { message: 'This account is disabled' });
    const membership = existing
      ? await db.membership.findUnique({
          where: {
            userId_organizationId: {
              userId: existing.id,
              organizationId: connection.organizationId,
            },
          },
        })
      : null;
    // An identity provider speaks for its own organization only. An account that exists but is not a
    // member here belongs to somebody this organization has no authority over: asserting its email
    // must not sign in as it. Such a user joins through an invitation (which asks for their password).
    if (existing && !membership)
      throw new DiRouterError('forbidden', {
        message:
          'An account with this email exists but is not a member of this organization; ask an administrator for an invitation',
      });

    let role: Role;
    let user: { id: string; email: string; name: string };
    if (existing && membership) {
      user = existing;
      role = ssoRoleForExistingMember(membership.role, resolved);
      if (role !== membership.role)
        await db.membership.update({ where: { id: membership.id }, data: { role } });
    } else {
      role = resolved.role;
      const name =
        typeof payload.name === 'string' && payload.name.trim()
          ? payload.name.trim().slice(0, 100)
          : (email.split('@')[0] ?? email);
      // JIT users have no password; a random hash keeps the column non-null and unusable.
      const passwordHash = await hashPassword(randomBytes(32).toString('hex'));
      user = await db.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { id: prefixedId('usr'), email, name, passwordHash },
        });
        await tx.membership.create({
          data: {
            id: prefixedId('mem'),
            userId: created.id,
            organizationId: connection.organizationId,
            role,
          },
        });
        return created;
      });
    }
    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: connection.organizationId,
        actorUserId: user.id,
        ip: client.ip,
        action: 'auth.sso_login',
        targetType: 'user',
        targetId: user.id,
        diff: {
          connectionId: connection.id,
          subject: payload.sub,
          groups,
          role,
          provisioned: !existing,
          ...(membership && membership.role !== role ? { previousRole: membership.role } : {}),
        } as never,
      },
    });
    const session = await this.auth.issueSsoSession(user, connection.organizationId, client);
    return { ...session, organizationId: connection.organizationId };
  }

  readonly #discoveryCache = new Map<string, { until: number; value: Discovery }>();

  /**
   * Fetches the discovery document. The issuer and every endpoint the server will call are checked
   * first (https, and public addresses only in production), redirects are refused, and the result
   * is cached briefly because the unauthenticated login page triggers this.
   */
  async discover(issuer: string): Promise<Discovery> {
    const base = issuer.replace(/\/+$/, '');
    const cached = this.#discoveryCache.get(base);
    if (cached && cached.until > Date.now()) return cached.value;
    await assertOutboundUrlAllowed(base, this.#production);
    const response = await fetch(`${base}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new DiRouterError('invalid_request', {
        message: `OIDC discovery failed (HTTP ${String(response.status)})`,
      });
    const body = (await response.json()) as Partial<Discovery>;
    if (
      typeof body.authorization_endpoint !== 'string' ||
      typeof body.token_endpoint !== 'string' ||
      typeof body.jwks_uri !== 'string'
    )
      throw new DiRouterError('invalid_request', { message: 'OIDC discovery document is invalid' });
    // The document is tenant-controlled input: its endpoints get the same checks as the issuer.
    // The authorization endpoint is only visited by the browser, so its address is not resolved.
    parseOutboundUrl(body.authorization_endpoint, this.#production);
    await assertOutboundUrlAllowed(body.token_endpoint, this.#production);
    await assertOutboundUrlAllowed(body.jwks_uri, this.#production);
    const value: Discovery = {
      issuer: typeof body.issuer === 'string' ? body.issuer : base,
      authorization_endpoint: body.authorization_endpoint,
      token_endpoint: body.token_endpoint,
      jwks_uri: body.jwks_uri,
    };
    this.#discoveryCache.set(base, { until: Date.now() + DISCOVERY_TTL_MS, value });
    return value;
  }

  #public(row: {
    id: string;
    name: string;
    issuer: string;
    clientId: string;
    enabled: boolean;
    defaultRole: string;
    allowedDomains: string[];
    groupRoleMap: unknown;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      name: row.name,
      issuer: row.issuer,
      clientId: row.clientId,
      enabled: row.enabled,
      defaultRole: row.defaultRole,
      allowedDomains: row.allowedDomains,
      groupRoleMap: row.groupRoleMap,
      hasClientSecret: true,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async enabled(id: string) {
    const row = await this.prisma.client.ssoConnection.findUnique({ where: { id } });
    if (!row || !row.enabled) throw new DiRouterError('not_found');
    return row;
  }

  private async owned(org: OrgContext, id: string) {
    const row = await this.prisma.client.ssoConnection.findFirst({
      where: { id, organizationId: org.organizationId },
    });
    if (!row) throw new DiRouterError('not_found');
    return row;
  }

  private async audit(org: OrgContext, action: string, targetId: string, diff?: object) {
    await this.prisma.client.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: org.organizationId,
        actorUserId: org.userId,
        ...(org.ip ? { ip: org.ip } : {}),
        action,
        targetType: 'sso_connection',
        targetId,
        ...(diff ? { diff: diff as never } : {}),
      },
    });
  }
}
