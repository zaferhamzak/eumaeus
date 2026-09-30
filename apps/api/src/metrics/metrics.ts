/**
 * A minimal in-memory metrics registry (Phase 7 §11 — explicitly NOT
 * Prometheus/Grafana: "a simple internal metrics abstraction is acceptable").
 * Two instrument kinds only, matching what §11 actually asks to track:
 *
 *   counter   — monotonically increasing count (emails received, actions
 *               succeeded, webhook timeouts, ...)
 *   histogram — a bounded set of fixed buckets for a duration/size
 *               distribution (API latency) — NOT per-observation storage,
 *               which would itself be an unbounded-memory risk.
 *
 * Cardinality discipline (§11's explicit list of forbidden labels — emailId,
 * subject, sender, webhook URL): every label value used anywhere in this
 * codebase (see the call sites in modules/*, api/*) is drawn from a small,
 * closed set — a channel type, an event/reason string, an HTTP method, a
 * route TEMPLATE (e.g. "/api/v1/emails/:id", never the real id), or a status
 * code. There is no code path that could pass a free-form/high-cardinality
 * value as a label — this file does not enforce that by construction (there's
 * no allowlist check here, which would be its own maintenance burden for a
 * single-tenant-scale internal metrics store), but every call site is a
 * one-line, auditable call — grep for `metrics.increment(` / `metrics.observe(`
 * to see the complete, closed set of label combinations actually used.
 */

export type MetricLabels = Record<string, string>;

interface HistogramState {
  buckets: number[]; // upper bounds, ascending
  counts: number[]; // counts[i] = observations <= buckets[i]
  sum: number;
  count: number;
}

const DEFAULT_LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function labelKey(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}

class Registry {
  private counters = new Map<string, Map<string, { labels: MetricLabels; value: number }>>();
  private histograms = new Map<string, Map<string, { labels: MetricLabels; state: HistogramState }>>();

  increment(name: string, labels: MetricLabels = {}, amount = 1): void {
    const byLabels = this.counters.get(name) ?? new Map();
    this.counters.set(name, byLabels);
    const key = labelKey(labels);
    const existing = byLabels.get(key);
    if (existing) existing.value += amount;
    else byLabels.set(key, { labels, value: amount });
  }

  observe(name: string, value: number, labels: MetricLabels = {}, buckets: number[] = DEFAULT_LATENCY_BUCKETS_MS): void {
    const byLabels = this.histograms.get(name) ?? new Map();
    this.histograms.set(name, byLabels);
    const key = labelKey(labels);
    const existing = byLabels.get(key);
    const state = existing?.state ?? { buckets: [...buckets].sort((a, b) => a - b), counts: new Array(buckets.length).fill(0) as number[], sum: 0, count: 0 };
    for (let i = 0; i < state.buckets.length; i++) {
      if (value <= (state.buckets[i] as number)) state.counts[i] = (state.counts[i] as number) + 1;
    }
    state.sum += value;
    state.count += 1;
    byLabels.set(key, { labels, state });
  }

  /** A plain-JSON snapshot — the deliberately-chosen "documented format" for GET /metrics (see api/routes/metrics.ts): no Prometheus text exposition format, no external scraper assumed, since nothing in this repository runs one. */
  snapshot(): { counters: Array<{ name: string; labels: MetricLabels; value: number }>; histograms: Array<{ name: string; labels: MetricLabels; buckets: number[]; counts: number[]; sum: number; count: number }> } {
    const counters: Array<{ name: string; labels: MetricLabels; value: number }> = [];
    for (const [name, byLabels] of this.counters) {
      for (const { labels, value } of byLabels.values()) counters.push({ name, labels, value });
    }
    const histograms: Array<{ name: string; labels: MetricLabels; buckets: number[]; counts: number[]; sum: number; count: number }> = [];
    for (const [name, byLabels] of this.histograms) {
      for (const { labels, state } of byLabels.values()) {
        histograms.push({ name, labels, buckets: state.buckets, counts: state.counts, sum: state.sum, count: state.count });
      }
    }
    return { counters, histograms };
  }

  /** Test-only: a fresh registry between test files/cases so metric state from one test never leaks into another's assertions. */
  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }
}

export const metrics = new Registry();
