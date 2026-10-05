"use client";

import React from "react";
import Link from "next/link";
import { FileText, Wand2 } from "lucide-react";

export type WorkspaceTab = "sync" | "style";

/** Switches between the tools of the dashboard: the sync editor and the Style engine */
export function WorkspaceTabs({ active }: { active: WorkspaceTab }) {
  const tab = (id: WorkspaceTab, href: string, label: string, icon: React.ReactNode) => (
    <Link href={href} className="ss-tab" aria-current={active === id ? "page" : undefined} title={label}>
      {icon}
      <span className="max-sm:hidden">{label}</span>
    </Link>
  );
  return (
    <nav className="ss-tabs" aria-label="Tools">
      {tab("sync", "/dashboard", "Sync", <FileText className="h-[18px] w-[18px]" />)}
      {tab("style", "/dashboard/style", "Style engine", <Wand2 className="h-[18px] w-[18px]" />)}
    </nav>
  );
}
