/**
 * Who a request is for and what it is charged to:
 * - the end user of the organization's own product (card 33.2), named by the
 *   `x-dirouter-end-user` header or, when the header is absent, by the request body's `user` field
 *   (OpenAI `user`, Anthropic `metadata.user_id`);
 * - tags and a cost center (card 33.4): the key's default tags plus the `x-dirouter-tags` header
 *   (comma separated, at most 10 in all), and the `x-dirouter-cost-center` header or else the
 *   key's cost center.
 * They decide which end-user, tag and cost-center limits apply and are recorded on the usage
 * event, so reports can group by them.
 */
import {
  COST_CENTER_HEADER,
  END_USER_HEADER,
  normalizeEndUser,
  normalizeTags,
  TAG_PATTERN,
  TAGS_HEADER,
} from '@dirouter/contracts';
import type { IncomingHttpHeaders } from 'node:http';

export interface Attribution {
  endUser?: string;
  /** Key defaults first, then the request's own. */
  tags?: string[];
  costCenter?: string;
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const all = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value : value ? [value] : []).flatMap((v) => v.split(','));

/** The usage-event fields of an attribution. */
export function attributionFields(a: Attribution): {
  endUser?: string;
  tags?: string[];
  costCenter?: string;
} {
  return {
    ...(a.endUser ? { endUser: a.endUser } : {}),
    ...(a.tags && a.tags.length > 0 ? { tags: a.tags } : {}),
    ...(a.costCenter ? { costCenter: a.costCenter } : {}),
  };
}

export function requestAttribution(
  headers: IncomingHttpHeaders,
  bodyUser?: unknown,
  key?: { tags?: string[] | undefined; costCenter?: string | undefined },
): Attribution {
  const endUser = normalizeEndUser(first(headers[END_USER_HEADER]) ?? bodyUser);
  const tags = normalizeTags([...(key?.tags ?? []), ...all(headers[TAGS_HEADER])]);
  // A key's own cost center is fixed: its holder cannot move spend out of that cost center's
  // budget with the header. Only a key without one may name a cost center per request.
  const asked = first(headers[COST_CENTER_HEADER])?.trim();
  const costCenter = key?.costCenter || (asked && TAG_PATTERN.test(asked) ? asked : undefined);
  return {
    ...(endUser ? { endUser } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(costCenter ? { costCenter } : {}),
  };
}
