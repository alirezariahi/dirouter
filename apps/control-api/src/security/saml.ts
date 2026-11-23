/**
 * SAML 2.0 service provider (card 22.1), on top of `@node-saml/node-saml` for the XML signature
 * work. Authentication requests go out unsigned (HTTP-Redirect binding); responses must have:
 *
 * - a signed assertion from the configured IdP certificate (`wantAssertionsSigned`),
 * - the configured IdP issuer, our SP entity ID as audience, and our ACS as recipient,
 * - `InResponseTo` matching a request this server started (request IDs live in Valkey for ten
 *   minutes and are consumed atomically), and an assertion ID never seen before (replay).
 */
import {
  type CacheItem,
  type CacheProvider,
  type Profile,
  SAML,
  ValidateInResponseTo,
} from '@node-saml/node-saml';
import type { Redis } from 'ioredis';

export const SAML_REQUEST_TTL_MS = 10 * 60_000;
const PREFIX = 'sso:saml:';

export interface SamlConnection {
  id: string;
  /** IdP entity ID. */
  issuer: string;
  /** SP entity ID, also the audience. */
  clientId: string;
  samlSsoUrl: string | null;
  samlCert: string | null;
}

export interface SsoIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  groups: string[];
}

/** Request IDs and seen assertion IDs, shared by every control-api replica. */
export class ValkeySamlCache implements CacheProvider {
  constructor(
    private readonly valkey: Redis,
    private readonly namespace: string,
  ) {}

  #key(key: string) {
    return `${PREFIX}${this.namespace}:${key}`;
  }

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    await this.valkey.set(this.#key(key), value, 'PX', SAML_REQUEST_TTL_MS);
    return { value, createdAt: Date.now() };
  }
  getAsync(key: string): Promise<string | null> {
    return this.valkey.get(this.#key(key));
  }
  async removeAsync(key: string | null): Promise<string | null> {
    if (key === null) return null;
    return this.valkey.getdel(this.#key(key));
  }
  consumeAsync(key: string): Promise<string | null> {
    return this.valkey.getdel(this.#key(key));
  }
  async saveIfAbsentAsync(key: string, value: string, expiresAtMs: number): Promise<boolean> {
    const ttl = Math.max(1_000, expiresAtMs - Date.now());
    return (await this.valkey.set(this.#key(key), value, 'PX', ttl, 'NX')) === 'OK';
  }
}

/** A certificate as PEM body only: headers, footers and whitespace removed. */
export function normalizeCert(cert: string): string {
  return cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}

export const acsUrl = (publicApiUrl: string, connectionId: string) =>
  `${publicApiUrl.replace(/\/+$/, '')}/api/v1/auth/sso/saml/${connectionId}/acs`;

export function samlClient(connection: SamlConnection, acs: string, cache: CacheProvider): SAML {
  if (!connection.samlSsoUrl || !connection.samlCert)
    throw new Error('SAML connection is missing its sign-on URL or certificate');
  return new SAML({
    entryPoint: connection.samlSsoUrl,
    issuer: connection.clientId,
    idpIssuer: connection.issuer,
    audience: connection.clientId,
    callbackUrl: acs,
    idpCert: connection.samlCert,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
    rejectReplayedAssertions: true,
    cacheProvider: cache,
    acceptedClockSkewMs: 60_000,
    disableRequestedAuthnContext: true,
    signatureAlgorithm: 'sha256',
  });
}

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter(
    (v): v is string => typeof v === 'string' && v !== '',
  );

/**
 * The signed-in identity from a validated assertion. The IdP vouches for the address it asserts
 * (SAML has no `email_verified`); the connection's domain allowlist still applies. Group names
 * may arrive as paths (`/admins`); the leading slash is dropped.
 */
export function identityFromProfile(profile: Profile): SsoIdentity | undefined {
  const attrs = profile as unknown as Record<string, unknown>;
  const email =
    strings(attrs.email)[0] ??
    strings(attrs.mail)[0] ??
    strings(attrs['urn:oid:0.9.2342.19200300.100.1.3'])[0] ??
    (profile.nameIDFormat.endsWith(':emailAddress') ? profile.nameID : undefined);
  if (!email || !profile.nameID) return undefined;
  const name =
    strings(attrs.displayName)[0] ??
    ([strings(attrs.firstName)[0], strings(attrs.lastName)[0]].filter(Boolean).join(' ') ||
      undefined);
  return {
    subject: profile.nameID,
    email: email.toLowerCase(),
    emailVerified: true,
    ...(name ? { name } : {}),
    groups: strings(attrs.groups).map((g) => g.replace(/^\//, '')),
  };
}
