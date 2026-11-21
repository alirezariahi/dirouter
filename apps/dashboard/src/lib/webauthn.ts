/**
 * Passkeys (card 14.1): base64url helpers and the two browser ceremonies, shaped exactly like the
 * requests and responses of `auth/webauthn` in the control-api. Binary values travel as base64url.
 */
import { api } from './api';

export function toBase64Url(data: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Accepts base64url with or without padding (and plain base64). */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Passkeys need a secure context and the WebAuthn API; the UI is hidden without them. */
export function passkeysSupported(): boolean {
  if (typeof window === 'undefined' || typeof window.PublicKeyCredential !== 'function')
    return false;
  // Typed as always present, but missing outside secure contexts.
  const credentials = navigator.credentials as CredentialsContainer | undefined;
  return typeof credentials?.create === 'function' && typeof credentials.get === 'function';
}

export interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** `POST /auth/webauthn/options` */
export interface RegistrationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  authenticatorSelection?: { residentKey?: ResidentKeyRequirement };
  timeout?: number;
  attestation?: AttestationConveyancePreference;
}
/** `POST /auth/webauthn/login/options` */
export interface LoginOptions {
  challenge: string;
  rpId: string;
  timeout?: number;
  allowCredentials: { type: 'public-key'; id: string }[];
}
/** Body of `POST /auth/webauthn/verify` */
export interface RegistrationBody {
  clientDataJSON: string;
  attestationObject: string;
  name?: string;
}
/** Body of `POST /auth/webauthn/login/verify` */
export interface AssertionBody {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

export function creationOptions(server: RegistrationOptions): PublicKeyCredentialCreationOptions {
  return {
    challenge: fromBase64Url(server.challenge),
    rp: server.rp,
    user: {
      // The server sends its own user id as text; WebAuthn wants bytes.
      id: new TextEncoder().encode(server.user.id),
      name: server.user.name,
      displayName: server.user.displayName,
    },
    pubKeyCredParams: server.pubKeyCredParams,
    authenticatorSelection: {
      residentKey: server.authenticatorSelection?.residentKey ?? 'preferred',
      userVerification: 'required',
    },
    attestation: server.attestation ?? 'none',
    ...(server.timeout ? { timeout: server.timeout } : {}),
  };
}

export function requestOptions(server: LoginOptions): PublicKeyCredentialRequestOptions {
  return {
    challenge: fromBase64Url(server.challenge),
    rpId: server.rpId,
    userVerification: 'required',
    allowCredentials: server.allowCredentials.map((credential) => ({
      type: 'public-key' as const,
      id: fromBase64Url(credential.id),
    })),
    ...(server.timeout ? { timeout: server.timeout } : {}),
  };
}

export function registrationBody(credential: PublicKeyCredential, name?: string): RegistrationBody {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    clientDataJSON: toBase64Url(response.clientDataJSON),
    attestationObject: toBase64Url(response.attestationObject),
    ...(name ? { name } : {}),
  };
}

export function assertionBody(credential: PublicKeyCredential): AssertionBody {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    // The server stores the credential id as unpadded base64url of the raw id.
    id: toBase64Url(credential.rawId),
    clientDataJSON: toBase64Url(response.clientDataJSON),
    authenticatorData: toBase64Url(response.authenticatorData),
    signature: toBase64Url(response.signature),
  };
}

/** The user dismissed the browser prompt (or it timed out); not worth an error message. */
export function isCancelled(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'AbortError')
  );
}

export const listPasskeys = () => api<Passkey[]>('/auth/webauthn');

export async function registerPasskey(name?: string): Promise<void> {
  const options = await api<RegistrationOptions>('/auth/webauthn/options', { method: 'POST' });
  const credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
  if (!(credential instanceof PublicKeyCredential)) throw new Error('No passkey was created');
  await api('/auth/webauthn/verify', {
    method: 'POST',
    body: registrationBody(credential, name?.trim() || undefined),
  });
}

export const removePasskey = (id: string) =>
  api(`/auth/webauthn/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** Runs the sign-in ceremony and returns the session issued by the server. */
export async function passkeyAssertion(email?: string): Promise<{ accessToken: string }> {
  const options = await api<LoginOptions>('/auth/webauthn/login/options', {
    method: 'POST',
    body: email ? { email } : {},
  });
  const credential = await navigator.credentials.get({ publicKey: requestOptions(options) });
  if (!(credential instanceof PublicKeyCredential)) throw new Error('No passkey was selected');
  return api<{ accessToken: string }>('/auth/webauthn/login/verify', {
    method: 'POST',
    body: assertionBody(credential),
  });
}
