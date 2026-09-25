"use client";

import React from "react";
import * as DM from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";

interface MenuProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: "start" | "center" | "end";
  /** Keep focus where the command put it (the editor) instead of the trigger */
  keepFocus?: boolean;
  className?: string;
  label?: string;
}

export function Menu({ trigger, children, align = "start", keepFocus, className, label }: MenuProps) {
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild aria-label={label}>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content
          className={`ss-menu ${className ?? ""}`}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={keepFocus ? (e) => e.preventDefault() : undefined}
        >
          {children}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

interface MenuItemProps {
  children: React.ReactNode;
  onSelect?: () => void;
  checked?: boolean;
  /** Reserve the check column even when unchecked, for lists of options */
  checkable?: boolean;
  shortcut?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  style?: React.CSSProperties;
}

export function MenuItem({ children, onSelect, checked, checkable, shortcut, icon, disabled, style }: MenuItemProps) {
  return (
    <DM.Item className="ss-menu-item" onSelect={onSelect} disabled={disabled} style={style}>
      {checkable && <span className="ss-check">{checked ? <Check className="h-[18px] w-[18px]" /> : null}</span>}
      {icon && <span className="flex w-5 justify-center text-[var(--ss-text-2)]">{icon}</span>}
      <span className="min-w-0 truncate">{children}</span>
      {shortcut && <span className="ss-shortcut">{shortcut}</span>}
    </DM.Item>
  );
}

export function MenuSeparator() {
  return <DM.Separator className="ss-menu-sep" />;
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <DM.Label className="ss-menu-label">{children}</DM.Label>;
}
