import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listAuditQuerySchema } from "../schemas/audit.js";
import { listAuditEvents } from "../services/auditService.js";
import { requirePermission } from "../plugins/requirePermission.js";
import { ValidationError } from "../errors/ApiError.js";
import { auditCsvLines, MAX_EXPORT_DAYS } from "../../modules/audit/exportCsv.js";

const exportQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    eventType: z.string().min(1).max(100).optional(),
  })
  .strict();

export function registerAuditRoutes(app: FastifyInstance): void {
  app.get("/api/v1/audit", { preHandler: requirePermission("audit:read") }, async (request) => {
    const query = listAuditQuerySchema.parse(request.query);
    return listAuditEvents(request.tenantId, query);
  });

  // Phase 20: CSV for a date range [from, to), streamed.
  app.get("/api/v1/audit/export.csv", { preHandler: requirePermission("audit:read") }, async (request, reply) => {
    const query = exportQuerySchema.parse(request.query);
    if (query.to <= query.from) throw new ValidationError("to must be after from");
    if (query.to.getTime() - query.from.getTime() > MAX_EXPORT_DAYS * 24 * 60 * 60 * 1000) throw new ValidationError(`Export at most ${MAX_EXPORT_DAYS} days at a time`);
    const name = `eumaeus-audit-${query.from.toISOString().slice(0, 10)}-${query.to.toISOString().slice(0, 10)}.csv`;
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${name}"`)
      .header("cache-control", "no-store")
      .send(Readable.from(auditCsvLines({ tenantId: request.tenantId, from: query.from, to: query.to, eventType: query.eventType })));
  });
}
