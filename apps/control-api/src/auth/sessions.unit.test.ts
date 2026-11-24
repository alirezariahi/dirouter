import { describe, expect, it } from 'vitest';

import { TokenService } from './crypto.js';
import { describeDevice } from './sessions.service.js';

describe('session device labels (card 23.5)', () => {
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Chrome on macOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
      'Edge on Windows',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox on Linux'],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    ['curl/8.7.1', 'curl'],
    ['', 'Unknown device'],
    [null, 'Unknown device'],
    ['SomethingElse/1.0', 'Unknown device'],
  ])('%s → %s', (ua, label) => {
    expect(describeDevice(ua)).toBe(label);
  });
});

describe('session id in the access token', () => {
  it('round-trips the sid claim and tolerates tokens without one', async () => {
    const tokens = new TokenService('s'.repeat(32));
    const withSid = await tokens.signAccess({ sub: 'usr_1', email: 'a@b.c', sid: 'fam_abc' });
    expect(await tokens.verifyAccess(withSid)).toMatchObject({ sub: 'usr_1', sid: 'fam_abc' });
    const without = await tokens.signAccess({ sub: 'usr_1', email: 'a@b.c' });
    expect((await tokens.verifyAccess(without))?.sid).toBeUndefined();
  });
});
