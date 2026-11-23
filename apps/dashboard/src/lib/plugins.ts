/** Provider plugin choice in the provider wizard (card 21.2). */
export interface PluginInfo {
  name: string;
  status: 'available' | 'loaded' | 'failed';
  error?: string;
  displayName?: string;
  description?: string | null;
  defaultBaseUrl?: string | null;
  termsWarning?: { text: string; url?: string } | null;
}

export interface PluginChoice {
  plugin?: PluginInfo;
  acceptTerms: boolean;
}

/** Ready to continue: a usable plugin, and its terms accepted when it has a warning. */
export const pluginChoiceReady = (choice: PluginChoice) =>
  choice.plugin?.status === 'available' && (!choice.plugin.termsWarning || choice.acceptTerms);
