import type { FastifyInstance } from "fastify";
import { metrics } from "../../metrics/metrics.js";

/**
 * GET /metrics — a plain JSON snapshot of the in-memory registry
 * (metrics/metrics.ts), NOT Prometheus text-exposition format (§12: no
 * Prometheus/Grafana infrastructure exists in this repo, and introducing one
 * is explicitly out of scope — see the Phase 7 report's Metrics section for
 * the reasoning). Documented format:
 *
 *   {
 *     "counters": [{ "name": "...", "labels": {...}, "value": 123 }],
 *     "histograms": [{ "name": "...", "labels": {...}, "buckets": [...], "counts": [...], "sum": 0, "count": 0 }]
 *   }
 *
 * No database access (§12: "do not require database access just to render
 * basic process metrics") — this reads only the in-process registry. No
 * secrets are ever recorded as metric values/labels in the first place (see
 * metrics/metrics.ts's own doc comment on label cardinality/content), so there
 * is nothing to redact here.
 */
export function registerMetricsRoutes(app: FastifyInstance): void {
  app.get("/metrics", async () => metrics.snapshot());
}
