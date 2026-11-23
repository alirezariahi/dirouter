/** SSRF guard for tenant upstream URLs (card 22.3). */
import { describe, expect, it } from 'vitest';

import { assertPublicUrls } from './public-urls.js';

const dns: Record<string, string[]> = {
  'api.openai.com': ['104.18.7.192'],
  'rebind.example': ['93.184.216.34', '10.0.0.5'],
  'metadata.example': ['169.254.169.254'],
};
const resolve = (host: string) =>
  dns[host] ? Promise.resolve(dns[host]) : Promise.reject(new Error('ENOTFOUND'));

describe('public upstream URLs', () => {
  it('accepts public hosts and addresses', async () => {
    await expect(
      assertPublicUrls(
        ['https://api.openai.com/v1', 'http://8.8.8.8:8080', undefined, null],
        resolve,
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://127.0.0.1:6379',
    'http://10.1.2.3/v1',
    'http://[::1]:8080',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
    'http://metadata.example/',
    'http://rebind.example/', // any private answer is refused
    'http://nowhere.example/', // unresolvable
    'socks5://user:secret@192.168.1.10:1080',
  ])('refuses %s', async (url) => {
    await expect(assertPublicUrls([url], resolve)).rejects.toThrow(/public address|invalid URL/);
  });

  it('never echoes proxy credentials', async () => {
    await expect(assertPublicUrls(['http://user:s3cret@10.0.0.1:3128'], resolve)).rejects.toThrow(
      /^http:\/\/\*\*\*@10\.0\.0\.1:3128 must resolve/,
    );
  });
});
