"use client";

import React from "react";
import Link from "next/link";
import type { Editor } from "@tiptap/react";
import { Columns2, Table2 } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { DocTab } from "@/lib/doc-tabs";
import type { PublicJob } from "@/lib/sync-store";
import { Icon } from "./icon";
import { Menu, MenuItem } from "./menu";
import { Outline } from "./outline";
import { isActive, progressOf, statusLine } from "./job-status";
import { docsUrl } from "./header";

const DOT: Record<PublicJob["status"], string> = {
  scheduled: "#8e918f",
  pending: "#0b57d0",
  running: "#0b57d0",
  paused: "#b06000",
  done: "#146c2e",
  error: "#b3261e",
  cancelled: "#8e918f",
};

/** How many finished syncs show before "Show all" */
const EARLIER = 5;

interface SidebarProps {
  /** The open document's tabs; none for a document Docs gives no tabs for (it has one, "Tab 1") */
  tabs: DocTab[] | null;
  currentTab: string | null | undefined;
  tabsDisabled?: boolean;
  onSelectTab: (id: string) => void;
  /** The body editor, whose headings the outline lists; none while a sync is shown */
  editor: Editor | null;
  jobs: PublicJob[];
  focusedJobId: string | null;
  composing: boolean;
  onFocusJob: (id: string) => void;
  onNewDoc: () => void;
  isCreatingDoc: boolean;
  onDismissJob: (id: string) => void;
  onHide: () => void;
}

/**
 * Docs' left panel, measured against Docs: a back arrow that hides it, "Document tabs" with the
 * open tab as a 40px pill and its outline under it, then the syncs, with "New Google Doc" and
 * "Compare & Sync" first.
 */
export function Sidebar(p: SidebarProps) {
  const tabs = p.tabs && p.tabs.length ? p.tabs : [{ id: "", title: "Tab 1", level: 0 }];
  const current = p.tabs && p.tabs.length ? p.currentTab ?? tabs[0].id : "";
  const active = p.jobs.filter(isActive);
  const finished = p.jobs.filter((j) => !isActive(j));
  const [showAll, setShowAll] = React.useState(false);
  const earlier = showAll ? finished : finished.slice(0, EARLIER);

  return (
    <div className="ss-sidebar">
      <div className="ss-side-hat">
        <button className="ss-icon-btn ss-side-back" onClick={p.onHide} title="Hide tabs & outlines" aria-label="Hide tabs & outlines">
          <Icon name="arrow_back" size={24} />
        </button>
      </div>

      <nav aria-label="Document tabs">
        <h2 className="ss-side-heading">Document tabs</h2>
        <ul className="ss-doc-tabs">
          {tabs.map((t) => {
            const selected = t.id === current;
            return (
              <li key={t.id || "tab"} style={{ paddingLeft: t.level * 16 }}>
                <button
                  type="button"
                  className="ss-doc-tab"
                  aria-current={selected ? "page" : undefined}
                  disabled={p.tabsDisabled && !selected}
                  title={t.title}
                  onClick={() => p.onSelectTab(t.id)}
                >
                  <span className="ss-doc-tab-icon">{t.emoji ? <span className="ss-doc-tab-emoji" aria-hidden>{t.emoji}</span> : <Icon name="article" size={20} />}</span>
                  <span className="ss-doc-tab-label">{t.title}</span>
                </button>
                {selected && p.editor && <Outline editor={p.editor} />}
              </li>
            );
          })}
        </ul>
      </nav>

      <nav className="ss-syncs" aria-label="Syncs">
        <h2 className="ss-side-heading">Syncs</h2>
        <button type="button" className="ss-doc-tab ss-new-doc" onClick={p.onNewDoc} disabled={p.isCreatingDoc}>
          <span className="ss-doc-tab-icon"><Icon name="note_add" size={18} /></span>
          <span className="ss-doc-tab-label">{p.isCreatingDoc ? "Creating document" : "New Google Doc"}</span>
        </button>
        <Link href="/dashboard/compare" className="ss-doc-tab ss-new-doc" title="Bring a document up to date with another one">
          <span className="ss-doc-tab-icon"><Columns2 className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" /></span>
          <span className="ss-doc-tab-label">Compare &amp; Sync</span>
        </Link>
        <Link href="/dashboard/sheets" className="ss-doc-tab ss-new-doc" title="Sync an Excel workbook into a new Google Sheet">
          <span className="ss-doc-tab-icon"><Table2 className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" /></span>
          <span className="ss-doc-tab-label">Excel sheet</span>
        </Link>

        {active.length > 0 && <div className="ss-side-label">In progress</div>}
        <AnimatePresence initial={false}>
          {active.map((j) => (
            <SyncRow key={j.id} job={j} selected={!p.composing && j.id === p.focusedJobId} onClick={() => p.onFocusJob(j.id)} />
          ))}
        </AnimatePresence>

        {finished.length > 0 && <div className="ss-side-label">Earlier</div>}
        <AnimatePresence initial={false}>
          {earlier.map((j) => (
            <SyncRow key={j.id} job={j} selected={!p.composing && j.id === p.focusedJobId} onClick={() => p.onFocusJob(j.id)} onDismiss={() => p.onDismissJob(j.id)} />
          ))}
        </AnimatePresence>
        {finished.length > EARLIER && (
          <button type="button" className="ss-side-more" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show fewer" : `Show all ${finished.length}`}
          </button>
        )}

        {p.jobs.length === 0 && <p className="ss-side-empty">Syncs you start show up here. They keep running after you close this tab.</p>}
      </nav>
    </div>
  );
}

function SyncRow({ job, selected, onClick, onDismiss }: { job: PublicJob; selected: boolean; onClick: () => void; onDismiss?: () => void }) {
  const progress = isActive(job) ? progressOf(job) : null;
  return (
    <motion.div
      className="ss-sync-row"
      layout="position"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
    >
      <button type="button" onClick={onClick} aria-current={selected ? "true" : undefined} className="ss-sync-item">
        <span className="ss-sync-dot" style={{ background: DOT[job.status] }} />
        <span className="min-w-0 flex-1">
          <span className="ss-sync-name">{job.documentName}{job.tabTitle ? <span className="ss-sync-tab"> › {job.tabTitle}</span> : null}</span>
          <span className="ss-sync-line">{statusLine(job)}</span>
          {progress != null && (
            <span className="ss-progress mt-1.5 block" aria-hidden="true">
              <motion.span className="block h-full bg-[var(--ss-blue)]" initial={false} animate={{ width: `${progress}%` }} transition={{ type: "spring", stiffness: 90, damping: 20 }} />
            </span>
          )}
        </span>
      </button>
      <Menu align="end" label={`More for ${job.documentName}`} trigger={
        <button type="button" className="ss-icon-btn ss-sync-more" aria-label={`More for ${job.documentName}`} title="More">
          <Icon name="more_vert" size={18} />
        </button>
      }>
        <MenuItem icon={<Icon name="open_in_new" size={18} />} onSelect={() => window.open(docsUrl(job.documentId, job.tabId), "_blank", "noopener")}>Open in Google Docs</MenuItem>
        {onDismiss && <MenuItem icon={<Icon name="close" size={18} />} onSelect={onDismiss}>Remove from list</MenuItem>}
      </Menu>
    </motion.div>
  );
}
