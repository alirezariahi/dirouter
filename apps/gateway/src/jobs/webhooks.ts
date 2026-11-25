/**
 * Signed webhooks for finished jobs (card 30.6): video tasks and batches tell the client's
 * `webhook_url` when they end, so it need not poll.
 *
 * Events follow OpenAI's webhook events (`{id, object: "event", created_at, type, data: {id}}`,
 * types such as `video.completed` or `batch.failed`) and are signed per the Standard Webhooks
 * spec, as OpenAI signs its own: `webhook-id`, `webhook-timestamp` and
 * `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`. The secret is per
 * organization (`whsec_…`, derived from MASTER_KEY, readable by the organization's keys at
 * `GET /v1/webhooks/secret`), so the OpenAI SDK's `webhooks.unwrap()` verifies DiRouter's events.
 *
 * Delivery is at least once: each event is a record in the job store, POSTed through the SSRF
 * guard without following redirects, and retried with growing delays after a network error, a
 * timeout or any non-2xx answer.
 */
import { createHmac, hkdfSync } from 'node:crypto';

import { type Keyring, ulid } from '@dirouter/shared';

import { checkWebhookUrl } from '../a2a/push.js';
import { guardedOrganization, tenantFetch } from '../upstream.js';
import { invalid, type JobsDeps, nowSeconds } from './context.js';

const RECORD_TTL_SECONDS = 7 * 86_400;

export interface WebhookRecord {
  id: string;
  organizationId: string;
  url: string;
  type: string;
  body: string;
  attempts: number;
  status: 'pending' | 'delivered' | 'failed';
  lastStatus?: number;
  lastError?: string;
  createdAt: number;
  deliveredAt?: number;
}

/** The organization's signing secret, `whsec_` + base64 of 32 bytes. */
export function webhookSecret(keyring: Keyring, organizationId: string): string {
  const master = keyring.keys.get(keyring.currentVersion);
  if (!master) throw new Error('keyring has no current key');
  const key = Buffer.from(
    hkdfSync('sha256', master, 'dirouter', `job-webhook-v1:${organizationId}`, 32),
  );
  return `whsec_${key.toString('base64')}`;
}

/** Standard Webhooks signature header value for one delivery. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const mac = createHmac('sha256', key)
    .update(`${id}.${String(timestamp)}.${body}`)
    .digest();
  return `v1,${mac.toString('base64')}`;
}

/** A webhook URL from a request: http(s), no credentials, public when the SSRF guard is on. */
export async function checkJobWebhookUrl(raw: unknown, organizationId: string): Promise<string> {
  if (typeof raw !== 'string' || raw.length > 2_000)
    throw invalid('webhook_url must be a URL', 'webhook_url');
  try {
    return await checkWebhookUrl(raw, guardedOrganization(organizationId));
  } catch (error) {
    throw invalid(
      (error as Error).message.replace('push notification url', 'webhook_url'),
      'webhook_url',
    );
  }
}

export async function enqueueWebhook(
  deps: JobsDeps,
  input: { organizationId: string; url: string; type: string; objectId: string },
): Promise<WebhookRecord> {
  const id = `evt_${ulid()}`;
  const createdAt = nowSeconds();
  const record: WebhookRecord = {
    id,
    organizationId: input.organizationId,
    url: input.url,
    type: input.type,
    body: JSON.stringify({
      id,
      object: 'event',
      created_at: createdAt,
      type: input.type,
      data: { id: input.objectId },
    }),
    attempts: 0,
    status: 'pending',
    createdAt,
  };
  await deps.jobs.put('webhook', id, record, { ttlSeconds: RECORD_TTL_SECONDS });
  await deps.jobs.schedule('webhook', id, Date.now());
  return record;
}

/** One delivery attempt; schedules the next one after a failure until the delays run out. */
export async function deliverWebhook(
  deps: JobsDeps,
  id: string,
): Promise<WebhookRecord | undefined> {
  if (!(await deps.jobs.lock('webhook', id, 60_000))) return undefined;
  try {
    const record = await deps.jobs.get<WebhookRecord>('webhook', id);
    if (!record || record.status !== 'pending') {
      await deps.jobs.unschedule('webhook', id);
      return record;
    }
    const timestamp = nowSeconds();
    const secret = webhookSecret(deps.keyring, record.organizationId);
    record.attempts++;
    try {
      const res = await tenantFetch(record.organizationId)(record.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'DiRouter-Webhooks/1.0',
          'webhook-id': record.id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signWebhook(secret, record.id, timestamp, record.body),
        },
        body: record.body,
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel().catch(() => undefined);
      record.lastStatus = res.status;
      delete record.lastError;
      if (res.status >= 200 && res.status < 300) {
        record.status = 'delivered';
        record.deliveredAt = nowSeconds();
      }
    } catch (error) {
      const e = error as Error;
      record.lastError = e.cause instanceof Error ? e.cause.message : e.message;
      delete record.lastStatus;
    }
    const delays = deps.jobOptions.webhookRetryDelaysMs;
    if (record.status === 'pending' && record.attempts > delays.length) record.status = 'failed';
    await deps.jobs.put('webhook', id, record, { ttlSeconds: RECORD_TTL_SECONDS });
    if (record.status === 'pending')
      await deps.jobs.schedule('webhook', id, Date.now() + (delays[record.attempts - 1] ?? 0));
    else await deps.jobs.unschedule('webhook', id);
    deps.logger[record.status === 'failed' ? 'warn' : 'info'](
      {
        eventId: id,
        type: record.type,
        attempts: record.attempts,
        status: record.status,
        httpStatus: record.lastStatus,
        error: record.lastError,
      },
      'job webhook delivery',
    );
    return record;
  } finally {
    await deps.jobs.unlock('webhook', id);
  }
}
