/**
 * Keeps ConfigSnapshot in memory and on disk, and syncs it with control-api (card 4.2).
 *
 * - Boot: load the disk copy first (the gateway still works if control-api is unavailable).
 * - Then periodic long-poll with ETag; an older version or unknown schemaVersion is rejected.
 * - Atomic swap: each request sees one fixed snapshot.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ConfigSnapshot, type VirtualKeyConfig } from '@dirouter/contracts';
import { type HealthRegistry, RouteIndex, Router } from '@dirouter/routing';
import { decrypt, type Keyring, type Logger } from '@dirouter/shared';

export class LoadedConfig {
  readonly router: Router;
  readonly keysByHash = new Map<string, VirtualKeyConfig>();
  readonly #secrets = new Map<string, string>();

  constructor(
    readonly snapshot: ConfigSnapshot,
    health: HealthRegistry,
    private readonly keyring: Keyring,
  ) {
    this.router = new Router(new RouteIndex(snapshot), health);
    for (const key of snapshot.virtualKeys) this.keysByHash.set(key.hash, key);
  }

  get version(): number {
    return this.snapshot.version;
  }

  /** Decrypted credential key (lazy, in memory). */
  secret(credentialId: string, ciphertext: string): string {
    let value = this.#secrets.get(credentialId);
    if (value === undefined) {
      value = decrypt(this.keyring, ciphertext, credentialId);
      this.#secrets.set(credentialId, value);
    }
    return value;
  }
}

export interface ConfigStoreOptions {
  dataDir: string;
  controlApiUrl?: string;
  internalToken?: string;
  pollIntervalMs?: number;
  keyring: Keyring;
  health: HealthRegistry;
  logger: Logger;
}

export class ConfigStore {
  #current: LoadedConfig | undefined;
  #etag: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #lastSyncOk = false;

  constructor(private readonly opts: ConfigStoreOptions) {}

  get current(): LoadedConfig | undefined {
    return this.#current;
  }

  get healthRegistry(): HealthRegistry {
    return this.opts.health;
  }

  get ready(): boolean {
    return this.#current !== undefined;
  }

  get lastSyncOk(): boolean {
    return this.#lastSyncOk;
  }

  get #file(): string {
    return join(this.opts.dataDir, 'snapshot.json');
  }

  /** Load from disk, then run one sync and start polling. */
  async start(): Promise<void> {
    try {
      this.apply(JSON.parse(await readFile(this.#file, 'utf8')), 'disk');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.opts.logger.warn({ err: error }, 'snapshot on disk is invalid; ignoring');
    }
    await this.sync();
    if (this.opts.controlApiUrl) {
      this.#timer = setInterval(() => void this.sync(), this.opts.pollIntervalMs ?? 2_000);
      this.#timer.unref();
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** Apply a new snapshot; an older version is rejected. true means it was replaced. */
  apply(raw: unknown, source: string): boolean {
    const parsed = ConfigSnapshot.safeParse(raw);
    if (!parsed.success) {
      this.opts.logger.warn(
        { source, issues: parsed.error.issues.slice(0, 5) },
        'rejected invalid snapshot',
      );
      return false;
    }
    // control-api is the source of truth: any differing version from it is accepted (e.g. after a DB restore
    // or a dev test-snapshot replacement). The disk version is used only if it is newer.
    if (this.#current) {
      const same =
        parsed.data.version === this.#current.version &&
        parsed.data.checksum === this.#current.snapshot.checksum;
      if (same || (source !== 'control-api' && parsed.data.version <= this.#current.version))
        return false;
    }
    // Credentials that are active in the new snapshot become usable again.
    const previous = this.#current;
    this.#current = new LoadedConfig(parsed.data, this.opts.health, this.opts.keyring);
    if (previous) {
      const oldSecrets = new Map(
        previous.snapshot.providers.flatMap((p) => p.credentials.map((c) => [c.id, c.secret])),
      );
      for (const p of parsed.data.providers)
        for (const c of p.credentials)
          if (oldSecrets.get(c.id) !== c.secret) this.opts.health.enableCredential(c.id);
    }
    this.opts.logger.info({ version: parsed.data.version, source }, 'config snapshot applied');
    return true;
  }

  async sync(): Promise<void> {
    if (!this.opts.controlApiUrl) return;
    try {
      const res = await fetch(`${this.opts.controlApiUrl}/internal/config/snapshot`, {
        headers: {
          authorization: `Bearer ${this.opts.internalToken ?? ''}`,
          ...(this.#etag ? { 'if-none-match': this.#etag } : {}),
        },
        signal: AbortSignal.timeout(5_000),
      });
      this.#lastSyncOk = res.status === 200 || res.status === 304;
      if (res.status !== 200) return;
      const body: unknown = await res.json();
      if (this.apply(body, 'control-api')) {
        this.#etag = res.headers.get('etag') ?? undefined;
        await this.#persist(body);
      }
    } catch (error) {
      this.#lastSyncOk = false;
      this.opts.logger.debug({ err: error }, 'config sync failed; keeping current snapshot');
    }
  }

  async #persist(body: unknown): Promise<void> {
    await mkdir(this.opts.dataDir, { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(body));
    await rename(tmp, this.#file);
  }
}
