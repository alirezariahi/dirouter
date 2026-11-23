/** Sprint 3 page messages, one module per page, merged under the `s3` key. */
import { agentProfilesEn, agentProfilesFa } from './agent-profiles';

export const s3Fa = { agentProfiles: agentProfilesFa } as const;

export const s3En = { agentProfiles: agentProfilesEn };
