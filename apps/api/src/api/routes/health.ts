import type { FastifyInstance } from "fastify";
import type { RuntimeState } from "../../runtime/state.js";
import { checkLiveness, checkReadiness } from "../services/healthService.js";

export function registerHealthRoutes(app: FastifyInstance, state: RuntimeState): void {
  app.get("/api/v1/health", async () => checkLiveness());

  app.get("/api/v1/ready", async (_request, reply) => {
    const result = await checkReadiness(state);
    return reply.status(result.status === "ok" ? 200 : 503).send(result);
  });
}
