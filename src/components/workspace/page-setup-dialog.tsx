"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ColorSelect } from "./dialog";
import { PAPERS, PAPER_ORDER, pageSize, type PageSetup, type PaperId } from "@/lib/page-setup";

interface Props {
  open: boolean;
  setup: PageSetup;
  pageless: boolean;
  onClose: () => void;
  onApply: (setup: PageSetup, pageless: boolean) => void;
  /** Remember this setup for new documents */
  onSetDefault: (setup: PageSetup, pageless: boolean) => void;
}

const inches = (pt: number) => String(Math.round((pt / 72) * 100) / 100);
const MARGIN_KEYS = ["top", "bottom", "left", "right"] as const;

/** Docs' Page setup dialog: pages or pageless, orientation, paper size, colour and margins. */
export function PageSetupDialog({ open, setup, pageless, onClose, onApply, onSetDefault }: Props) {
  const [tab, setTab] = useState<"pages" | "pageless">(pageless ? "pageless" : "pages");
  const [orientation, setOrientation] = useState(setup.orientation);
  const [paper, setPaper] = useState<PaperId>(setup.paper);
  const [color, setColor] = useState<string | null>(setup.color);
  const [margins, setMargins] = useState<Record<(typeof MARGIN_KEYS)[number], string>>({ top: "1", bottom: "1", left: "1", right: "1" });
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setTab(pageless ? "pageless" : "pages");
    setOrientation(setup.orientation);
    setPaper(setup.paper);
    setColor(setup.color);
    setMargins({ top: inches(setup.margins.top), bottom: inches(setup.margins.bottom), left: inches(setup.margins.left), right: inches(setup.margins.right) });
    setTimeout(() => firstRef.current?.focus(), 0);
  }, [open, setup, pageless]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const parsed = MARGIN_KEYS.map((k) => parseFloat(margins[k]));
  const next: PageSetup = {
    orientation,
    paper,
    color,
    margins: { top: (parsed[0] || 0) * 72, bottom: (parsed[1] || 0) * 72, left: (parsed[2] || 0) * 72, right: (parsed[3] || 0) * 72 },
  };
  const { w, h } = pageSize(next);
  let error: string | null = null;
  if (parsed.some((n) => !Number.isFinite(n) || n < 0)) error = "Enter the margins in inches";
  else if (next.margins.left + next.margins.right > w - 36 || next.margins.top + next.margins.bottom > h - 36) error = "The margins leave no room for text";
  const valid = !error;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onApply(next, tab === "pageless");
    onClose();
  };

  return createPortal(
    <div className="ss-dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="ss-dialog" role="dialog" aria-modal="true" aria-labelledby="ss-page-setup-title" onSubmit={submit}>
        <h2 id="ss-page-setup-title" className="ss-dialog-title">Page setup</h2>
        <div className="ss-dialog-tabs" role="tablist">
          <button ref={firstRef} type="button" role="tab" aria-selected={tab === "pages"} data-active={tab === "pages"} className="ss-dialog-tab" onClick={() => setTab("pages")}>Pages</button>
          <button type="button" role="tab" aria-selected={tab === "pageless"} data-active={tab === "pageless"} className="ss-dialog-tab" onClick={() => setTab("pageless")}>Pageless</button>
        </div>

        {tab === "pages" ? (
          <div className="flex flex-col gap-5">
            <label className="block">
              <span className="ss-field-label">Apply to</span>
              <select className="ss-select" value="whole" disabled aria-label="Apply to">
                <option value="whole">Whole document</option>
              </select>
            </label>
            <fieldset>
              <legend className="ss-field-label">Orientation</legend>
              <div className="flex gap-8">
                {(["portrait", "landscape"] as const).map((o) => (
                  <label key={o} className="ss-radio">
                    <input type="radio" name="orientation" value={o} checked={orientation === o} onChange={() => setOrientation(o)} />
                    <span className="ss-radio-dot" aria-hidden="true" />
                    {o === "portrait" ? "Portrait" : "Landscape"}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex gap-4">
              <label className="block min-w-0 flex-1">
                <span className="ss-field-label">Paper size</span>
                <select className="ss-select" value={paper} onChange={(e) => setPaper(e.target.value as PaperId)}>
                  {PAPER_ORDER.map((id) => <option key={id} value={id}>{PAPERS[id].label}</option>)}
                </select>
              </label>
              <div className="block">
                <span className="ss-field-label">Page color</span>
                <ColorSelect value={color} onChange={setColor} label="Page color" />
              </div>
            </div>
            <fieldset>
              <legend className="ss-field-label">Margins (inches)</legend>
              <div className="grid grid-cols-4 gap-3">
                {MARGIN_KEYS.map((k) => (
                  <label key={k} className="block">
                    <span className="ss-field-sub">{k[0].toUpperCase() + k.slice(1)}</span>
                    <input className="ss-input" inputMode="decimal" value={margins[k]} onChange={(e) => setMargins({ ...margins, [k]: e.target.value })} aria-label={`${k} margin in inches`} />
                  </label>
                ))}
              </div>
              {error && <p className="ss-field-error">{error}</p>}
            </fieldset>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <p className="text-[14px] leading-5 text-[var(--ss-text-2)]">Text and images fit the window, with no page breaks. Pages are kept in the Google Doc.</p>
            <div className="block">
              <span className="ss-field-label">Background color</span>
              <ColorSelect value={color} onChange={setColor} label="Background color" />
            </div>
          </div>
        )}

        <div className="mt-6 flex items-center gap-2">
          <button type="button" className="ss-btn ss-btn-text ss-btn-quiet" disabled={!valid} onClick={() => { onSetDefault(next, tab === "pageless"); }}>Set as default</button>
          <span className="flex-1" />
          <button type="button" className="ss-btn ss-btn-text" onClick={onClose}>Cancel</button>
          <button type="submit" className="ss-btn ss-btn-filled" disabled={!valid}>OK</button>
        </div>
      </form>
    </div>,
    document.body
  );
}
