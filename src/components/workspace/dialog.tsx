"use client";

import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import * as DM from "@radix-ui/react-dropdown-menu";
import { Icon } from "./icon";
import { PALETTE } from "./color-menu";

/** A Docs-style modal dialog */
export function Dialog({ open, title, onClose, onSubmit, children, footer, width = 440 }: {
  open: boolean;
  title: string;
  onClose: () => void;
  onSubmit?: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  const id = `ss-dialog-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return createPortal(
    <div className="ss-dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="ss-dialog" style={{ width }} role="dialog" aria-modal="true" aria-labelledby={id} onSubmit={(e) => { e.preventDefault(); onSubmit?.(); }}>
        <h2 id={id} className="ss-dialog-title">{title}</h2>
        {children}
        <div className="mt-6 flex items-center gap-2">{footer}</div>
      </form>
    </div>,
    document.body
  );
}

/** A colour swatch that opens Docs' palette */
export function ColorSelect({ value, onChange, label, none }: { value: string | null; onChange: (c: string | null) => void; label: string; none?: boolean }) {
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>
        <button type="button" className="ss-color-select" aria-label={label}>
          <span className="ss-color-dot" style={{ background: value ?? "#ffffff" }} />
          <Icon name="arrow_drop_down" size={20} />
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content className="ss-menu" sideOffset={4} align="start" collisionPadding={8} style={{ zIndex: 60 }} onCloseAutoFocus={(e) => e.preventDefault()}>
          {none && (
            <>
              <DM.Item className="ss-menu-item" onSelect={() => onChange(null)}><span className="ss-check"><Icon name="format_color_reset" size={18} /></span>None</DM.Item>
              <div className="ss-menu-sep" />
            </>
          )}
          <div className="ss-palette" role="group" aria-label={label}>
            {PALETTE.flat().map((hex) => (
              <DM.Item key={hex} className="ss-swatch" data-on={(value ?? "#ffffff") === hex} style={{ background: hex }} aria-label={hex} onSelect={() => onChange(!none && hex === "#ffffff" ? null : hex)} />
            ))}
          </div>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
