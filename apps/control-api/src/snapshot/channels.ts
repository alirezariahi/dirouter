/** Valkey channels for publishing the snapshot (no Nest dependency so scripts can import them too). */
export const CONFIG_CHANNEL = 'dirouter:config:updated';
/** Rebuild request from outside the API (for example, seed or an admin tool). */
export const REBUILD_CHANNEL = 'dirouter:config:rebuild';
