"use client";

import React from "react";
import Link from "next/link";

/** Compare & Sync's own switch: documents or spreadsheets */
export function CompareKind({ active }: { active: "docs" | "sheets" }) {
  const item = (id: "docs" | "sheets", href: string, label: string) => (
    <Link href={href} className="ss-kind" aria-current={active === id ? "page" : undefined} prefetch>{label}</Link>
  );
  return (
    <nav className="ss-kinds" aria-label="What to compare">
      {item("docs", "/dashboard/compare", "Docs")}
      {item("sheets", "/dashboard/compare/sheets", "Sheets")}
    </nav>
  );
}
