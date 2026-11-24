/** Helpers for the management token form (card 23.6). */
export type Preset = 'read' | 'full' | 'custom';

/** The scopes a preset stands for, out of what the service account's role grants. */
export function presetScopes(preset: Preset, permissions: string[], custom: string[]): string[] {
  if (preset === 'read') return permissions.filter((p) => p.endsWith(':read'));
  if (preset === 'full') return permissions;
  return custom.filter((p) => permissions.includes(p));
}

/** One IP or CIDR range per line (commas also separate). */
export const parseIpList = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
