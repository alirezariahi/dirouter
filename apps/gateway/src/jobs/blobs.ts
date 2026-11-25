/**
 * Where uploaded and generated files are kept (card 30.1): a local folder (a volume) or an
 * S3-compatible bucket (AWS S3, MinIO, Cloudflare R2, ArvanCloud). Keys are
 * `<organizationId>/<fileId>`, so one organization's files never share a path with another's.
 */
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface BlobStorage {
  readonly kind: 'local' | 's3';
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  /** The bytes, or undefined when the object does not exist. */
  get(key: string): Promise<Buffer | undefined>;
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/;

function checkKey(key: string): string {
  if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error(`invalid storage key ${key}`);
  return key;
}

export class LocalBlobStorage implements BlobStorage {
  readonly kind = 'local' as const;
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #path(key: string): string {
    const path = resolve(this.#root, checkKey(key));
    if (!path.startsWith(this.#root + sep)) throw new Error(`invalid storage key ${key}`);
    return path;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    // Written next to the target and renamed would be atomic; a file id is never rewritten, so a
    // plain write is enough.
    await writeFile(path, data, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.#path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }
}

export interface S3Options {
  /** `https://s3.eu-central-1.amazonaws.com`, `http://minio:9000`, … */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prefix inside the bucket. */
  prefix?: string;
  /** `https://endpoint/bucket/key` (MinIO and most compatibles) instead of `https://bucket.endpoint/key`. */
  pathStyle?: boolean;
  fetch?: typeof fetch;
  now?: () => Date;
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();
const encode = (segment: string) =>
  encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** Minimal S3 client: PUT, GET and DELETE of one object, signed with SigV4. */
export class S3BlobStorage implements BlobStorage {
  readonly kind = 's3' as const;

  constructor(private readonly options: S3Options) {}

  url(key: string): URL {
    const endpoint = new URL(this.options.endpoint);
    const path = [
      ...(this.options.prefix ? this.options.prefix.split('/') : []),
      ...checkKey(key).split('/'),
    ]
      .filter(Boolean)
      .map(encode)
      .join('/');
    if (this.options.pathStyle !== false)
      return new URL(`${endpoint.origin}/${encode(this.options.bucket)}/${path}`);
    return new URL(`${endpoint.protocol}//${this.options.bucket}.${endpoint.host}/${path}`);
  }

  /** SigV4 headers for one request (S3 paths are signed as sent, not encoded twice). */
  sign(method: string, url: URL, body: Uint8Array | undefined, extra: Record<string, string> = {}) {
    const amzDate = (this.options.now?.() ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256(body ?? '');
    const headers: Record<string, string> = {
      ...extra,
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    const names = Object.keys(headers)
      .map((n) => n.toLowerCase())
      .sort();
    const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]));
    const canonical = [
      method,
      url.pathname,
      '',
      names.map((n) => `${n}:${lower.get(n) ?? ''}\n`).join(''),
      names.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${date}/${this.options.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    let key = hmac(`AWS4${this.options.secretAccessKey}`, date);
    key = hmac(key, this.options.region);
    key = hmac(key, 's3');
    key = hmac(key, 'aws4_request');
    const signature = createHmac('sha256', key).update(toSign).digest('hex');
    const { host: _host, ...rest } = headers;
    return {
      ...rest,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    };
  }

  async #send(method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Uint8Array, type?: string) {
    const url = this.url(key);
    const extra: Record<string, string> = type ? { 'content-type': type } : {};
    const res = await (this.options.fetch ?? fetch)(url, {
      method,
      headers: this.sign(method, url, body, extra),
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(120_000),
    });
    return res;
  }

  async put(key: string, data: Uint8Array, contentType = 'application/octet-stream') {
    const res = await this.#send('PUT', key, data, contentType);
    if (!res.ok) throw new Error(`object storage PUT failed (${String(res.status)})`);
    await res.body?.cancel();
  }

  async get(key: string): Promise<Buffer | undefined> {
    const res = await this.#send('GET', key);
    if (res.status === 404) {
      await res.body?.cancel();
      return undefined;
    }
    if (!res.ok) throw new Error(`object storage GET failed (${String(res.status)})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.#send('DELETE', key);
    await res.body?.cancel();
    if (!res.ok && res.status !== 404)
      throw new Error(`object storage DELETE failed (${String(res.status)})`);
  }
}

export interface StorageEnv {
  FILES_STORAGE: 'local' | 's3';
  FILES_DIR?: string | undefined;
  FILES_S3_ENDPOINT?: string | undefined;
  FILES_S3_BUCKET?: string | undefined;
  FILES_S3_REGION?: string | undefined;
  FILES_S3_ACCESS_KEY_ID?: string | undefined;
  FILES_S3_SECRET_ACCESS_KEY?: string | undefined;
  FILES_S3_PREFIX?: string | undefined;
  FILES_S3_PATH_STYLE?: boolean | undefined;
}

export function storageFromEnv(env: StorageEnv, dataDir: string): BlobStorage {
  if (env.FILES_STORAGE === 's3') {
    const missing = (
      [
        'FILES_S3_ENDPOINT',
        'FILES_S3_BUCKET',
        'FILES_S3_ACCESS_KEY_ID',
        'FILES_S3_SECRET_ACCESS_KEY',
      ] as const
    ).filter((name) => !env[name]);
    if (missing.length > 0) throw new Error(`FILES_STORAGE=s3 needs ${missing.join(', ')}`);
    return new S3BlobStorage({
      endpoint: env.FILES_S3_ENDPOINT ?? '',
      bucket: env.FILES_S3_BUCKET ?? '',
      region: env.FILES_S3_REGION ?? 'us-east-1',
      accessKeyId: env.FILES_S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.FILES_S3_SECRET_ACCESS_KEY ?? '',
      ...(env.FILES_S3_PREFIX ? { prefix: env.FILES_S3_PREFIX } : {}),
      pathStyle: env.FILES_S3_PATH_STYLE ?? true,
    });
  }
  return new LocalBlobStorage(env.FILES_DIR ?? join(dataDir, 'files'));
}
