"use client";

import React from "react";
import Link from "next/link";
import { Columns2, FileText, Table2 } from "lucide-react";
import { SyncHistory } from "../history/sync-history";

export type Section = "sync" | "compare" | "sheets";

/**
 * The header's switch between the sync editor, Compare & Sync and Sheets, with the sync history beside it. `phone: false` leaves it out on a
 * phone, where the editor's header has no room (File and the sidebar link there instead).
 */
export function SectionSwitch({ active, phone = true }: { active: Section; phone?: boolean }) {
  const tab = (id: Section, href: string, label: string, icon: React.ReactNode) => (
    <Link href={href} className="ss-tab" aria-current={active === id ? "page" : undefined} title={label} aria-label={label} prefetch>
      {icon}
      <span className="ss-tab-label">{label}</span>
    </Link>
  );
  return (
    <>
      <nav className="ss-tabs" data-phone={phone ? undefined : "off"} aria-label="Sections">
        {tab("sync", "/dashboard", "Sync", <FileText className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />)}
        {tab("compare", "/dashboard/compare", "Compare & Sync", <Columns2 className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />)}
        {tab("sheets", "/dashboard/sheets", "Sheets", <Table2 className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />)}
      </nav>
      <SyncHistory />
    </>
  );
}
