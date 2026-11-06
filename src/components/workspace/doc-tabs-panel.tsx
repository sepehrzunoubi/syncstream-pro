"use client";

import React from "react";
import type { DocTab } from "@/lib/doc-tabs";
import { Icon } from "./icon";

/**
 * Docs' "Document tabs" list: the open document's tabs, child tabs under their parent. Picking one
 * shows it; edits save into it and a sync types into it. Shown when the document has more than one.
 */
export function DocTabsPanel({ tabs, current, onSelect, disabled }: {
  tabs: DocTab[];
  /** The tab shown */
  current: string | null | undefined;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  if (tabs.length < 2) return null;
  return (
    <nav className="ss-doc-tabs" aria-label="Document tabs">
      <h2 className="ss-outline-title">Document tabs</h2>
      <ul>
        {tabs.map((t) => {
          const selected = t.id === current;
          return (
            <li key={t.id} style={{ paddingLeft: t.level * 16 }}>
              <button
                type="button"
                className="ss-doc-tab"
                aria-current={selected ? "page" : undefined}
                disabled={disabled && !selected}
                title={t.title}
                onClick={() => { if (!selected) onSelect(t.id); }}
              >
                {t.emoji ? <span className="ss-doc-tab-emoji" aria-hidden>{t.emoji}</span> : <Icon name="description" size={18} />}
                <span className="truncate">{t.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
