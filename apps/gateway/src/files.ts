/**
 * `/v1/files` (card 30.1), OpenAI-compatible: upload, list, retrieve, delete and content.
 *
 * A file belongs to the organization of the key that uploaded it; any key of that organization can
 * use it and no other organization can see it (another organization's id answers 404, exactly
 * like an unknown id). Bytes go to the configured storage (a volume or an S3-compatible bucket),
 * metadata to the job store; both expire after the retention period, which an upload can shorten
 * with `expires_after`.
 */
import type { VirtualKeyConfig } from '@dirouter/contracts';
import { ulid } from '@dirouter/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { authed, invalid, type JobsDeps, notFound, nowSeconds, sendError } from './jobs/context.js';
import { parseMultipart } from './media.js';

export const FILE_PURPOSES = [
  'assistants',
  'batch',
  'fine-tune',
  'vision',
  'user_data',
  'evals',
] as const;

export interface FileRecord {
  id: string;
  organizationId: string;
  projectId: string;
  virtualKeyId: string;
  bytes: number;
  filename: string;
  /** An upload purpose, or `batch_output` for results the gateway wrote. */
  purpose: string;
  /** Seconds since the epoch, like OpenAI. */
  createdAt: number;
  expiresAt: number;
  storageKey: string;
}

/** Records outlive their bytes by a day so the expiry sweep always finds what to delete. */
const RECORD_GRACE_SECONDS = 86_400;

export const fileView = (f: FileRecord) => ({
  id: f.id,
  object: 'file' as const,
  bytes: f.bytes,
  created_at: f.createdAt,
  filename: f.filename,
  purpose: f.purpose,
  expires_at: f.expiresAt,
  status: 'processed' as const,
  status_details: null,
});

export type FileOwner = Pick<VirtualKeyConfig, 'organizationId' | 'projectId' | 'id'>;

/** Stores bytes and their record; used by uploads and by batch results. */
export async function saveFile(
  deps: JobsDeps,
  owner: FileOwner,
  input: { filename: string; purpose: string; data: Uint8Array; retentionSeconds?: number },
): Promise<FileRecord> {
  const id = `file-${ulid()}`;
  const createdAt = nowSeconds();
  const keep = Math.min(
    input.retentionSeconds ?? deps.jobOptions.fileRetentionSeconds,
    deps.jobOptions.fileRetentionSeconds,
  );
  const record: FileRecord = {
    id,
    organizationId: owner.organizationId,
    projectId: owner.projectId,
    virtualKeyId: owner.id,
    bytes: input.data.byteLength,
    filename: input.filename,
    purpose: input.purpose,
    createdAt,
    expiresAt: createdAt + keep,
    storageKey: `${owner.organizationId}/${id}`,
  };
  await deps.blobs.put(record.storageKey, input.data);
  await deps.jobs.put('file', id, record, {
    ttlSeconds: keep + RECORD_GRACE_SECONDS,
    organizationId: owner.organizationId,
    createdAt: createdAt * 1000,
  });
  await deps.jobs.schedule('file', id, record.expiresAt * 1000);
  return record;
}

/** The record, only for its own organization. */
export async function loadFile(
  deps: Pick<JobsDeps, 'jobs'>,
  organizationId: string,
  id: string,
): Promise<FileRecord | undefined> {
  const record = await deps.jobs.get<FileRecord>('file', id);
  if (!record || record.organizationId !== organizationId) return undefined;
  if (record.expiresAt <= nowSeconds()) return undefined;
  return record;
}

export async function deleteFile(deps: JobsDeps, record: FileRecord): Promise<void> {
  await deps.blobs.delete(record.storageKey);
  await deps.jobs.delete('file', record.id, record.organizationId);
}

/** The expiry sweep (run by the poller when a file's time is up). */
export async function expireFile(deps: JobsDeps, id: string): Promise<void> {
  const record = await deps.jobs.get<FileRecord>('file', id);
  if (!record) {
    await deps.jobs.unschedule('file', id);
    return;
  }
  if (record.expiresAt * 1000 > Date.now()) {
    await deps.jobs.schedule('file', id, record.expiresAt * 1000);
    return;
  }
  await deleteFile(deps, record);
}

