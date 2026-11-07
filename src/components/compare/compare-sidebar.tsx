"use client";

/**
 * Compare & Sync's left panel: the reference's tabs in typing order, each with how it stands and
 * where it goes, then the tabs only your document has.
 */

import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { CompareResult, CompareSide, TabMap, TabTarget } from "@/lib/compare-types";
import { Icon } from "../workspace/icon";
import { tabStatus, takenBy, targetFor, targetValue } from "./compare-view";

interface CompareSidebarProps {
  left: CompareSide;
  right: CompareSide;
  result: CompareResult;
  tabMap: TabMap;
  skip: ReadonlySet<string>;
  selected: string | null;
  onSelect: (rightTabId: string) => void;
  onTarget: (rightTabId: string, target: TabTarget) => void;
  /** While a new comparison is read, targets wait */
  busy?: boolean;
  onHide: () => void;
}

export function CompareSidebar(p: CompareSidebarProps) {
  const taken = takenBy(p.tabMap, p.right);
  const byId = new Map(p.result.tabs.map((t) => [t.rightTabId, t]));
  return (
    <div className="ss-sidebar ss-cmp-side">
      <div className="ss-side-hat">
        <button className="ss-icon-btn ss-side-back" onClick={p.onHide} title="Hide tabs" aria-label="Hide tabs">
          <Icon name="arrow_back" size={24} />
        </button>
      </div>
      <nav aria-label="Reference tabs">
        <h2 className="ss-side-heading">Reference tabs</h2>
        <ul className="ss-cmp-tabs">
          {p.right.tabs.map((rt) => {
            const tab = byId.get(rt.id);
            const target = p.tabMap[rt.id] ?? tab?.target;
            const status = tab ? tabStatus(tab, p.skip) : { label: "Not copied", tone: "off" as const };
            const selected = rt.id === p.selected;
            // Where it goes, when that isn't a tab of the same name
            const into = target?.kind === "tab" ? p.left.tabs.find((t) => t.id === target.leftTabId)?.title ?? null : null;
            const where = into != null && into.trim().toLowerCase() !== rt.title.trim().toLowerCase() ? into : null;
            return (
              <li key={rt.id} style={{ paddingLeft: rt.level * 16 }}>
                <button type="button" className="ss-cmp-tab" aria-current={selected ? "page" : undefined} onClick={() => p.onSelect(rt.id)} title={where ? `${rt.title}, into “${where}”` : rt.title}>
                  <span className="ss-doc-tab-icon">{rt.emoji ? <span className="ss-doc-tab-emoji" aria-hidden>{rt.emoji}</span> : <Icon name="article" size={20} />}</span>
                  <span className="ss-cmp-tab-text">
                    <span className="ss-cmp-tab-title">{rt.title}</span>
                    <span className="ss-cmp-tab-status" data-tone={status.tone}>
                      <span className="ss-cmp-dot" aria-hidden="true" />
                      {status.label}
                      {where && <span className="ss-cmp-tab-into">· into “{where}”</span>}
                    </span>
                  </span>
                </button>
                <AnimatePresence initial={false}>
                  {selected && (
                    <motion.div
                      key="target"
                      className="ss-cmp-target"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
                    >
                      <label className="ss-field-sub" htmlFor={`ss-target-${rt.id}`}>Copy into</label>
                      <select
                        id={`ss-target-${rt.id}`}
                        className="ss-select"
                        value={targetValue(target)}
                        disabled={p.busy}
                        onChange={(e) => { const t = targetFor(e.target.value, rt, p.left); if (t) p.onTarget(rt.id, t); }}
                      >
                        <optgroup label="A tab in your document">
                          {p.left.tabs.map((lt) => {
                            const by = taken.get(lt.id);
                            const other = by && by !== rt.id ? p.right.tabs.find((t) => t.id === by)?.title : null;
                            return (
                              <option key={lt.id} value={`tab:${lt.id}`} disabled={!!other}>
                                {" ".repeat(lt.level * 2)}{lt.title}{other ? ` (gets “${other}”)` : ""}
                              </option>
                            );
                          })}
                        </optgroup>
                        <option value="new">A new tab, “{rt.title}”</option>
                        <option value="skip">Don&apos;t copy this tab</option>
                      </select>
                    </motion.div>
                  )}
                </AnimatePresence>
              </li>
            );
          })}
        </ul>
      </nav>
      {p.result.leftOnlyTabs.length > 0 && (
        <nav aria-label="Only in your document" className="ss-cmp-left-only">
          <h2 className="ss-side-heading">Only in your document</h2>
          <ul className="ss-cmp-tabs">
            {p.result.leftOnlyTabs.map((t) => (
              <li key={t.id}>
                <div className="ss-cmp-tab" data-static="true" title={t.title}>
                  <span className="ss-doc-tab-icon"><Icon name="article" size={20} /></span>
                  <span className="ss-cmp-tab-text">
                    <span className="ss-cmp-tab-title">{t.title}</span>
                    <span className="ss-cmp-tab-status" data-tone="off"><span className="ss-cmp-dot" aria-hidden="true" />Stays as it is</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
