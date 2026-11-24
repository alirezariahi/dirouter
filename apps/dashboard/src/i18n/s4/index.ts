/** Sprint 4 page messages, one module per feature, merged under the `s4` key. */
import { sessionsEn, sessionsFa } from './sessions';

export const s4Fa = {
  sessions: sessionsFa,
} as const;

export const s4En = {
  sessions: sessionsEn,
};
