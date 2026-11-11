/** Shared IDs and hashes across modules (avoids the circular import auth ⇄ orgs). */
import { createHash } from 'node:crypto';

import { prefixedId } from '@dirouter/shared';

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // Persian name or no Latin letters: a short random slug.
  return base.length >= 2 ? base : `org-${prefixedId('x').slice(-8).toLowerCase()}`;
}

/** The invitation token is shown to the inviter only once; the DB stores only this hash. */
export const hashInvite = (token: string) =>
  createHash('sha256').update(`invite:${token}`).digest('hex');
