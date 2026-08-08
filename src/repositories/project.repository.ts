import { prisma } from "../config/database.js";
import type { Project } from "../generated/prisma/client.js";

/**
 * All database access for projects.
 *
 * Note that every read here is scoped by `userId` as well as `id`. That is the
 * tenancy boundary, and enforcing it in the query rather than with an `if`
 * after the fetch matters: a forgotten check leaks another customer's data,
 * whereas a query that filters on both simply returns nothing.
 */

export async function createProject(userId: string, name: string): Promise<Project> {
  return prisma.project.create({ data: { userId, name } });
}

export async function listProjectsForUser(userId: string): Promise<Project[]> {
  return prisma.project.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Fetch a project the given user owns. Returns null if it doesn't exist *or*
 * belongs to somebody else — the caller cannot tell those apart, which is
 * deliberate. Distinguishing them would confirm the existence of another
 * customer's project.
 */
export async function findProjectForUser(
  projectId: string,
  userId: string,
): Promise<Project | null> {
  return prisma.project.findFirst({ where: { id: projectId, userId } });
}

export async function deleteProject(projectId: string, userId: string): Promise<boolean> {
  const result = await prisma.project.deleteMany({ where: { id: projectId, userId } });
  return result.count > 0;
}
