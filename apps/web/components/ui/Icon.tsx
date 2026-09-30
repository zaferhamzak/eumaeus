import type { ReactNode } from "react";

/**
 * Small inline icon set, visual style ported from `New UI/Email Security
 * Operations Control Plane` (src/App.tsx's own `Icon` component) rather than
 * pulling in an icon library — matches the New UI reference and keeps the
 * dependency footprint unchanged. Only the names this app's real navigation
 * and shell actually use are included (no icons for pages that don't exist).
 */
export type IconName =
  | "activity"
  | "alert"
  | "archive"
  | "check"
  | "chevron"
  | "inbox"
  | "layers"
  | "mailbox"
  | "menu"
  | "minus"
  | "rules"
  | "search"
  | "send"
  | "settings"
  | "sliders"
  | "target"
  | "terminal"
  | "x";

const PATHS: Record<IconName, ReactNode> = {
  send: (
    <>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </>
  ),
  activity: <path d="M3 12h3l2.2-7 3.1 14 2.4-9 1.6 4H21" />,
  alert: (
    <>
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.6 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z" />
    </>
  ),
  archive: (
    <>
      <path d="M4 7v13h16V7" />
      <path d="M2 3h20v4H2z" />
      <path d="M9 11h6" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 10 3 3 3-3" />,
  inbox: (
    <>
      <path d="M4 4h16v16H4z" />
      <path d="M4 14h4l2 3h4l2-3h4" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
    </>
  ),
  mailbox: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1" />
      <path d="m3 6 9 7 9-7" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  minus: <path d="M5 12h14" />,
  rules: (
    <>
      <path d="M5 4h14M5 12h14M5 20h14" />
      <circle cx="9" cy="4" r="2" fill="var(--surface-raised)" />
      <circle cx="15" cy="12" r="2" fill="var(--surface-raised)" />
      <circle cx="10" cy="20" r="2" fill="var(--surface-raised)" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
      <path d="M1 14h6M9 8h6M17 16h6" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.5" fill="currentColor" />
    </>
  ),
  terminal: <path d="m5 7 4 4-4 4M11 17h7" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
