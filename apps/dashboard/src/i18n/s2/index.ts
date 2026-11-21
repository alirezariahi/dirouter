/** Sprint 2 page messages, one module per page, merged under the `s2` key. */
import { mfaEn, mfaFa } from './mfa';
import { pagesEn, pagesFa } from './pages';
import { securityEn, securityFa } from './security';
import { simulatorEn, simulatorFa } from './simulator';

export const s2Fa = {
  ...pagesFa,
  mfa: mfaFa,
  security: securityFa,
  simulator: simulatorFa,
} as const;

export const s2En = {
  ...pagesEn,
  mfa: mfaEn,
  security: securityEn,
  simulator: simulatorEn,
};
