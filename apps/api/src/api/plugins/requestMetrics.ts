import type { FastifyInstance } from "fastify";
import { metrics } from "../../metrics/metrics.js";
import { MetricName } from "../../metrics/names.js";

/**
 * API request count + latency (§11's "API: requests, response status,
 * latency"). Labeled by the matched ROUTE TEMPLATE (e.g.
 * "/api/v1/emails/:id"), never the resolved URL — a real email/rule/etc. id in
 * a label would be exactly the unbounded, high-cardinality label §11
 * explicitly forbids. `request.routeOptions.url` is Fastify's own route
 * template string, guaranteed populated by `onResponse` time (routing has long
 * since completed).
 */
export function registerMetricsHook(app: FastifyInstance): void {
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "unmatched";
    const labels = { method: request.method, route };
    metrics.increment(MetricName.API_REQUEST, { ...labels, statusCode: String(reply.statusCode) });
    metrics.observe(MetricName.API_REQUEST_DURATION_MS, reply.elapsedTime, labels);
  });
}
