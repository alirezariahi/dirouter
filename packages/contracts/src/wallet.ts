/**
 * Prepaid wallet mirror in Valkey (card 19.1).
 *
 * Postgres owns the ledger, but the gateway never queries Postgres on the hot path (ADR-006). It
 * reserves credit against a copy of each wallet kept in Valkey:
 *
 * - `dirouter:wallet:{id}`       hash: `balance`, `quota` (plan allowance left this period, card
 *                                19.4) and `version` (copied from Postgres) and `held`
 * - `dirouter:wallet:{id}:holds` hash: requestId → `<units>:<expiresAtMs>`
 *
 * Flow: the gateway reserves the request's worst-case charge (RESERVE), replaces it with the real
 * charge when the response ends (SETTLE), and the worker removes the hold when it has posted the
 * debit to Postgres and copies the new balance (APPLY). Balances carry the Postgres version, so an
 * older copy never overwrites a newer one. SYNC (the worker's reconcile) restores missing wallets
 * and drops holds whose owner died.
 *
 * Amounts are integer units (1 USD = 10^8), the same as the budget counters. Both keys share the
 * `{id}` hash tag so the scripts also work on a Valkey cluster.
 */

export const walletKey = (walletId: string) => `dirouter:wallet:{${walletId}}`;
export const walletHoldsKey = (walletId: string) => `dirouter:wallet:{${walletId}}:holds`;

/** A reservation outlives the longest request (streams included). */
export const WALLET_HOLD_TTL_MS = 30 * 60_000;
/** After settle, the hold waits this long for the worker to post the debit. */
export const WALLET_SETTLED_TTL_MS = 6 * 3_600_000;

/**
 * KEYS: wallet, holds. ARGV: requestId, units, expiresAtMs.
 * Returns {status, available}: 1 reserved, 0 insufficient credit, -1 wallet unknown to Valkey.
 */
export const WALLET_RESERVE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1, 0} end
local balance = tonumber(redis.call('HGET', KEYS[1], 'balance') or '0')
  + tonumber(redis.call('HGET', KEYS[1], 'quota') or '0')
local held = tonumber(redis.call('HGET', KEYS[1], 'held') or '0')
local amount = tonumber(ARGV[2])
local available = balance - held
if available < amount then return {0, available} end
redis.call('HINCRBY', KEYS[1], 'held', amount)
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2] .. ':' .. ARGV[3])
return {1, available - amount}
`;

/**
 * KEYS: wallet, holds. ARGV: requestId, actualUnits, expiresAtMs.
 * Replaces the reservation with the real charge (or drops it when nothing is charged).
 */
export const WALLET_SETTLE_LUA = `
local hold = redis.call('HGET', KEYS[2], ARGV[1])
if not hold then return 0 end
local reserved = tonumber(string.match(hold, '^(%-?%d+)'))
local actual = tonumber(ARGV[2])
if actual <= 0 then
  redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('HINCRBY', KEYS[1], 'held', -reserved)
  return 1
end
redis.call('HINCRBY', KEYS[1], 'held', actual - reserved)
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2] .. ':' .. ARGV[3])
return 1
`;

/**
 * KEYS: wallet, holds. ARGV: requestId ('' for none), balanceUnits, version, quotaUnits.
 * Called after a posting commits: drops the request's hold and stores the newer balance.
 */
export const WALLET_APPLY_LUA = `
if ARGV[1] ~= '' then
  local hold = redis.call('HGET', KEYS[2], ARGV[1])
  if hold then
    redis.call('HDEL', KEYS[2], ARGV[1])
    redis.call('HINCRBY', KEYS[1], 'held', -tonumber(string.match(hold, '^(%-?%d+)')))
  end
end
local current = tonumber(redis.call('HGET', KEYS[1], 'version') or '-1')
if tonumber(ARGV[3]) > current then
  redis.call('HSET', KEYS[1], 'balance', ARGV[2], 'version', ARGV[3], 'quota', ARGV[4] or '0')
end
if not redis.call('HGET', KEYS[1], 'held') then redis.call('HSET', KEYS[1], 'held', 0) end
return 1
`;

/**
 * KEYS: wallet, holds. ARGV: balanceUnits, version, nowMs, quotaUnits.
 * Reconcile: stores the balance unless Valkey already has a newer one, drops expired holds and
 * recomputes `held` from the holds that remain. Returns the held units.
 */
export const WALLET_SYNC_LUA = `
local current = tonumber(redis.call('HGET', KEYS[1], 'version') or '-1')
if tonumber(ARGV[2]) >= current then
  redis.call('HSET', KEYS[1], 'balance', ARGV[1], 'version', ARGV[2], 'quota', ARGV[4] or '0')
end
local now = tonumber(ARGV[3])
local held = 0
local holds = redis.call('HGETALL', KEYS[2])
for i = 1, #holds, 2 do
  local units, expires = string.match(holds[i + 1], '^(%-?%d+):(%d+)$')
  if not units or tonumber(expires) <= now then
    redis.call('HDEL', KEYS[2], holds[i])
  else
    held = held + tonumber(units)
  end
end
redis.call('HSET', KEYS[1], 'held', held)
return held
`;
