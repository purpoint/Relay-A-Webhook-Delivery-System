import { prisma } from "../config/database.js";
import type { Delivery } from "../generated/prisma/client.js";

/**
 * Database access for deliveries — the rows the execution window schedules.
 */

interface IdRow {
  id: string;
}

/**
 * Claim eligible deliveries and hand them to the execution window.
 *
 * The window is offered the IDs *inside* the transaction, and only the ones it
 * accepts are marked QUEUED. That ordering is what makes the whole step
 * self-healing, and it is worth walking through the failure cases:
 *
 *   Redis rejects some IDs (window full) — those rows are simply left
 *   PENDING and picked up on a later tick.
 *
 *   Redis is unreachable — the callback throws, the transaction rolls back,
 *   nothing changed anywhere.
 *
 *   The process dies after Redis accepted but before the commit — the rows
 *   roll back to PENDING while the IDs remain in Redis. A worker later claims
 *   one, finds the row is not QUEUED, discards it and releases the slot. The
 *   delivery stays PENDING and is rescheduled normally.
 *
 * Every one of those degrades to "try again shortly" rather than to a stuck
 * or duplicated delivery.
 *
 * FOR UPDATE SKIP LOCKED is what allows more than one scheduler to run. It
 * locks the selected rows and tells any concurrent transaction to pass over
 * locked rows rather than wait for them, so two schedulers claim disjoint
 * sets instead of blocking on each other or handing the same delivery out
 * twice. Prisma has no API for it, so this one query is raw SQL.
 */
