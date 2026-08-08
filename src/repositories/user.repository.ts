import { prisma } from "../config/database.js";
import type { User } from "../generated/prisma/client.js";

/**
 * All database access for users.
 *
 * Confining Prisma calls to this layer means the services above never learn
 * which database we use. It also gives every query about users one place to
 * live, so a change to how we look them up doesn't have to be hunted down
 * across the codebase.
 */

export interface CreateUserInput {
  email: string;
  passwordHash: string;
}

export async function createUser(input: CreateUserInput): Promise<User> {
  return prisma.user.create({ data: input });
}

/**
 * Look up a user for authentication. Returns the password hash, so this is
 * only for the login path — never for anything that ends up in a response.
 */
export async function findUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email } });
}

export async function findUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

export async function emailExists(email: string): Promise<boolean> {
  const found = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  return found !== null;
}
