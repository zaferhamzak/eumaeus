import { PrismaClient } from "@prisma/client";

// Standard singleton so hot-reloaded scripts/tests don't open a new connection pool
// per import. DATABASE_URL is read by Prisma directly from process.env at
// construction time — tests override it to DATABASE_URL_TEST before this module is
// first imported (see test/setup.ts).
declare global {
  var __prisma: PrismaClient | undefined;
}

export const prisma = global.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
