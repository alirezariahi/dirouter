/**
 * State of the data plane's long-running objects (cards 30.1 and 30.6): uploaded files, batches,
 * async tasks and webhook deliveries (ADR-0007).
 *
 * Records live in Valkey so every replica sees them; without Valkey (a single local node) they
 * live in memory. Each record is one JSON value with a TTL, listed per organization through a
 * sorted set (newest first). Work that is due later (polling an upstream, retrying a webhook,
 * deleting an expired file) goes into one sorted set by due time; a short per-item lock makes sure
 * only one replica works on an item at a time.
 */
import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

export type JobKind = 'file' | 'batch' | 'task' | 'webhook';

export interface Page<T> {
  data: T[];
  hasMore: boolean;
}

export interface JobStore {
  get<T>(kind: JobKind, id: string): Promise<T | undefined>;
  /** Writes the record; `organizationId` puts it in the organization's list. */
  put(
    kind: JobKind,
    id: string,
    value: unknown,
    options: { ttlSeconds: number; organizationId?: string; createdAt?: number },
  ): Promise<void>;
  delete(kind: JobKind, id: string, organizationId?: string): Promise<void>;
  /** Newest first; `after` is the id of the last item of the previous page. */
  list<T>(
    kind: JobKind,
    organizationId: string,
    options: { after?: string | undefined; limit: number },
  ): Promise<Page<T>>;
  /** Puts (or moves) an item in the due queue. */
  schedule(kind: JobKind, id: string, at: number): Promise<void>;
  unschedule(kind: JobKind, id: string): Promise<void>;
  /** Items whose time has come, oldest first. */
  due(now: number, limit: number): Promise<{ kind: JobKind; id: string }[]>;
  /**
   * A lock on one item for `ms`, owned by the returned token; undefined when another worker holds
   * it. Only the owner can extend or release it, so a worker whose lock ran out (and was taken by
   * another replica) cannot free or keep the new owner's lock.
   */
  acquire(kind: JobKind, id: string, ms: number): Promise<string | undefined>;
  /** Pushes the lock's end to `ms` from now; false when `token` no longer owns it. */
  extend(kind: JobKind, id: string, token: string, ms: number): Promise<boolean>;
  /** Releases the lock when `token` still owns it. */
  release(kind: JobKind, id: string, token: string): Promise<void>;
  /**
   * `acquire` for callers that keep no token: the token is remembered by this store instance and
   * `unlock` releases with it, so a lock another replica took over is never deleted.
   */
  lock(kind: JobKind, id: string, ms: number): Promise<boolean>;
  unlock(kind: JobKind, id: string): Promise<void>;
}

const PREFIX = 'dirouter:jobs';
const recordKey = (kind: JobKind, id: string) => `${PREFIX}:${kind}:${id}`;
const indexKey = (kind: JobKind, org: string) => `${PREFIX}:${kind}:org:${org}`;
const DUE = `${PREFIX}:due`;
const lockKey = (kind: JobKind, id: string) => `${PREFIX}:lock:${kind}:${id}`;
/** Lists read at most this many ids per organization and kind. */
const MAX_LISTED = 10_000;

