import { jevStatus } from "../../modules/jev/status.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Alert } from "@prisma/client";
import { requirePermission } from "../plugins/requirePermission.js";
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from "../errors/ApiError.js";
import { idParamSchema } from "../schemas/common.js";
import { AlertNotOpenError, dismissAlert } from "../../modules/alerts/evaluateAlerts.js";
import { mailboxHealth, queueHealth } from "../../modules/ops/queueHealth.js";
import { prisma } from "../../db/client.js";
import { buildHostReport, buildReport, isValidTimeZone } from "../../modules/reports/buildReport.js";

function serializeAlert(a: Alert) {
  return {
    id: a.id,
    kind: a.kind,
    subjectKey: a.subjectKey || null,
    status: a.status,
    title: a.title,
    detail: a.detail,
    /** 1.2 (E): the web app builds the text in the reader's language from kind + params (null = before 1.2: show title/detail). */
    params: a.params ?? null,
    firstSeenAt: a.firstSeenAt.toISOString(),
    lastSeenAt: a.lastSeenAt.toISOString(),
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    dismissedAt: a.dismissedAt?.toISOString() ?? null,
    dismissedBy: a.dismissedBy,
  };
}

const alertsQuerySchema = z.object({ status: z.enum(["open", "dismissed", "resolved"]).default("open"), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
const reportQuerySchema = z
  .object({
    days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), "days must be 7, 30 or 90").default(30),
    tz: z.string().max(64).default("UTC"),
    mailboxId: z.string().min(1).max(200).optional(),
  })
  .strict();

/** Phase 18: alerts and reports. Read-only overviews, so stats:read — the same permission as the Overview page. */
export function registerOpsInsightRoutes(app: FastifyInstance): void {
  app.get("/api/v1/alerts", { preHandler: requirePermission("stats:read") }, async (request) => {
    const query = alertsQuerySchema.parse(request.query);
    const rows = await prisma.alert.findMany({
      where: { tenantId: request.tenantId, status: query.status },
      orderBy: query.status === "open" ? { firstSeenAt: "desc" } : query.status === "dismissed" ? { dismissedAt: "desc" } : { resolvedAt: "desc" },
      take: query.limit,
    });
    return { data: rows.map(serializeAlert) };
  });

  // Closing an alert affects everyone's view and silences its notifications,
  // so it takes organizations:write — the people alert emails go to.
  app.post("/api/v1/alerts/:id/dismiss", { preHandler: requirePermission("organizations:write") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    try {
      const alert = await dismissAlert(request.tenantId, params.id, request.user?.email ?? "system");
      if (!alert) throw new NotFoundError(`Alert ${params.id} not found`);
      return serializeAlert(alert);
    } catch (error) {
      if (error instanceof AlertNotOpenError) throw new InvalidStateError(error.message);
      throw error;
    }
  });

  // Phase 26: queue health (global — the system owner's view) and this organization's mailbox sync health.
  app.get("/api/v1/admin/queues", async (request) => {
    if (!request.user?.isSuperAdmin) throw new ForbiddenError("Only the system administrator can see the job queues");
    return { data: await queueHealth() };
  });

  app.get("/api/v1/mailboxes/health", { preHandler: requirePermission("mailboxes:read") }, async (request) => ({ data: await mailboxHealth(request.tenantId) }));

  // 1.2 (G): is Jev working for this organization, and what did it leave behind?
  app.get("/api/v1/jev/status", { preHandler: requirePermission("stats:read") }, async (request) => jevStatus(request.tenantId));

  app.get("/api/v1/stats/reports", { preHandler: requirePermission("stats:read") }, async (request) => {
    const query = reportQuerySchema.parse(request.query);
    if (!isValidTimeZone(query.tz)) throw new ValidationError(`Unknown time zone "${query.tz}"`);
    return buildReport({ tenantId: request.tenantId, days: query.days, timeZone: query.tz, mailboxConnectionId: query.mailboxId });
  });

  // The host view: every organization at once. Not tied to one organization
  // (no X-Organization-Id), so only a superAdmin — who can see them all anyway.
  app.get("/api/v1/admin/reports", async (request) => {
    if (!request.user?.isSuperAdmin) throw new ForbiddenError("Only the system administrator can see every organization");
    const query = reportQuerySchema.omit({ mailboxId: true }).parse(request.query);
    if (!isValidTimeZone(query.tz)) throw new ValidationError(`Unknown time zone "${query.tz}"`);
    return buildHostReport({ days: query.days, timeZone: query.tz });
  });
}
