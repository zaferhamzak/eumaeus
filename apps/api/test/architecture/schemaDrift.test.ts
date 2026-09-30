import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 1.1 (B): the migrations and schema.prisma must describe the same database.
 * A change made only in schema.prisma (for example a new default) passes
 * every other test, because the Prisma client is generated from the schema,
 * but a database built from the migrations never gets it. That is how
 * `system_settings.smtp_from_name` kept its "Jev Mail" default after the
 * rename.
 *
 * The test database is brought up to date with `prisma migrate deploy`
 * before the suite runs (CI does it; locally the same command against
 * DATABASE_URL_TEST), so diffing it against the schema shows exactly what a
 * migration would still have to do. A failure here can also simply mean the
 * test database missed a deploy — the message says which statement differs.
 */
const API_DIR = join(import.meta.dirname, "../..");

/**
 * Differences already known and waiting for their migration (each needs the
 * owner's approval). Remove an entry when its migration lands; an entry that
 * no longer appears fails the test too, so the list can't go stale.
 */
const KNOWN_PENDING: string[] = [];

function pendingStatements(): string[] {
  const out = execFileSync(join(API_DIR, "node_modules/.bin/prisma"), ["migrate", "diff", "--from-url", process.env.DATABASE_URL!, "--to-schema-datamodel", "prisma/schema.prisma", "--script"], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("--"));
}

describe("schema drift", () => {
  it("the migrated database matches schema.prisma (apart from the listed pending changes)", () => {
    const pending = pendingStatements().filter((s) => s !== "-- This is an empty migration.");
    expect(pending.filter((s) => !KNOWN_PENDING.includes(s)), "schema.prisma has changes no migration makes — write one").toEqual([]);
    expect(KNOWN_PENDING.filter((s) => !pending.includes(s)), "a listed pending change is gone — remove it from KNOWN_PENDING").toEqual([]);
  }, 60_000);
});
