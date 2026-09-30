import { z } from "zod";
import { paginationQuerySchema } from "../pagination.js";

export const listAuditQuerySchema = paginationQuerySchema
  .extend({
    eventType: z.string().min(1).max(100).optional(),
    emailId: z.string().min(1).optional(),
    createdAfter: z.coerce.date().optional(),
    createdBefore: z.coerce.date().optional(),
  })
  .strict();
