import { useEffect, useRef, useState } from "react";
import { monitor, type MonitorSnapshot, type Project } from "./api";

/**
 * The page the whole milestone exists for.
 *
 * Two bars side by side. Postgres climbs without limit; Redis stops at its
 * cap and stays there. Read together they make the architecture obvious in a
 * few seconds, which a table of numbers does not.
 */

const STATUS_ORDER = [
  "PENDING",
  "QUEUED",
  "PROCESSING",
  "WAITING",
  "DELIVERED",
  "FAILED",
] as const;

const POLL_MS = 1000;

interface Props {
  project: Project;
}

export function Monitor({ project }: Props) {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Highest occupancy seen this session.
   *
   * The single most useful number on the page. A live reading only shows the
   * cap holding *now*; the peak shows it held throughout, including moments
   * between polls that were never rendered.
   */
  const [peak, setPeak] = useState(0);

  // Ref rather than state: the poll loop reads it without needing to be torn
  // down and recreated every time the peak changes.
  const peakRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    peakRef.current = 0;
    setPeak(0);
    setSnapshot(null);

    async function tick() {
      try {
        const next = await monitor(project.id);
        if (cancelled) return;

        if (next.window.occupancy > peakRef.current) {
          peakRef.current = next.window.occupancy;
          setPeak(next.window.occupancy);
        }

        setSnapshot(next);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        // Keep the last good snapshot on screen rather than blanking the page
        // over one failed poll; the indicator turns red instead.
        setError(caught instanceof Error ? caught.message : "Failed to load");
      }
    }

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [project.id]);

  if (!snapshot) {
    return (
      <p className="muted">{error ?? "Loading…"}</p>
    );
  }

  const { window: w, deliveries, totals } = snapshot;

  /**
   * Postgres has no cap, so its bar needs an arbitrary scale to move against.
   * It grows in powers of ten past the window size, which keeps the visual
   * point intact: whatever Postgres reaches, Redis stays where it is.
   */
  const postgresScale = Math.max(w.capacity, 10 ** Math.ceil(Math.log10(Math.max(totals.deliveries, 1))));

  const atCap = w.occupancy >= w.capacity;

  return (
    <>
      <div className="toolbar">
        <span className="muted">
          <span className={`dot${error ? " stale" : ""}`} />
          {error ? "Reconnecting…" : `Live · updated ${new Date(snapshot.at).toLocaleTimeString()}`}
        </span>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="gauge-label">
            <span className="gauge-title">Postgres — durable</span>
            <span className="gauge-value mono">
              {totals.deliveries.toLocaleString()}
            </span>
          </div>
          <div className="track">
            <div
              className="fill unbounded"
              style={{ width: `${String(Math.min(100, (totals.deliveries / postgresScale) * 100))}%` }}
            />
          </div>
          <p className="gauge-note">
            {totals.events.toLocaleString()} events · unbounded, on disk
          </p>
        </div>

        <div className="panel">
          <div className="gauge-label">
            <span className="gauge-title">Redis — execution window</span>
            <span className="gauge-value mono">
              {w.occupancy.toLocaleString()}
              <span className="gauge-cap"> / {w.capacity.toLocaleString()}</span>
            </span>
          </div>
          <div className="track">
            <div
              className={`fill ${atCap ? "at-cap" : "bounded"}`}
              style={{ width: `${String(Math.min(100, w.utilisation * 100))}%` }}
            />
          </div>
          <p className="gauge-note">
            {w.ready.toLocaleString()} ready · {w.inFlight.toLocaleString()} in flight ·{" "}
            <span className="peak">peak {peak.toLocaleString()}</span>
          </p>
        </div>
      </div>

      <div className="statuses">
        {STATUS_ORDER.map((status) => (
          <div key={status} className={`status ${status}`}>
            <div className="status-name">{status}</div>
            <div className="status-count mono">
              {(deliveries[status] ?? 0).toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      <p className="explain">
        <strong>What to watch.</strong> Publish a large backlog at an endpoint that is
        failing. Postgres climbs without limit while Redis stops at{" "}
        {w.capacity.toLocaleString()} and stays there — and once every delivery has
        failed and is waiting to retry, Redis drops to <strong>zero</strong>, because a{" "}
        <strong>WAITING</strong> delivery lives in Postgres and not in Redis. That is
        the whole design: a backlog of any size costs no memory at all.
      </p>
    </>
  );
}
