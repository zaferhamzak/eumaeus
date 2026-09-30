import type { Membership, User } from "@prisma/client";

export interface MembershipResponse {
  id: string;
  userId: string;
  email: string;
  permissions: string[];
  status: string;
  invitedAt: string;
  acceptedAt: string | null;
}

/** Never includes inviteTokenHash/inviteExpiresAt — a bearer credential's hash has no legitimate reason to leave the server, mirroring every other secret-adjacent serializer in this codebase (destinationSerializer, mailboxSerializer). */
export function serializeMembership(row: Membership & { user: Pick<User, "email"> }): MembershipResponse {
  return {
    id: row.id,
    userId: row.userId,
    email: row.user.email,
    permissions: row.permissions,
    status: row.status,
    invitedAt: row.invitedAt.toISOString(),
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
  };
}
