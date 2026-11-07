/**
 * نگه‌داری ConfigSnapshot در حافظه و روی دیسک، و همگام‌سازی با control-api (کارت ۴.۲).
 *
 * - بوت: اول نسخهٔ دیسک (اگر control-api در دسترس نباشد هم گیت‌وی کار می‌کند).
 * - سپس long-poll دوره‌ای با ETag؛ نسخهٔ قدیمی‌تر یا schemaVersion ناشناخته رد می‌شود.
 * - جایگزینی اتمیک: هر درخواست یک snapshot ثابت را می‌بیند.
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

  /** کلید رمزگشایی‌شدهٔ credential (lazy و در حافظه). */
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

  /** بارگذاری از دیسک، سپس یک همگام‌سازی و شروع poll. */
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

  /** اعمال snapshot جدید؛ نسخهٔ قدیمی‌تر رد می‌شود. true یعنی جایگزین شد. */
  apply(raw: unknown, source: string): boolean {
    const parsed = ConfigSnapshot.safeParse(raw);
    if (!parsed.success) {
      this.opts.logger.warn(
        { source, issues: parsed.error.issues.slice(0, 5) },
        'rejected invalid snapshot',
      );
      return false;
    }
    if (this.#current && parsed.data.version <= this.#current.version) return false;
    // credentialهایی که در snapshot جدید فعال‌اند دوباره قابل استفاده می‌شوند.
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
