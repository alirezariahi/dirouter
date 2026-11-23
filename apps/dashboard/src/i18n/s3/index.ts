/** Sprint 3 page messages, one module per page, merged under the `s3` key. */
import { agentProfilesEn, agentProfilesFa } from './agent-profiles';
import { pluginsEn, pluginsFa } from './plugins';
import { samlEn, samlFa } from './saml';
import { changesEn, changesFa } from './changes';

export const s3Fa = {
  agentProfiles: agentProfilesFa,
  plugins: pluginsFa,
  saml: samlFa,
  changes: changesFa,
} as const;

export const s3En = {
  agentProfiles: agentProfilesEn,
  plugins: pluginsEn,
  saml: samlEn,
  changes: changesEn,
};
