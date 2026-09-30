"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TabDef {
  key: string;
  label: string;
  content: ReactNode;
}

/** A small accessible tab set (role="tablist"/"tab"/"tabpanel") — visual pattern from the New UI reference's inspector tabs, generic enough for reuse anywhere a panel needs to split dense content into sections. */
export function Tabs({ tabs, ariaLabel, defaultTabKey }: { tabs: TabDef[]; ariaLabel: string; defaultTabKey?: string }) {
  const [active, setActive] = useState(defaultTabKey ?? tabs[0]?.key);
  const activeTab = tabs.find((t) => t.key === active) ?? tabs[0];

  return (
    <div>
      <div role="tablist" aria-label={ariaLabel} className="flex gap-4 border-b border-border px-3">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`tab-${tab.key}`}
            aria-selected={active === tab.key}
            aria-controls={`tabpanel-${tab.key}`}
            onClick={() => setActive(tab.key)}
            className={cn(
              "relative -mb-px border-b-2 py-2 text-[11px] font-medium transition-colors",
              active === tab.key ? "border-accent text-foreground" : "border-transparent text-foreground-muted hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab ? (
        <div role="tabpanel" id={`tabpanel-${activeTab.key}`} aria-labelledby={`tab-${activeTab.key}`} className="p-3">
          {activeTab.content}
        </div>
      ) : null}
    </div>
  );
}
