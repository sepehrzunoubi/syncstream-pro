"use client";

import React from "react";
import { ChevronDown, ExternalLink, FilePlus2, Menu as MenuIcon, Play, Plus, RotateCw } from "lucide-react";
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
}

export function Header(props: HeaderProps) {
  const { user, mode, docs, selectedDocId, jobDocName, jobDocId, subtitle, primary } = props;
  const selected = docs.find((d) => d.id === selectedDocId);
  const docId = mode === "job" ? jobDocId : selectedDocId;
  const title = mode === "job" ? jobDocName ?? "Untitled document" : selected?.name ?? "Choose a Google Doc";

  return (
    <header className="flex h-16 flex-none items-center gap-2 pl-2 pr-4">
      <button className="ss-icon-btn h-10 w-10 rounded-full" onClick={props.onToggleRail} aria-label="Show or hide syncs" title="Syncs">
        <MenuIcon className="h-5 w-5" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/sync-icon.png" alt="" className="hidden h-9 w-9 flex-none object-contain sm:block" />

      <div className="min-w-0 flex-1 pl-1">
        <div className="flex items-center gap-1">
          {mode === "draft" ? (
            <Menu label="Target Google Doc" trigger={
              <button className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[18px] leading-6 hover:bg-[var(--ss-hover)]">
                <span className="truncate">{title}</span>
                <ChevronDown className="h-4 w-4 flex-none text-[var(--ss-text-2)]" />
              </button>
            }>
              <MenuLabel>Type into</MenuLabel>
              {docs.length === 0 && <MenuItem disabled>No recent documents</MenuItem>}
              {docs.map((d) => (
                <MenuItem key={d.id} checkable checked={d.id === selectedDocId} onSelect={() => props.onSelectDoc(d.id)}>
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
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>
        <div className="truncate px-1.5 text-[12px] leading-4 text-[var(--ss-text-3)]">{subtitle}</div>
      </div>

      <button
        className={`ss-btn ${primary.kind === "start" ? "ss-btn-tonal" : "ss-btn-outlined"} max-sm:w-10 max-sm:px-0`}
        onClick={primary.onClick}
        disabled={primary.disabled}
        title={primary.title ?? primary.label}
        aria-label={primary.label}
      >
        {primary.kind === "start" ? <Play className="h-4 w-4 fill-current" /> : <Plus className="h-4 w-4" />}
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
