import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { env, isProduction } from "./env.js";
import { logger } from "../utils/logger.js";

const dbLogger = logger.child({ component: "database" });

/**
 * Postgres connection pool.
 *
 * Prisma 7 drives Postgres through an explicit adapter rather than an embedded
 * engine, which has the useful side effect of putting pool sizing in our hands.
 * `max` matters here: the scheduler holds a transaction open while it claims
 * rows with FOR UPDATE SKIP LOCKED, and every worker needs a connection to read
 * its delivery and write the result. Sizing this too low turns into workers
 * queueing on connection acquisition rather than delivering webhooks.
 */
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_SIZE,
});

/**
 * The single Prisma client for the process.
 *
 * Postgres is Relay's source of truth, so every component — API, scheduler,
 * workers — reaches the database through this one pooled client rather than
 * opening its own.
 */
export const prisma = new PrismaClient({
  adapter,
  log: isProduction
    ? [{ emit: "event", level: "error" }]
    : [
        { emit: "event", level: "error" },
        { emit: "event", level: "warn" },
      ],
});

prisma.$on("error", (e) => {
  dbLogger.error({ target: e.target }, e.message);
});

if (!isProduction) {
  prisma.$on("warn", (e) => {
    dbLogger.warn({ target: e.target }, e.message);
  });
}

/** Cheap round-trip used by the readiness probe. */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    dbLogger.error({ err: error }, "Database health check failed");
    return false;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  dbLogger.info("Database connection closed");
}
