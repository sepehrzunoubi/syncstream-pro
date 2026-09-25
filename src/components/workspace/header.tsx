"use client";

import React from "react";
import { FilePlus2, RotateCw } from "lucide-react";
import { Icon } from "./icon";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./menu";

type Doc = { id: string; name: string; modifiedTime: string };

export interface HeaderUser { name: string; email: string; picture: string }

interface HeaderProps {
  user: HeaderUser | null;
  /** Draft: pick the target doc. Viewing a sync: show its doc. */
  mode: "draft" | "job";
  docs: Doc[];
  selectedDocId: string;
  onSelectDoc: (id: string) => void;
  onCreateDoc: () => void;
  onRefreshDocs: () => void;
  isCreatingDoc: boolean;
  jobDocName?: string;
  jobDocId?: string;
  subtitle: string;
  primary: { label: string; onClick: () => void; disabled?: boolean; title?: string; kind: "start" | "new" };
  onToggleRail: () => void;
  onReauth: () => void;
  onSignOut: () => void;
  /** The File / Edit / View / Format menu bar */
  menubar: React.ReactNode;
}

export function Header(props: HeaderProps) {
  const { user, mode, docs, selectedDocId, jobDocName, jobDocId, subtitle, primary } = props;
  const selected = docs.find((d) => d.id === selectedDocId);
  const docId = mode === "job" ? jobDocId : selectedDocId;
  const title = mode === "job" ? jobDocName ?? "Untitled document" : selected?.name ?? "Choose a Google Doc";

  return (
    <header className="flex h-16 flex-none items-center gap-2 pl-2 pr-4">
      <button className="ss-icon-btn h-10 w-10 rounded-full" onClick={props.onToggleRail} aria-label="Show or hide syncs" title="Syncs">
        <Icon name="menu" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/sync-icon.png" alt="" className="hidden h-9 w-9 flex-none object-contain sm:block" />

      <div className="min-w-0 flex-1 pl-1">
        <div className="flex h-7 items-center gap-1">
          {mode === "draft" ? (
            <Menu label="Target Google Doc" className="w-[min(480px,calc(100vw-16px))]" trigger={
              <button className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[18px] leading-6 hover:bg-[var(--ss-hover)]">
                <span className="truncate">{title}</span>
                <Icon name="arrow_drop_down" className="flex-none text-[var(--ss-text-2)]" />
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
              <MenuItem icon={<FilePlus2 className="h-[18px] w-[18px]" />} onSelect={props.onCreateDoc} disabled={props.isCreatingDoc}>
                {props.isCreatingDoc ? "Creating document" : "Create a new Google Doc"}
              </MenuItem>
              <MenuItem icon={<RotateCw className="h-[18px] w-[18px]" />} onSelect={props.onRefreshDocs}>Refresh list</MenuItem>
            </Menu>
          ) : (
            <span className="truncate px-1.5 text-[18px] leading-6">{title}</span>
          )}
          {docId && (
            <a
              href={`https://docs.google.com/document/d/${docId}/edit`}
              target="_blank"
              rel="noopener noreferrer"
              className="ss-icon-btn h-8 w-8 rounded-full"
              title="Open in Google Docs"
              aria-label="Open in Google Docs"
            >
              <Icon name="open_in_new" size={18} />
            </a>
          )}
        </div>
        <div className="flex h-6 items-center gap-2 pl-1.5">
          <div className="max-sm:hidden">{props.menubar}</div>
          {subtitle && <span className="truncate text-[12px] text-[var(--ss-text-3)] sm:ml-2">{subtitle}</span>}
        </div>
      </div>

      <button
        className={`ss-btn ${primary.kind === "start" ? "ss-btn-tonal" : "ss-btn-outlined"} max-sm:w-10 max-sm:px-0`}
        onClick={primary.onClick}
        disabled={primary.disabled}
        title={primary.title ?? primary.label}
        aria-label={primary.label}
      >
        <Icon name={primary.kind === "start" ? "play_arrow" : "add"} />
        <span className="max-sm:hidden">{primary.label}</span>
      </button>

      <Menu align="end" label="Account" trigger={
        <button className="ml-2 h-8 w-8 flex-none overflow-hidden rounded-full ring-offset-2 hover:ring-4 hover:ring-[var(--ss-hover)]" aria-label="Account">
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
        <MenuItem onSelect={props.onReauth}>Reconnect Google account</MenuItem>
        <MenuItem onSelect={() => window.open("/privacy", "_blank")}>Privacy policy</MenuItem>
        <MenuItem onSelect={() => window.open("/tos", "_blank")}>Terms of service</MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={props.onSignOut}>Sign out</MenuItem>
      </Menu>
    </header>
  );
}

function editedLabel(iso: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
