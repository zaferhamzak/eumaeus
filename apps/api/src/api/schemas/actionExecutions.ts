import { z } from "zod";
import { paginationQuerySchema } from "../pagination.js";

export const listActionExecutionsQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(["pending", "succeeded", "failed", "ambiguous"]).optional(),
  })
  .strict();
