import { redis } from "../config/redis.js";
import { RedisWindowQueue } from "../queue/RedisWindowQueue.js";
import { env } from "../config/env.js";
import { getOwnedProject } from "./project.service.js";
import { deliveryStatsForProject } from "../repositories/event-query.repository.js";
import { countEventsForProject } from "../repositories/event-query.repository.js";

/**
 * The single call behind the live monitor.
 *
 * The page polls this once a second, so it must stay cheap: two Redis LLENs
 * and two grouped counts, no joins and no scans. Everything expensive belongs
 * on the history endpoints, which a human triggers deliberately.
 */

const queue = new RedisWindowQueue(redis, env.EXECUTION_WINDOW_SIZE);

export interface MonitorSnapshot {
  /**
   * State of the shared execution window.
   *
   * System-wide rather than per-project, because the window *is* system-wide —
   * one bounded pool that every project's deliveries pass through. That is
   * also the number the page exists to display: showing a per-project slice
   * would say nothing about whether the cap holds.
   */
  window: {
    ready: number;
    inFlight: number;
    occupancy: number;
    capacity: number;
    /** Occupancy as a fraction of capacity, for the gauge. */
    utilisation: number;
  };
  /** Delivery counts by status, scoped to the caller's project. */
  deliveries: Record<string, number>;
  totals: {
    events: number;
    deliveries: number;
  };
  at: string;
}

export async function getMonitorSnapshot(
  projectId: string,
  userId: string,
): Promise<MonitorSnapshot> {
  await getOwnedProject(projectId, userId);

  // Issued together: the two datastores are independent, and waiting for one
  // before starting the other would double the poll's latency for no reason.
  const [stats, deliveries, events] = await Promise.all([
    queue.stats(),
    deliveryStatsForProject(projectId),
    countEventsForProject(projectId),
  ]);

  const occupancy = stats.ready + stats.inFlight;

  const total = Object.values(deliveries).reduce((sum, n) => sum + n, 0);

  return {
    window: {
      ready: stats.ready,
      inFlight: stats.inFlight,
      occupancy,
      capacity: stats.capacity,
      utilisation: stats.capacity === 0 ? 0 : occupancy / stats.capacity,
    },
    deliveries,
    totals: { events, deliveries: total },
    at: new Date().toISOString(),
  };
}
