/**
 * Valkey connection targets (card 17.3). `VALKEY_URL` is either a normal `redis://` / `rediss://`
 * URL, or a Sentinel address for high availability:
 *
 *   redis+sentinel://[:password@]sentinel-1:26379,sentinel-2:26379,sentinel-3:26379/mymaster[/db]
 *
 * With Sentinel the client asks the sentinels for the current primary and reconnects by itself
 * after a failover, so no service has to be reconfigured or restarted.
 */
export interface ValkeySentinelOptions {
  sentinels: { host: string; port: number }[];
  /** Name of the monitored primary (the `sentinel monitor <name>` group). */
  name: string;
  password?: string;
  username?: string;
  db?: number;
  /** Set for `rediss+sentinel://`: TLS to the primary/replicas and to the sentinels. */
  tls?: Record<string, never>;
  sentinelTLS?: Record<string, never>;
  enableTLSForSentinelMode?: boolean;
}

export type ValkeyTarget =
  { kind: 'url'; url: string } | { kind: 'sentinel'; options: ValkeySentinelOptions };

const SENTINEL_SCHEME = /^rediss?\+sentinel:\/\//i;

export function parseValkeyUrl(url: string): ValkeyTarget {
  if (!SENTINEL_SCHEME.test(url)) return { kind: 'url', url };
  const secure = /^rediss\+/i.test(url);
  // Query parameters are not part of the primary name or the database index.
  const rest = url.replace(SENTINEL_SCHEME, '').replace(/[?#].*$/s, '');
  const at = rest.lastIndexOf('@');
  const auth = at >= 0 ? rest.slice(0, at) : '';
  const [hosts = '', name = '', db] = (at >= 0 ? rest.slice(at + 1) : rest).split('/');
  const sentinels = hosts
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      // IPv6 literals are bracketed (`[::1]:26379`); the client wants the bare address.
      const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
      const colon = v6 ? -1 : entry.lastIndexOf(':');
      const host = v6 ? (v6[1] ?? '') : colon > 0 ? entry.slice(0, colon) : entry;
      const port = v6
        ? v6[2] === undefined
          ? 26_379
          : Number(v6[2])
        : colon > 0
          ? Number(entry.slice(colon + 1))
          : 26_379;
      if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535)
        throw new Error(`invalid sentinel address in VALKEY_URL: ${entry}`);
      return { host, port };
    });
  if (sentinels.length === 0) throw new Error('VALKEY_URL has no sentinel hosts');
  if (!name)
    throw new Error('VALKEY_URL needs the primary name: redis+sentinel://host:26379/<name>');
  const [username = '', password = ''] = auth.includes(':') ? auth.split(/:(.*)/s) : ['', auth];
  const dbIndex = db === undefined || db === '' ? undefined : Number(db);
  if (dbIndex !== undefined && (!Number.isInteger(dbIndex) || dbIndex < 0))
    throw new Error(`invalid database index in VALKEY_URL: ${String(db)}`);
  return {
    kind: 'sentinel',
    options: {
      sentinels,
      name: decodeURIComponent(name),
      ...(password ? { password: decodeURIComponent(password) } : {}),
      ...(username ? { username: decodeURIComponent(username) } : {}),
      ...(dbIndex !== undefined ? { db: dbIndex } : {}),
      ...(secure ? { tls: {}, sentinelTLS: {}, enableTLSForSentinelMode: true } : {}),
    },
  };
}

/** The two ioredis constructor shapes used here: `(url, options)` and `(options)`. */
export interface ValkeyClientConstructor<Client> {
  new (url: string, options: object): Client;
  new (options: object): Client;
}

/**
 * Creates a client for either address form. `options` are the caller's ioredis options (retry
 * policy, offline queue, …) and win over anything derived from the URL.
 */
export function connectValkey<Client>(
  Ctor: ValkeyClientConstructor<Client>,
  url: string,
  options: object = {},
): Client {
  const target = parseValkeyUrl(url);
  return target.kind === 'url'
    ? new Ctor(target.url, options)
    : new Ctor({ ...target.options, ...options });
}
