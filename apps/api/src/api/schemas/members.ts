import { z } from "zod";
import { PERMISSION_CATALOG } from "../../modules/auth/permissions.js";

const permissionSchema = z.enum(PERMISSION_CATALOG);

export const inviteMemberBodySchema = z
  .object({
    email: z.string().email(),
    permissions: z.array(permissionSchema).default([]),
  })
  .strict();

export const updateMemberBodySchema = z
  .object({
    permissions: z.array(permissionSchema).optional(),
    status: z.enum(["active", "revoked"]).optional(),
  })
  .strict();

export type InviteMemberBody = z.infer<typeof inviteMemberBodySchema>;
export type UpdateMemberBody = z.infer<typeof updateMemberBodySchema>;
