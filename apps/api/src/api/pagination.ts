import { z } from "zod";
import { ValidationError } from "./errors/ApiError.js";

/**
 * One consistent pagination mechanism (Phase 6 brief §17): cursor-based, the
 * cursor opaquely encoding the last-seen row's `id`. Every collection endpoint's
 * query is ordered `[<a field>, id]` (id as the deterministic tiebreaker — two
 * rows can share a createdAt timestamp; id never repeats), so a cursor position
 * is always unambiguous regardless of how many rows share the same primary sort
 * value.
 *
 * No unbounded `findMany()` anywhere: every list query fetches `limit + 1` rows
 * (to compute `hasMore` without a second COUNT query) and callers always pass an
 * explicit, validated limit.
 */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * A defensive cap for the handful of places that load a small, naturally-bounded
 * NESTED collection (e.g. one destination's channel-version history, one email's
 * action executions) without going through paginateByCursor — those aren't
 * top-level paginated collection endpoints, but §17/§30 still call for no truly
 * unbounded findMany() anywhere. In every real deployment these lists stay far
 * below this cap; it exists purely so a pathological case (e.g. a bug causing
 * runaway retries) can't turn one nested query into an unbounded one.
 */
export const MAX_NESTED_ROWS = 200;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE, `limit must be at most ${MAX_PAGE_SIZE}`).optional(),
  cursor: z.string().min(1).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface CursorPage<T> {
  data: T[];
  pagination: { nextCursor: string | null; hasMore: boolean };
}

export function resolveLimit(query: PaginationQuery): number {
  return query.limit ?? DEFAULT_PAGE_SIZE;
}

/** Opaque only by convention (base64url) — not a security boundary; a cursor is scoped by the SAME tenant-filtered query it was issued from, so decoding it never reveals or grants access to anything the caller couldn't already see. */
export function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!decoded) throw new Error("empty");
    return decoded;
  } catch {
    throw new ValidationError(`"cursor" is not a valid pagination cursor`);
  }
}

/**
 * Runs a `findMany`-shaped query for one page. `fetchPage` receives the decoded
 * cursor id (undefined for the first page) and the row count to request
 * (limit + 1) — the caller's own Prisma query supplies `cursor`/`skip`/`take`/
 * `orderBy` using those, since that shape differs per model.
 */
export async function paginateByCursor<T extends { id: string }>(
  query: PaginationQuery,
  fetchPage: (args: { cursorId?: string; take: number }) => Promise<T[]>,
): Promise<CursorPage<T>> {
  const limit = resolveLimit(query);
  const cursorId = query.cursor ? decodeCursor(query.cursor) : undefined;

  const rows = await fetchPage({ cursorId, take: limit + 1 });
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];

  return {
    data,
    pagination: { nextCursor: hasMore && last ? encodeCursor(last.id) : null, hasMore },
  };
}
