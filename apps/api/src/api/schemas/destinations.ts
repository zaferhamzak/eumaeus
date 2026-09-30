import { z } from "zod";
import { paginationQuerySchema } from "../pagination.js";

export const listDestinationsQuerySchema = paginationQuerySchema.strict();

const channelInputSchema = z
  .object({
    type: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

export const addChannelBodySchema = channelInputSchema;

export const editChannelBodySchema = z
  .object({
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

export const createDestinationBodySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    channels: z.array(channelInputSchema).max(10).optional(),
  })
  .strict();

export const updateDestinationBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .strict();

export const putSecretBodySchema = z
  .object({
    value: z.string().min(1),
  })
  .strict();
