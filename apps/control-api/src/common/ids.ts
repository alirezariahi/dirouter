/** شناسه‌ها و hashهای مشترک بین ماژول‌ها (جلوگیری از import چرخه‌ای auth ⇄ orgs). */
import { createHash } from 'node:crypto';

import { prefixedId } from '@dirouter/shared';

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // نام فارسی یا بدون حروف لاتین: slug تصادفی کوتاه.
  return base.length >= 2 ? base : `org-${prefixedId('x').slice(-8).toLowerCase()}`;
}

/** توکن دعوت فقط یک بار به دعوت‌کننده نشان داده می‌شود؛ در DB فقط این hash است. */
export const hashInvite = (token: string) =>
  createHash('sha256').update(`invite:${token}`).digest('hex');
