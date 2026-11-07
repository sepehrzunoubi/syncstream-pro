"use client";

/**
 * Compare & Sync's title bar: the editor's (logo, title, menus, the section switch and the
 * account), with its own menus.
 */

import React from "react";
import * as MB from "@radix-ui/react-menubar";
import { AccountMenu, docsUrl, type HeaderUser } from "../workspace/header";
import { MenubarItem as Item, MenubarMenu as TopMenu, MenubarSeparator as Sep, MenubarSub as Sub } from "../workspace/menubar";
import { SectionSwitch } from "./section-switch";
import type { PickedDoc } from "./storage";

export const ZOOMS = [50, 75, 90, 100, 125];

interface CompareHeaderProps {
  user: HeaderUser | null;
  /** Beside the title: what the page is doing, in a few words */
  status: string | null;
  onReauth: () => void;
  onSignOut: () => void;
  menus: {
    left: PickedDoc | null;
    right: PickedDoc | null;
    canCompare: boolean;
    onNew: () => void;
    onSwap: () => void;
    onReload: () => void;
    scrollSync: boolean;
    onToggleScrollSync: () => void;
    tabsOpen: boolean;
    onToggleTabs: () => void;
    zoom: number | "fit";
    onZoom: (z: number | "fit") => void;
  };
}

export function CompareHeader({ user, status, onReauth, onSignOut, menus: m }: CompareHeaderProps) {
  const open = (d: PickedDoc | null) => () => { if (d) window.open(docsUrl(d.id), "_blank", "noopener"); };
  return (
    <header className="ss-header">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/sync-icon.png" alt="" className="ss-header-logo" />
      <div className="ss-header-main">
        <div className="ss-title-row">
          <h1 className="ss-title ss-title-static"><span className="truncate">Compare &amp; Sync</span></h1>
          {status && <span className="ss-status-text ss-cmp-status" data-ss-status-text aria-live="polite">{status}</span>}
        </div>
        <div className="ss-menubar-row max-sm:hidden">
          <MB.Root className="ss-menubar" aria-label="Menu">
            <TopMenu label="File">
              <Item onSelect={m.onNew}>New comparison</Item>
              <Item disabled={!m.left && !m.right} onSelect={m.onSwap}>Swap the documents</Item>
              <Item disabled={!m.canCompare} onSelect={m.onReload}>Compare again</Item>
              <Sep />
              <Item disabled={!m.left} onSelect={open(m.left)}>Open your document in Google Docs</Item>
              <Item disabled={!m.right} onSelect={open(m.right)}>Open the reference in Google Docs</Item>
            </TopMenu>
            <TopMenu label="View">
              <Item checkable checked={m.scrollSync} onSelect={m.onToggleScrollSync}>Scroll both pages together</Item>
              <Item checkable checked={m.tabsOpen} onSelect={m.onToggleTabs}>Show tabs</Item>
              <Sub label="Zoom">
                <Item checkable checked={m.zoom === "fit"} onSelect={() => m.onZoom("fit")}>Fit</Item>
                {ZOOMS.map((z) => <Item key={z} checkable checked={m.zoom === z} onSelect={() => m.onZoom(z)}>{z}%</Item>)}
              </Sub>
            </TopMenu>
          </MB.Root>
        </div>
      </div>
      <div className="ss-header-actions">
        <SectionSwitch active="compare" />
        <AccountMenu user={user} onReauth={onReauth} onSignOut={onSignOut} />
      </div>
    </header>
  );
}
