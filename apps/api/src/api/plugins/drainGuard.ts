import type { FastifyInstance } from "fastify";
import type { RuntimeState } from "../../runtime/state.js";
import { ServiceUnavailableError } from "../errors/ApiError.js";

/**
 * Phase 7 §24 — "Define behavior for incoming HTTP requests while draining."
 * Registered inside the SAME tenant-scoped child plugin as every substantive
 * route (mailboxes, destinations, rules, ...) — deliberately NOT applied to
 * /api/v1/health or /api/v1/ready, which are registered outside that scope and
 * must keep responding during a drain (health for liveness; readiness so it
 * can specifically REPORT "not ready, draining" — see healthService.ts).
 */
export function registerDrainGuardPlugin(app: FastifyInstance, state: RuntimeState): void {
  app.addHook("onRequest", async () => {
    if (!state.isAcceptingWork()) {
      throw new ServiceUnavailableError("This instance is shutting down and is not accepting new requests");
    }
  });
}
