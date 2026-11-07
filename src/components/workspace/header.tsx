"use client";

import React from "react";
import { Icon } from "./icon";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./menu";

type Doc = { id: string; name: string; modifiedTime: string };

export interface HeaderUser { name: string; email: string; picture: string }

/** What the workspace is doing, beside the title: a cloud badge, and words when something needs attention */
export interface HeaderStatus {
  text: string;
  icon: "cloud_done" | "cloud_sync" | "cloud_off" | "sync" | "lock";
  /** Shown as words beside the badge, not only on hover */
  visible?: boolean;
}

interface HeaderProps {
  user: HeaderUser | null;
  /** Draft: pick the target doc. Viewing a sync: show its doc. */
  mode: "draft" | "job";
  docs: Doc[];
  selectedDocId: string;
  onSelectDoc: (id: string) => void;
  onNewDoc: () => void;
  onRefreshDocs: () => void;
  isCreatingDoc: boolean;
  jobDocName?: string;
  jobDocId?: string;
  /** The tab shown or typed into, in a document with more than one */
  tab?: { id: string; title: string } | null;
  status: HeaderStatus | null;
  primary: { label: string; onClick: () => void; disabled?: boolean; title?: string; kind: "start" | "back" };
  onReauth: () => void;
  onSignOut: () => void;
  /** The File / Edit / View / Format menu bar */
  menubar: React.ReactNode;
  /** Rename the open Google Doc (its Drive name) */
  onRename?: (name: string) => Promise<boolean>;
}

/** File > Rename asks the header to start renaming */
export const RENAME_EVENT = "ss-rename";

/**
 * Docs' title bar, measured against Docs itself: the logo in its 48px circle at the left, the title
 * and its badges on a 24px row at y 10, the menus under it from x 54, and the buttons on the right
 * centred in the top 60px.
 */
