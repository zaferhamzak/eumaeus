import { describe, expect, it } from "vitest";
import { currentSyncError } from "@/lib/syncError";

const base = { status: "active", lastSyncError: "read ECONNRESET (while connecting / signing in)" };

describe("currentSyncError", () => {
  it("hides an error the mailbox has recovered from", () => {
    expect(currentSyncError({ ...base, lastSyncFailureAt: "2026-09-28T14:18:12Z", lastSyncSuccessAt: "2026-09-28T14:40:30Z" })).toBeNull();
  });
  it("shows it while the mailbox is still failing", () => {
    expect(currentSyncError({ ...base, lastSyncFailureAt: "2026-09-28T14:41:00Z", lastSyncSuccessAt: "2026-09-28T14:40:30Z" })).toBe(base.lastSyncError);
    expect(currentSyncError({ ...base, lastSyncFailureAt: "2026-09-28T14:41:00Z", lastSyncSuccessAt: null })).toBe(base.lastSyncError);
  });
  it("always shows it when a new sign-in or password is needed", () => {
    expect(currentSyncError({ ...base, status: "reauth_required", lastSyncFailureAt: "2026-09-27T23:11:45Z", lastSyncSuccessAt: "2026-09-28T01:00:00Z" })).toBe(base.lastSyncError);
  });
});
