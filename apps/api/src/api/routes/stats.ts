import type { FastifyInstance } from "fastify";
import { getStats } from "../services/statsService.js";
import { requirePermission } from "../plugins/requirePermission.js";

export function registerStatsRoutes(app: FastifyInstance): void {
  app.get("/api/v1/stats", { preHandler: requirePermission("stats:read") }, async (request) => getStats(request.tenantId));
}
