/** Sprint 4 page messages, one module per feature, merged under the `s4` key. */
import { serviceAccountsEn, serviceAccountsFa } from './service-accounts';
import { sessionsEn, sessionsFa } from './sessions';

export const s4Fa = {
  sessions: sessionsFa,
  serviceAccounts: serviceAccountsFa,
} as const;

export const s4En = {
  sessions: sessionsEn,
  serviceAccounts: serviceAccountsEn,
};
