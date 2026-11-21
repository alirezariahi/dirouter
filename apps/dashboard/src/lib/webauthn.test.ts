/** Passkey helpers: base64url round trips and the request/response shapes of auth/webauthn. */
import { describe, expect, it } from 'vitest';

import {
  assertionBody,
  creationOptions,
  fromBase64Url,
  registrationBody,
  requestOptions,
  toBase64Url,
} from './webauthn';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('base64url', () => {
  it('encodes without padding and with the URL-safe alphabet', () => {
    expect(toBase64Url(bytes())).toBe('');
    expect(toBase64Url(bytes(0xfb, 0xff))).toBe('-_8');
    expect(toBase64Url(bytes(1, 2, 3, 4).buffer)).toBe('AQIDBA');
    // A view over part of a larger buffer encodes only its own bytes.
    expect(toBase64Url(new Uint8Array(bytes(9, 1, 2, 9).buffer, 1, 2))).toBe('AQI');
  });

  it('decodes base64url, padded base64url and plain base64', () => {
    expect([...fromBase64Url('-_8')]).toEqual([0xfb, 0xff]);
    expect([...fromBase64Url('-_8=')]).toEqual([0xfb, 0xff]);
    expect([...fromBase64Url('+/8=')]).toEqual([0xfb, 0xff]);
    expect([...fromBase64Url('')]).toEqual([]);
  });

  it('round-trips every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (const length of [1, 2, 3, 255, 256])
      expect([...fromBase64Url(toBase64Url(all.subarray(0, length)))]).toEqual([
        ...all.subarray(0, length),
      ]);
  });
});

describe('ceremony options', () => {
  it('builds creation options from the server answer and always requires user verification', () => {
    const options = creationOptions({
      challenge: 'AQID',
      rp: { id: 'app.example.com', name: 'DiRouter' },
      user: { id: 'usr_1', name: 'a@example.com', displayName: 'a@example.com' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 300_000,
      attestation: 'none',
    });
    expect([...new Uint8Array(options.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(options.user.id as Uint8Array)).toBe('usr_1');
    expect(options.authenticatorSelection).toEqual({
      residentKey: 'preferred',
      userVerification: 'required',
    });
    expect(options.timeout).toBe(300_000);
  });

  it('builds request options with decoded credential ids', () => {
    const options = requestOptions({
      challenge: 'AQID',
      rpId: 'app.example.com',
      allowCredentials: [{ type: 'public-key', id: '-_8' }],
    });
    expect(options.userVerification).toBe('required');
    expect(options.rpId).toBe('app.example.com');
    expect([...(options.allowCredentials?.[0]?.id as Uint8Array)]).toEqual([0xfb, 0xff]);
  });
});

describe('ceremony results', () => {
  it('sends exactly the fields the controller reads', () => {
    const attestation = {
      response: { clientDataJSON: bytes(1).buffer, attestationObject: bytes(2).buffer },
    } as unknown as PublicKeyCredential;
    expect(registrationBody(attestation, 'Laptop')).toEqual({
      clientDataJSON: 'AQ',
      attestationObject: 'Ag',
      name: 'Laptop',
    });
    expect(registrationBody(attestation)).toEqual({
      clientDataJSON: 'AQ',
      attestationObject: 'Ag',
    });

    const assertion = {
      rawId: bytes(0xfb, 0xff).buffer,
      response: {
        clientDataJSON: bytes(1).buffer,
        authenticatorData: bytes(2).buffer,
        signature: bytes(3).buffer,
      },
    } as unknown as PublicKeyCredential;
    expect(assertionBody(assertion)).toEqual({
      id: '-_8',
      clientDataJSON: 'AQ',
      authenticatorData: 'Ag',
      signature: 'Aw',
    });
  });
});