export async function claimEligibleDeliveries(
  limit: number,
  offerToWindow: (deliveryIds: string[]) => Promise<string[]>,
): Promise<string[]> {
  if (limit <= 0) return [];

  /**
   * "Now" is supplied by the application, not read from the database clock.
   *
   * `nextRetryAt` is a `timestamp without time zone` holding UTC values, which
   * is how Prisma writes DateTime. Postgres `now()` returns `timestamptz`, and
   * comparing the two makes Postgres cast one to the session's timezone — so
   * the comparison silently depends on a server setting that has nothing to do
   * with this application.
   *
   * On a machine set to Asia/Kolkata that made the query's "now" five and a
   * half hours early, and every retry scheduled less than five and a half
   * hours ahead fired immediately. In a negative-offset timezone the same bug
   * runs the other way and deliveries stall past their due time.
   *
   * Binding a JS Date is serialised by Prisma the same way it writes the
   * column, so the comparison is timezone-independent.
   */
  const now = new Date();

  /**
   * Step one: claim and mark QUEUED, then commit.
   *
   * Nothing is published to Redis inside this transaction, and that ordering
   * was arrived at the hard way. Publishing first looks appealing — a failed
   * push simply rolls the claim back — but it loses a race that turns out to
   * happen constantly under load:
   *
   *   scheduler  pushes ID to Redis (transaction still open)
   *   worker     claims the ID, runs UPDATE ... WHERE status = 'QUEUED'
   *   worker     sees PENDING in its snapshot, so matches zero rows. It does
   *              not even block, because a row failing the WHERE clause is
   *              never a candidate for the row lock.
   *   worker     treats it as an orphan, skips it, releases the Redis slot
   *   scheduler  commits, marking the row QUEUED
   *
   * The delivery is now QUEUED in Postgres and absent from Redis: invisible to
   * the scheduler, which only looks at PENDING and WAITING, and to the
   * workers, which only see Redis. It would sit there forever. A live run
   * accumulated 1,216 such rows in twenty seconds.
   *
   * Committing first means a worker cannot encounter an ID before the row is
   * durably QUEUED.
   */
  const claimedIds = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<IdRow[]>`
      SELECT id
      FROM deliveries
      WHERE status = 'PENDING'::"DeliveryStatus"
         OR (status = 'WAITING'::"DeliveryStatus" AND "nextRetryAt" <= ${now})
      ORDER BY "nextRetryAt" ASC NULLS FIRST, "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;

    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);

    await tx.delivery.updateMany({
      where: { id: { in: ids } },
      data: { status: "QUEUED" },
    });

    return ids;
  });

  if (claimedIds.length === 0) return [];

  /**
   * Step two: publish.
   *
   * The window is the only thing that can decline, and whatever it declines is
   * returned to PENDING so a later tick retries it.
   *
   * This does introduce one narrow failure of its own: if the process dies
   * between the commit and the push, those rows are QUEUED with nothing in
   * Redis — the same orphan state, now rare rather than routine. The
   * scheduler's orphan sweep exists to recover exactly that case, and is not
   * optional given this ordering.
   */
  let accepted: string[];

  try {
    accepted = await offerToWindow(claimedIds);
  } catch (error) {
    // Redis unreachable. Undo the claim so the next tick can try again.
    await resetToPending(claimedIds);
    throw error;
  }

  if (accepted.length < claimedIds.length) {
    const acceptedSet = new Set(accepted);
    const rejected = claimedIds.filter((id) => !acceptedSet.has(id));
    await resetToPending(rejected);
  }

  return accepted;
}

/**
 * Return deliveries abandoned by dead workers to the retry queue.
 *
 * A worker sets status PROCESSING and stamps lockedAt when it claims a
 * delivery. If it dies mid-request — crash, OOM kill, an abrupt deploy — the
 * row stays PROCESSING forever and its Redis slot is never released. Enough of
 * those and the window fills with work nobody is doing.
 *
 * Postgres owns this decision because Postgres holds the timestamps and is the
 * source of truth. Redis is told afterwards.
 *
 * The attempt counter is incremented even though the worker never got a
 * response. That is deliberate: a delivery that reliably kills the worker
 * handling it would otherwise cycle forever, taking a worker down each time.
 * Counting the attempt means such a delivery eventually reaches FAILED instead
 * of becoming a permanent hazard. The cost is that a routine deploy consumes
 * one attempt from anything in flight, which is an acceptable trade against
 * MAX_ATTEMPTS.
 */
export async function reclaimExpiredLeases(leaseTimeoutMs: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - leaseTimeoutMs);

  const expired = await prisma.delivery.findMany({
    where: { status: "PROCESSING", lockedAt: { lt: cutoff } },
    select: { id: true },
  });

  if (expired.length === 0) return [];

  const ids = expired.map((row) => row.id);

  await prisma.delivery.updateMany({
    where: { id: { in: ids }, status: "PROCESSING" },
    data: {
      status: "WAITING",
      // Eligible immediately — the delivery was never actually attempted as
      // far as anyone knows, so there is nothing to back off from.
      nextRetryAt: new Date(),
      lockedAt: null,
      attempt: { increment: 1 },
      lastError: "Worker lease expired; delivery was reclaimed",
    },
  });

  return ids;
}

/**
 * Deliveries stuck QUEUED but absent from Redis.
 *
 * Should not normally occur — the claim transaction above is arranged so that
 * a crash leaves rows PENDING rather than QUEUED. This exists because "should
 * not occur" is not a guarantee, and a QUEUED row missing from the window is
 * invisible to both the scheduler (which only looks at PENDING and WAITING)
 * and the workers (which only see what Redis gives them). Without a sweep it
 * would sit there indefinitely.
 *
 * The caller supplies the IDs currently known to Redis; anything QUEUED and
 * older than the grace period that is not among them is orphaned. The grace
 * period avoids racing a scheduler that has just committed.
 */
export async function findOrphanedQueued(graceMs: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - graceMs);

  const rows = await prisma.delivery.findMany({
    where: { status: "QUEUED", updatedAt: { lt: cutoff } },
    select: { id: true },
  });

  return rows.map((row) => row.id);
}

export async function resetToPending(deliveryIds: string[]): Promise<number> {
  if (deliveryIds.length === 0) return 0;

  const result = await prisma.delivery.updateMany({
    where: { id: { in: deliveryIds }, status: "QUEUED" },
    data: { status: "PENDING", lockedAt: null },
  });

  return result.count;
}

/** Counts by status, for the scheduler's periodic log line and M6's monitor. */
export async function countByStatus(): Promise<Record<string, number>> {
  const rows = await prisma.delivery.groupBy({
    by: ["status"],
    _count: { _all: true },
  });

  return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
}

export async function countEligibleNow(): Promise<number> {
  return prisma.delivery.count({
    where: {
      OR: [
        { status: "PENDING" },
        { status: "WAITING", nextRetryAt: { lte: new Date() } },
      ],
    },
  });
}

export async function findDeliveryById(id: string): Promise<Delivery | null> {
  return prisma.delivery.findUnique({ where: { id } });
}
