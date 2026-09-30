/**
 * The sync error worth showing: only while the mailbox is actually failing
 * (its last failure is newer than its last success) or needs a new
 * sign-in/password. A mailbox that failed once and has synced fine since
 * keeps the old message in lastSyncError for the record — showing it would
 * report a problem that is already gone.
 */
export function currentSyncError(m: { status: string; lastSyncError: string | null; lastSyncSuccessAt: string | null; lastSyncFailureAt: string | null }): string | null {
  if (!m.lastSyncError) return null;
  if (m.status === "reauth_required") return m.lastSyncError;
  if (!m.lastSyncFailureAt) return null;
  if (m.lastSyncSuccessAt && new Date(m.lastSyncSuccessAt) >= new Date(m.lastSyncFailureAt)) return null;
  return m.lastSyncError;
}
