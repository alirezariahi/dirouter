/** Sprint 3 page messages, one module per page, merged under the `s3` key. */
import { agentProfilesEn, agentProfilesFa } from './agent-profiles';
import { pluginsEn, pluginsFa } from './plugins';

export const s3Fa = { agentProfiles: agentProfilesFa, plugins: pluginsFa } as const;

export const s3En = { agentProfiles: agentProfilesEn, plugins: pluginsEn };
