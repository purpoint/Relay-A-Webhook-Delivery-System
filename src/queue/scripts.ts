/**
 * Lua scripts run inside Redis.
 *
 * Redis executes a script atomically — nothing else runs against the server
 * while it does. That is the only reason these exist. Both operations below
 * are read-then-write sequences, and doing them as separate commands from
 * Node would leave a gap in which another scheduler could act on stale
 * information.
 *
 * They are inlined as strings rather than kept as .lua files so `tsc` produces
 * a complete `dist/` with no asset-copying step. The scripts are short enough
 * that readability does not suffer, and ioredis caches them server-side after
 * first use.
 */

/**
 * Offer delivery IDs to the window, respecting its capacity.
 *
 * KEYS[1] ready list        KEYS[2] in-flight list      KEYS[3] dedupe set
 * ARGV[1] capacity          ARGV[2..] delivery IDs
 *
 * Returns the IDs actually accepted.
 *
 * The atomicity matters because the sequence is check-then-write. Run as
 * separate commands with two schedulers active:
 *
 *   Scheduler A: LLEN → 4,900. Room for 100.
 *   Scheduler B: LLEN → 4,900. Room for 100.
 *   Scheduler A: RPUSH 100 → 5,000
 *   Scheduler B: RPUSH 100 → 5,100   ← over capacity
 *
 * Both read a true value and both acted on it, and the invariant the entire
 * project is built on is broken. Inside a script, B cannot read until A has
 * finished writing.
 *
 * Capacity is re-checked on every iteration rather than computed once, so a
 * batch larger than the remaining space fills the window exactly and stops.
 */
export const ENQUEUE_LUA = `
local readyKey    = KEYS[1]
local inFlightKey = KEYS[2]
local dedupeKey   = KEYS[3]
local capacity    = tonumber(ARGV[1])

-- Occupancy counts in-flight jobs too. They are out of the ready list but
-- still resident in the window, and still consuming memory.
local occupancy = redis.call('LLEN', readyKey) + redis.call('LLEN', inFlightKey)

local accepted = {}

for i = 2, #ARGV do
  if occupancy >= capacity then
    break
  end

  local deliveryId = ARGV[i]

  -- SADD returns 1 when the member is new, 0 when already present. Using its
  -- return value makes "is it already queued?" and "mark it queued" a single
  -- indivisible step, rather than SISMEMBER followed by SADD.
  if redis.call('SADD', dedupeKey, deliveryId) == 1 then
    redis.call('RPUSH', readyKey, deliveryId)
    occupancy = occupancy + 1
    accepted[#accepted + 1] = deliveryId
  end
end

return accepted
`;

/**
 * Release a job from the window.
 *
 * KEYS[1] in-flight list    KEYS[2] dedupe set    ARGV[1] delivery ID
 *
 * Returns 1 if the job was in flight, 0 if it had already been released.
 *
 * Atomic so a job can never be absent from the in-flight list while still
 * present in the dedupe set — a state in which the scheduler would refuse to
 * re-queue the delivery ever again, because the set says it is already
 * there, while nothing is actually going to execute it. That is a permanently
 * stuck delivery, and it is exactly the kind of slow leak that only shows up
 * in production weeks later.
 *
 * LREM with count 0 removes every occurrence, which is defensive: there should
 * only ever be one, and if a bug produced duplicates we would rather clear
 * them than leak a slot.
 */
export const COMPLETE_LUA = `
local inFlightKey = KEYS[1]
local dedupeKey   = KEYS[2]
local deliveryId  = ARGV[1]

local removed = redis.call('LREM', inFlightKey, 0, deliveryId)
redis.call('SREM', dedupeKey, deliveryId)

return removed
`;

/**
 * Return orphaned in-flight jobs to the ready list.
 *
 * KEYS[1] in-flight list    KEYS[2] ready list    ARGV[1..] delivery IDs
 *
 * Used by the scheduler's reaper once Postgres has decided a delivery's lease
 * expired — meaning the worker holding it died. Postgres is the source of
 * truth about what is stale; this only carries out the decision in Redis.
 */
export const REQUEUE_LUA = `
local inFlightKey = KEYS[1]
local dedupeKey   = KEYS[2]
local requeued = 0

for i = 1, #ARGV do
  local deliveryId = ARGV[i]
  if redis.call('LREM', inFlightKey, 0, deliveryId) > 0 then
    requeued = requeued + 1
  end
  -- Drop from the dedupe set so the scheduler is free to offer it again once
  -- Postgres marks it eligible.
  redis.call('SREM', dedupeKey, deliveryId)
end

return requeued
`;
