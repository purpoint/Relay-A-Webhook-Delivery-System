/**
 * The execution window.
 *
 * Relay's central claim is that Redis never holds more than a fixed number of
 * jobs, no matter how large the backlog in Postgres grows. This interface is
 * where that claim is enforced, and it is deliberately small — the whole
 * contract is "put jobs in, take jobs out, tell me how full you are".
 *
 * It exists as an interface rather than a concrete class for one practical
 * reason: the scheduler and worker tests can drive an in-memory implementation
 * without a live Redis, which keeps their assertions about *scheduling*
 * behaviour from depending on a running server.
 */
export interface QueueAdapter {
  /**
   * Offer delivery IDs to the window, up to its capacity.
   *
   * Returns the IDs actually accepted, which may be fewer than offered — the
   * window may have filled, or an ID may already be present. The caller must
   * treat the returned list as authoritative and not assume its whole batch
   * went in.
   */
  enqueue(deliveryIds: string[]): Promise<string[]>;

  /**
   * Claim the next job, moving it from the ready list to the in-flight list.
   *
   * Blocks up to `timeoutSeconds` waiting for work, then resolves null. The
   * move is atomic: a job is never in neither list, so a worker crashing
   * between "take" and "start" cannot lose it.
   */
  claim(timeoutSeconds: number): Promise<string | null>;

  /**
   * Release a job from the window once its outcome is decided — delivered,
   * failed, or rescheduled for later.
   *
   * Must be called on every terminal path. A job left in-flight occupies a
   * slot forever, and enough of them would starve the window.
   */
  complete(deliveryId: string): Promise<void>;

  /**
   * How many jobs currently occupy the window: ready plus in-flight.
   *
   * This is the number the whole architecture exists to bound, and the one
   * the M5 load test watches.
   */
  occupancy(): Promise<number>;

  /** Ready jobs and in-flight jobs separately, for diagnostics. */
  stats(): Promise<{ ready: number; inFlight: number; capacity: number }>;

  /** Remove everything. Test helper; never called in normal operation. */
  clear(): Promise<void>;
}
