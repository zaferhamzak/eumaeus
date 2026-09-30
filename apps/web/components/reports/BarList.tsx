/**
 * A ranked list of counts as horizontal bars (Phase 18). One series, one
 * hue; the numbers are text next to each bar, so nothing depends on reading
 * a length. Bars are scaled to the largest value in the list.
 */
export function BarList({ rows, emptyText }: { rows: Array<{ label: string; value: number; hint?: string }>; emptyText: string }) {
  if (rows.length === 0) return <p className="text-sm text-foreground-muted">{emptyText}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => (
        // Labels aren't guaranteed unique (two rules can share a name), so the position is part of the key.
        <li key={`${i}:${r.label}`} className="grid grid-cols-[minmax(0,150px)_1fr_48px] items-center gap-2 text-xs" title={r.hint}>
          <span className="truncate text-foreground">{r.label}</span>
          <span className="h-2.5 rounded-sm bg-surface" aria-hidden="true">
            <span className="block h-2.5 rounded-sm" style={{ width: `${(r.value / max) * 100}%`, background: "var(--chart-1)" }} />
          </span>
          <span className="text-right font-mono text-foreground tabular-nums">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}
