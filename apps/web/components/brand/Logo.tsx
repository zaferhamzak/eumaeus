/**
 * Eumaeus brand mark, "Nöbetçi" (the sentry): a wolf's head in profile on a
 * rounded badge — Eumaeus is the one who keeps watch at the door. The badge
 * is --logo-badge (night pine on light surfaces, pine green in dark mode);
 * `onDark` forces the pine badge for surfaces that are dark in both themes
 * (the sidebar). The eye is always Claude orange. Same drawing as
 * app/icon.svg.
 */
export function Logo({ size = 20, className, onDark = false }: { size?: number; className?: string; onDark?: boolean }) {
  const badge = onDark ? "#0f6b4f" : "var(--logo-badge)";
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Eumaeus" className={className}>
      <rect x="3" y="3" width="58" height="58" rx="14" fill={badge} />
      <g transform="translate(-3.5 4) scale(1.04)">
        <path fill="#eef2ef" d="M17 25 23 7 29.5 19 35 19.5 38.5 22.5 52 26.5 56.5 29 56 33 52.5 37.5 42.5 42.5 36.5 47 30 51.5 30 46.5 23.5 49.5 24 44 17 45.5 20 38.5 15.5 31z" />
        <path fill="#a9c2b6" d="M17 25 23 7 26.5 21 28.5 34 33 49.2 30 51.5 30 46.5 23.5 49.5 24 44 17 45.5 20 38.5 15.5 31z" />
        <path fill="#d97757" d="M35.5 25.4 41 26.6 40.3 28.3 35 27z" />
        <path fill={badge} d="M55.8 32.2 43.5 36.4 45.5 37 55.5 33.6z" />
        <path fill={badge} d="M53.6 27.6 56.4 29.1 56.2 30.8 53.2 29.6z" />
      </g>
    </svg>
  );
}
