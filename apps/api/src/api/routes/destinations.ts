import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idAndNameParamSchema, idParamSchema } from "../schemas/common.js";
import {
  createDestinationBodySchema,
  addChannelBodySchema,
  editChannelBodySchema,
  listDestinationsQuerySchema,
  putSecretBodySchema,
  updateDestinationBodySchema,
} from "../schemas/destinations.js";
import {
  createDestination,
  deleteDestination,
  getDestinationById,
  listDestinations,
  listDestinationSecrets,
  putDestinationSecret,
  removeDestinationSecret,
  updateDestination,
  addChannel,
  editChannel,
  disableChannel,
} from "../services/destinationService.js";
import { requirePermission } from "../plugins/requirePermission.js";
import { ValidationError } from "../errors/ApiError.js";
import { validateEmailNotifyConfig } from "../../modules/destinations/manageDestinations.js";
import { previewNotice } from "../../modules/destinations/notify.js";
import type { EmailNotifyChannelConfig } from "../../modules/destinations/types.js";

export function registerDestinationRoutes(app: FastifyInstance): void {
  app.get("/api/v1/destinations", { preHandler: requirePermission("destinations:read") }, async (request) => {
    const query = listDestinationsQuerySchema.parse(request.query);
    return listDestinations(request.tenantId, query);
  });

  app.get("/api/v1/destinations/:id", { preHandler: requirePermission("destinations:read") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    return getDestinationById(request.tenantId, params.id);
  });

  app.post("/api/v1/destinations", { preHandler: requirePermission("destinations:write") }, async (request, reply) => {
    const body = createDestinationBodySchema.parse(request.body);
    const created = await createDestination(request.tenantId, body, request.user?.email);
    return reply.status(201).send(created);
  });

  app.patch("/api/v1/destinations/:id", { preHandler: requirePermission("destinations:write") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const body = updateDestinationBodySchema.parse(request.body);
    return updateDestination(request.tenantId, params.id, body);
  });

  app.delete("/api/v1/destinations/:id", { preHandler: requirePermission("destinations:delete") }, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    await deleteDestination(request.tenantId, params.id);
    return reply.status(204).send();
  });

  // --- Channels on an existing destination (previously only settable at
  // creation time). Adding/editing a channel changes where mail actually
  // goes, so it's destinations:write, same as creating the destination. ---

  const channelParamsSchema = z.object({ id: z.string().min(1).max(200), channelId: z.string().min(1).max(200) });

  app.post("/api/v1/destinations/:id/channels", { preHandler: requirePermission("destinations:write") }, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    const body = addChannelBodySchema.parse(request.body);
    return reply.status(201).send(await addChannel(request.tenantId, params.id, body, request.user?.email));
  });

  app.patch("/api/v1/destinations/:id/channels/:channelId", { preHandler: requirePermission("destinations:write") }, async (request) => {
    const params = channelParamsSchema.parse(request.params);
    const body = editChannelBodySchema.parse(request.body);
    return editChannel(request.tenantId, params.id, params.channelId, body.config, request.user?.email);
  });

  app.delete("/api/v1/destinations/:id/channels/:channelId", { preHandler: requirePermission("destinations:write") }, async (request) => {
    const params = channelParamsSchema.parse(request.params);
    return disableChannel(request.tenantId, params.id, params.channelId);
  });

  // --- 1.2 (O): "email_notify" editor helpers. Preview renders the notice
  // for a real email; "send to me" mails it to the signed-in person only. ---

  const noticeBodySchema = z
    .object({
      config: z.record(z.unknown()),
      destinationName: z.string().min(1).max(200).default("Destination"),
      emailId: z.string().uuid().optional(),
    })
    .strict();

  const parseNoticeConfig = (raw: Record<string, unknown>) => {
    const { errors, config } = validateEmailNotifyConfig(raw);
    if (errors.length > 0) throw new ValidationError(`Invalid notification settings: ${errors.join("; ")}`, errors);
    return config as unknown as EmailNotifyChannelConfig;
  };

  app.post("/api/v1/destinations/notify-preview", { preHandler: requirePermission("destinations:write") }, async (request) => {
    const body = noticeBodySchema.parse(request.body);
    return previewNotice(request.tenantId, { config: parseNoticeConfig(body.config), destinationName: body.destinationName, emailId: body.emailId });
  });

  app.post("/api/v1/destinations/notify-test", { preHandler: requirePermission("destinations:write") }, async (request) => {
    const body = noticeBodySchema.parse(request.body);
    const to = request.user?.email;
    if (!to) throw new ValidationError("A test notice goes to your own address — sign in with a user account");
    const result = await previewNotice(request.tenantId, { config: parseNoticeConfig(body.config), destinationName: body.destinationName, emailId: body.emailId, sendTo: to });
    return { to, sent: result.sent ?? false, error: result.error ?? null, subject: result.subject };
  });

  // --- Destination secrets (§9): metadata management only, reusing
  // modules/destinations/manageSecrets.ts directly — no new encryption path. ---

  app.get("/api/v1/destinations/:id/secrets", { preHandler: requirePermission("destinations:read") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    return { data: await listDestinationSecrets(request.tenantId, params.id) };
  });

  app.put("/api/v1/destinations/:id/secrets/:name", { preHandler: requirePermission("destinations:manage_secrets") }, async (request) => {
    const params = idAndNameParamSchema.parse(request.params);
    const body = putSecretBodySchema.parse(request.body);
    return putDestinationSecret(request.tenantId, params.id, params.name, body.value);
  });

  app.delete("/api/v1/destinations/:id/secrets/:name", { preHandler: requirePermission("destinations:manage_secrets") }, async (request, reply) => {
    const params = idAndNameParamSchema.parse(request.params);
    await removeDestinationSecret(request.tenantId, params.id, params.name);
    return reply.status(204).send();
  });
}