async function upload(req: FastifyRequest, reply: FastifyReply, deps: JobsDeps) {
  const { key } = authed(req, deps);
  if (!Buffer.isBuffer(req.body))
    throw invalid('send the file as multipart/form-data with file and purpose fields', 'file');
  let parsed: ReturnType<typeof parseMultipart>;
  try {
    parsed = parseMultipart(req.body, req.headers['content-type'] ?? '');
  } catch {
    throw invalid('malformed multipart body', 'file');
  }
  const { fields, file } = parsed;
  if (!file) throw invalid('file is required', 'file');
  const purpose = fields.purpose;
  if (!purpose || !(FILE_PURPOSES as readonly string[]).includes(purpose))
    throw invalid(`purpose must be one of ${FILE_PURPOSES.join(', ')}`, 'purpose');
  if (file.data.length > deps.jobOptions.maxFileBytes)
    throw invalid(`file is larger than ${String(deps.jobOptions.maxFileBytes)} bytes`, 'file');
  let retentionSeconds: number | undefined;
  const anchor = fields['expires_after[anchor]'];
  const seconds = fields['expires_after[seconds]'];
  if (anchor !== undefined || seconds !== undefined) {
    const value = Number(seconds);
    if (anchor !== 'created_at')
      throw invalid("expires_after.anchor must be 'created_at'", 'expires_after');
    if (!Number.isInteger(value) || value < 3_600 || value > 2_592_000)
      throw invalid('expires_after.seconds must be between 3600 and 2592000', 'expires_after');
    retentionSeconds = value;
  }
  const filename = file.filename.replace(/[\r\n"]/g, '').slice(0, 255) || 'file';
  if (purpose === 'batch' && !/\.jsonl$/i.test(filename))
    throw invalid('a batch input file must be a .jsonl file', 'file');
  const record = await saveFile(deps, key, {
    filename,
    purpose,
    data: file.data,
    ...(retentionSeconds !== undefined ? { retentionSeconds } : {}),
  });
  return reply.status(200).send(fileView(record));
}

async function list(req: FastifyRequest, reply: FastifyReply, deps: JobsDeps) {
  const { key } = authed(req, deps);
  const q = (req.query ?? {}) as Record<string, string | undefined>;
  const limit = q.limit === undefined ? 10_000 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
    throw invalid('limit must be between 1 and 10000', 'limit');
  const order = q.order ?? 'desc';
  if (order !== 'asc' && order !== 'desc') throw invalid("order must be 'asc' or 'desc'", 'order');
  const all = (
    await deps.jobs.list<FileRecord>('file', key.organizationId, { limit: 10_000 })
  ).data.filter((f) => f.expiresAt > nowSeconds() && (!q.purpose || f.purpose === q.purpose));
  if (order === 'asc') all.reverse();
  const start = q.after ? all.findIndex((f) => f.id === q.after) + 1 : 0;
  const data = all.slice(start, start + limit).map(fileView);
  return reply.send({
    object: 'list',
    data,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
    has_more: all.length > start + limit,
  });
}

async function owned(req: FastifyRequest, deps: JobsDeps): Promise<FileRecord> {
  const { key } = authed(req, deps);
  const id = (req.params as { id: string }).id;
  const record = await loadFile(deps, key.organizationId, id);
  if (!record) throw notFound('file', id);
  return record;
}

export function registerFileRoutes(app: FastifyInstance, deps: JobsDeps): void {
  const handle =
    (fn: (req: FastifyRequest, reply: FastifyReply, deps: JobsDeps) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req, reply, deps);
      } catch (error) {
        return sendError(reply, error);
      }
    };
  app.post('/v1/files', { bodyLimit: deps.jobOptions.maxFileBytes + 1024 * 1024 }, handle(upload));
  app.get('/v1/files', handle(list));
  app.get(
    '/v1/files/:id',
    handle(async (req, reply, d) => reply.send(fileView(await owned(req, d)))),
  );
  app.delete(
    '/v1/files/:id',
    handle(async (req, reply, d) => {
      const record = await owned(req, d);
      await deleteFile(d, record);
      return reply.send({ id: record.id, object: 'file', deleted: true });
    }),
  );
  app.get(
    '/v1/files/:id/content',
    handle(async (req, reply, d) => {
      const record = await owned(req, d);
      const data = await d.blobs.get(record.storageKey);
      if (!data) throw notFound('file', record.id);
      return reply
        .header('content-type', 'application/octet-stream')
        .header(
          'content-disposition',
          `attachment; filename="${encodeURIComponent(record.filename)}"`,
        )
        .send(data);
    }),
  );
}