export function Header(props: HeaderProps) {
  const { user, mode, docs, selectedDocId, jobDocName, jobDocId, status, primary } = props;
  const selected = docs.find((d) => d.id === selectedDocId);
  const docId = mode === "job" ? jobDocId : selectedDocId;
  const title = mode === "job" ? jobDocName ?? "Untitled document" : selected?.name ?? "Choose a Google Doc";
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const renameRef = React.useRef<HTMLInputElement>(null);
  const wasRenaming = React.useRef(false);
  React.useEffect(() => {
    const now = renaming != null;
    if (now && !wasRenaming.current) { renameRef.current?.focus(); renameRef.current?.select(); }
    wasRenaming.current = now;
  }, [renaming]);
  const canRename = mode === "draft" && !!selected && !!props.onRename;
  React.useEffect(() => {
    const start = () => { if (canRename) setRenaming(selected!.name); };
    window.addEventListener(RENAME_EVENT, start);
    return () => window.removeEventListener(RENAME_EVENT, start);
  }, [canRename, selected]);
  const finishRename = async () => {
    const name = (renaming ?? "").trim();
    setRenaming(null);
    if (name && name !== selected?.name && props.onRename) await props.onRename(name);
  };

  return (
    <header className="ss-header">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/sync-icon.png" alt="" className="ss-header-logo" />

      <div className="ss-header-main">
        <div className="ss-title-row">
          {renaming != null ? (
            <input
              ref={renameRef}
              className="ss-title-input"
              value={renaming}
              aria-label="Document name"
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={() => { void finishRename(); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void finishRename(); } else if (e.key === "Escape") setRenaming(null); }}
            />
          ) : mode === "draft" ? (
            <Menu label="Target Google Doc" className="w-[min(480px,calc(100vw-16px))]" trigger={
              <button className="ss-title" onDoubleClick={() => { if (canRename) setRenaming(selected!.name); }} title={canRename ? "Choose the document · double-click to rename" : "Choose the document"}>
                <span className="truncate">{title}</span>
                <Icon name="arrow_drop_down" className="ss-title-arrow" />
              </button>
            }>
              <MenuLabel>Type into</MenuLabel>
              {docs.length === 0 && <MenuItem disabled>No recent documents</MenuItem>}
              {docs.map((d) => (
                <MenuItem key={d.id} checkable checked={d.id === selectedDocId} onSelect={() => props.onSelectDoc(d.id)} shortcut={editedLabel(d.modifiedTime)}>
                  {d.name}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem icon={<Icon name="note_add" size={18} />} onSelect={props.onNewDoc} disabled={props.isCreatingDoc}>
                {props.isCreatingDoc ? "Creating document" : "New Google Doc"}
              </MenuItem>
              <MenuItem icon={<Icon name="refresh" size={18} />} onSelect={props.onRefreshDocs}>Refresh list</MenuItem>
            </Menu>
          ) : (
            <span className="ss-title ss-title-static"><span className="truncate">{title}</span></span>
          )}
          {props.tab && renaming == null && (
            <span className="ss-header-tab" title={`Tab: ${props.tab.title}`} aria-label={`Tab: ${props.tab.title}`}>
              <Icon name="chevron_right" size={18} className="flex-none text-[var(--ss-text-3)]" />
              <span className="truncate">{props.tab.title}</span>
            </span>
          )}
          <div className="ss-badges">
            {docId && (
              <a href={docsUrl(docId, props.tab?.id)} target="_blank" rel="noopener noreferrer" className="ss-badge" title="Open in Google Docs" aria-label="Open in Google Docs">
                <Icon name="open_in_new" />
              </a>
            )}
            {status && (
              <span className="ss-status" data-ss-status data-visible={status.visible ? "true" : undefined} title={status.text}>
                <span className="ss-badge"><Icon name={status.icon} /></span>
                <span data-ss-status-text className={status.visible ? "ss-status-text" : "sr-only"}>{status.text}</span>
              </span>
            )}
          </div>
        </div>
        <div className="ss-menubar-row max-sm:hidden">{props.menubar}</div>
      </div>

      <div className="ss-header-actions">
        {mode === "draft" && (
          <button className="ss-btn ss-btn-outlined max-md:w-10 max-md:px-0" onClick={props.onNewDoc} disabled={props.isCreatingDoc} title="Create a Google Doc and open it here" aria-label="New Google Doc">
            <Icon name="add" />
            <span className="max-md:hidden">{props.isCreatingDoc ? "Creating" : "New Google Doc"}</span>
          </button>
        )}
        <button
          className={`ss-btn ${primary.kind === "start" ? "ss-btn-tonal" : "ss-btn-outlined"} max-sm:w-10 max-sm:px-0`}
          onClick={primary.onClick}
          disabled={primary.disabled}
          title={primary.title ?? primary.label}
          aria-label={primary.label}
        >
          <Icon name={primary.kind === "start" ? "play_arrow" : "arrow_back"} />
          <span className="max-sm:hidden">{primary.label}</span>
        </button>
        <AccountMenu user={user} onReauth={props.onReauth} onSignOut={props.onSignOut} />
      </div>
    </header>
  );
}

/** The account picture with the sign-in menu, in the header */
export function AccountMenu({ user, onReauth, onSignOut }: { user: HeaderUser | null; onReauth: () => void; onSignOut: () => void }) {
  return (
    <Menu align="end" label="Account" trigger={
      <button className="ml-1 h-8 w-8 flex-none overflow-hidden rounded-full ring-offset-2 hover:ring-4 hover:ring-[var(--ss-hover)]" aria-label="Account">
        {user?.picture ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.picture} alt="" className="h-8 w-8" referrerPolicy="no-referrer" />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center bg-[#0b57d0] text-sm font-medium text-white">
            {(user?.name || "?").charAt(0).toUpperCase()}
          </span>
        )}
      </button>
    }>
      <div className="px-4 pb-2 pt-2">
        <div className="text-sm font-medium">{user?.name}</div>
        <div className="text-xs text-[var(--ss-text-3)]">{user?.email}</div>
      </div>
      <MenuSeparator />
      <MenuItem onSelect={onReauth}>Reconnect Google account</MenuItem>
      <MenuItem onSelect={() => window.open("/privacy", "_blank")}>Privacy policy</MenuItem>
      <MenuItem onSelect={() => window.open("/tos", "_blank")}>Terms of service</MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={onSignOut}>Sign out</MenuItem>
    </Menu>
  );
}

function editedLabel(iso: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The document in Google Docs, at its tab when it has one */
export const docsUrl = (docId: string, tabId?: string | null) => `https://docs.google.com/document/d/${docId}/edit${tabId ? `?tab=${encodeURIComponent(tabId)}` : ""}`;
