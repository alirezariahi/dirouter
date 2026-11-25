/**
 * Who a request is for (card 33.2): the end user of the organization's own product, named by the
 * `x-dirouter-end-user` header or, when the header is absent, by the request body's `user` field
 * (OpenAI `user`, Anthropic `metadata.user_id`). It decides the end user's limits and budgets and
 * is recorded on the usage event, so reports can group by it.
 */
import { END_USER_HEADER, normalizeEndUser } from '@dirouter/contracts';
import type { IncomingHttpHeaders } from 'node:http';

export interface Attribution {
  endUser?: string;
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** The usage-event fields of an attribution. */
export function attributionFields(a: Attribution): { endUser?: string } {
  return a.endUser ? { endUser: a.endUser } : {};
}

export function requestAttribution(headers: IncomingHttpHeaders, bodyUser?: unknown): Attribution {
  const endUser = normalizeEndUser(first(headers[END_USER_HEADER]) ?? bodyUser);
  return endUser ? { endUser } : {};
}