/** Deletes the lock only while it holds the caller's token. */
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;
/** Extends the lock only while it holds the caller's token. */
const EXTEND = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0`;

/** Tokens of the locks taken through `lock()`, so `unlock()` can release them safely. */
abstract class TokenLocks {
  readonly #held = new Map<string, string>();

  abstract acquire(kind: JobKind, id: string, ms: number): Promise<string | undefined>;
  abstract release(kind: JobKind, id: string, token: string): Promise<void>;

  async lock(kind: JobKind, id: string, ms: number): Promise<boolean> {
    const token = await this.acquire(kind, id, ms);
    if (token === undefined) return false;
    this.#held.set(lockKey(kind, id), token);
    return true;
  }

  async unlock(kind: JobKind, id: string): Promise<void> {
    const key = lockKey(kind, id);
    const token = this.#held.get(key);
    if (token === undefined) return;
    this.#held.delete(key);
    await this.release(kind, id, token);
  }
}

function pageOf(ids: string[], after: string | undefined, limit: number) {
  const start = after === undefined ? 0 : ids.indexOf(after) + 1;
  // An unknown cursor (expired or foreign id) starts from the top, like OpenAI.
  const from = after !== undefined && start === 0 ? 0 : start;
  return { ids: ids.slice(from, from + limit), hasMore: ids.length > from + limit };
}

export class RedisJobStore extends TokenLocks implements JobStore {
  constructor(private readonly redis: Redis) {
    super();
  }

  async get<T>(kind: JobKind, id: string): Promise<T | undefined> {
    const raw = await this.redis.get(recordKey(kind, id));
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  async put(
    kind: JobKind,
    id: string,
    value: unknown,
    options: { ttlSeconds: number; organizationId?: string; createdAt?: number },
  ): Promise<void> {
    const multi = this.redis
      .multi()
      .set(recordKey(kind, id), JSON.stringify(value), 'EX', Math.max(1, options.ttlSeconds));
    if (options.organizationId) {
      const index = indexKey(kind, options.organizationId);
      multi.zadd(index, options.createdAt ?? Date.now(), id);
      multi.expire(index, Math.max(1, options.ttlSeconds), 'GT');
      multi.expire(index, Math.max(1, options.ttlSeconds), 'NX');
    }
    await multi.exec();
  }

  async delete(kind: JobKind, id: string, organizationId?: string): Promise<void> {
    const multi = this.redis.multi().del(recordKey(kind, id)).zrem(DUE, `${kind}:${id}`);
    if (organizationId) multi.zrem(indexKey(kind, organizationId), id);
    await multi.exec();
  }

  async list<T>(
    kind: JobKind,
    organizationId: string,
    options: { after?: string | undefined; limit: number },
  ): Promise<Page<T>> {
    const index = indexKey(kind, organizationId);
    const ids = await this.redis.zrevrange(index, 0, MAX_LISTED - 1);
    const data: T[] = [];
    let cursor = options.after;
    let hasMore = false;
    // Expired records drop out of the index as they are found.
    for (;;) {
      const page = pageOf(ids, cursor, options.limit - data.length);
      if (page.ids.length === 0) break;
      const raws = await this.redis.mget(page.ids.map((id) => recordKey(kind, id)));
      const gone: string[] = [];
      raws.forEach((raw, i) => {
        if (raw) data.push(JSON.parse(raw) as T);
        else gone.push(page.ids[i] as string);
      });
      if (gone.length > 0) await this.redis.zrem(index, ...gone);
      hasMore = page.hasMore;
      cursor = page.ids.at(-1);
      if (data.length >= options.limit || !page.hasMore) break;
    }
    return { data, hasMore };
  }

  async schedule(kind: JobKind, id: string, at: number): Promise<void> {
    await this.redis.zadd(DUE, at, `${kind}:${id}`);
  }

  async unschedule(kind: JobKind, id: string): Promise<void> {
    await this.redis.zrem(DUE, `${kind}:${id}`);
  }

  async due(now: number, limit: number): Promise<{ kind: JobKind; id: string }[]> {
    const members = await this.redis.zrangebyscore(DUE, 0, now, 'LIMIT', 0, limit);
    return members.map(split);
  }

  async acquire(kind: JobKind, id: string, ms: number): Promise<string | undefined> {
    const token = randomUUID();
    return (await this.redis.set(lockKey(kind, id), token, 'PX', ms, 'NX')) === 'OK'
      ? token
      : undefined;
  }

  async extend(kind: JobKind, id: string, token: string, ms: number): Promise<boolean> {
    return (await this.redis.eval(EXTEND, 1, lockKey(kind, id), token, String(ms))) === 1;
  }

  async release(kind: JobKind, id: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE, 1, lockKey(kind, id), token);
  }
}

function split(member: string): { kind: JobKind; id: string } {
  const at = member.indexOf(':');
  return { kind: member.slice(0, at) as JobKind, id: member.slice(at + 1) };
}

/** Single-node fallback with the same behaviour (records expire on read). */
export class MemoryJobStore extends TokenLocks implements JobStore {
  readonly #records = new Map<string, { value: string; until: number }>();
  readonly #index = new Map<string, Map<string, number>>();
  readonly #due = new Map<string, number>();
  readonly #locks = new Map<string, { token: string; until: number }>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  get<T>(kind: JobKind, id: string): Promise<T | undefined> {
    const entry = this.#records.get(recordKey(kind, id));
    if (!entry || entry.until <= this.now()) {
      this.#records.delete(recordKey(kind, id));
      return Promise.resolve(undefined);
    }
    return Promise.resolve(JSON.parse(entry.value) as T);
  }

  put(
    kind: JobKind,
    id: string,
    value: unknown,
    options: { ttlSeconds: number; organizationId?: string; createdAt?: number },
  ): Promise<void> {
    this.#records.set(recordKey(kind, id), {
      value: JSON.stringify(value),
      until: this.now() + options.ttlSeconds * 1000,
    });
    if (options.organizationId) {
      const key = indexKey(kind, options.organizationId);
      const index = this.#index.get(key) ?? new Map<string, number>();
      if (!index.has(id)) index.set(id, options.createdAt ?? this.now());
      this.#index.set(key, index);
    }
    return Promise.resolve();
  }

  delete(kind: JobKind, id: string, organizationId?: string): Promise<void> {
    this.#records.delete(recordKey(kind, id));
    this.#due.delete(`${kind}:${id}`);
    if (organizationId) this.#index.get(indexKey(kind, organizationId))?.delete(id);
    return Promise.resolve();
  }

  async list<T>(
    kind: JobKind,
    organizationId: string,
    options: { after?: string | undefined; limit: number },
  ): Promise<Page<T>> {
    const index = this.#index.get(indexKey(kind, organizationId)) ?? new Map<string, number>();
    const ids = [...index.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))
      .map(([id]) => id);
    const alive: string[] = [];
    for (const id of ids) {
      if (await this.get(kind, id)) alive.push(id);
      else index.delete(id);
    }
    const page = pageOf(alive, options.after, options.limit);
    const data: T[] = [];
    for (const id of page.ids) {
      const value = await this.get<T>(kind, id);
      if (value) data.push(value);
    }
    return { data, hasMore: page.hasMore };
  }

  schedule(kind: JobKind, id: string, at: number): Promise<void> {
    this.#due.set(`${kind}:${id}`, at);
    return Promise.resolve();
  }

  unschedule(kind: JobKind, id: string): Promise<void> {
    this.#due.delete(`${kind}:${id}`);
    return Promise.resolve();
  }

  due(now: number, limit: number): Promise<{ kind: JobKind; id: string }[]> {
    return Promise.resolve(
      [...this.#due.entries()]
        .filter(([, at]) => at <= now)
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit)
        .map(([member]) => split(member)),
    );
  }

  #owner(kind: JobKind, id: string): string | undefined {
    const held = this.#locks.get(lockKey(kind, id));
    return held && held.until > this.now() ? held.token : undefined;
  }

  acquire(kind: JobKind, id: string, ms: number): Promise<string | undefined> {
    if (this.#owner(kind, id) !== undefined) return Promise.resolve(undefined);
    const token = randomUUID();
    this.#locks.set(lockKey(kind, id), { token, until: this.now() + ms });
    return Promise.resolve(token);
  }

  extend(kind: JobKind, id: string, token: string, ms: number): Promise<boolean> {
    if (this.#owner(kind, id) !== token) return Promise.resolve(false);
    this.#locks.set(lockKey(kind, id), { token, until: this.now() + ms });
    return Promise.resolve(true);
  }

  release(kind: JobKind, id: string, token: string): Promise<void> {
    if (this.#owner(kind, id) === token) this.#locks.delete(lockKey(kind, id));
    return Promise.resolve();
  }
}
