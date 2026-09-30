import { z } from "zod";
import { paginationQuerySchema } from "../pagination.js";
import { EmailState } from "../../types/email-state.js";

const emailStateValues = Object.values(EmailState) as [string, ...string[]];

export const listEmailsQuerySchema = paginationQuerySchema
  .extend({
    state: z.enum(emailStateValues).optional(),
    mailboxConnectionId: z.string().min(1).optional(),
    sender: z.string().min(1).max(320).optional(),
    subject: z.string().min(1).max(998).optional(),
    // Phase 28: any To address containing this text (case-insensitive).
    recipient: z.string().min(1).max(320).optional(),
    // Phase 28: where the current decision sent it — a destination name, or
    // "human_review" / "left_alone" (allowed sender, nothing done).
    destination: z.string().min(1).max(200).optional(),
    receivedAfter: z.coerce.date().optional(),
    receivedBefore: z.coerce.date().optional(),
  })
  .strict();

export const getEmailQuerySchema = z
  .object({
    includeBody: z.enum(["true", "false"]).optional(),
  })
  .strict();
