"use client";

import React, { useEffect, useState } from "react";
import * as MB from "@radix-ui/react-menubar";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { Icon } from "./icon";
import { LINE_SPACINGS, NAMED_STYLES, NAMED_STYLE_ORDER, type NamedStyle } from "@/lib/rich-text";

function useMod() {
  const [mod, setMod] = useState("Ctrl+");
  useEffect(() => { if (/Mac|iPhone|iPad/.test(navigator.platform)) setMod("⌘"); }, []);
  return mod;
}

function Item({ children, onSelect, shortcut, disabled, checked, checkable }: { children: React.ReactNode; onSelect?: () => void; shortcut?: string; disabled?: boolean; checked?: boolean; checkable?: boolean }) {
  return (
    <MB.Item className="ss-menu-item" onSelect={onSelect} disabled={disabled}>
      <span className="ss-check">{checkable && checked ? <Icon name="check" size={18} /> : null}</span>
      <span className="min-w-0 truncate">{children}</span>
      {shortcut && <span className="ss-shortcut">{shortcut}</span>}
    </MB.Item>
  );
}

function Sub({ label, children, disabled }: { label: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <MB.Sub>
      <MB.SubTrigger className="ss-menu-item" disabled={disabled}>
        <span className="ss-check" />
        <span className="min-w-0 truncate">{label}</span>
        <span className="ss-sub-arrow"><Icon name="arrow_drop_down" className="-rotate-90" /></span>
      </MB.SubTrigger>
      <MB.Portal>
        <MB.SubContent className="ss-menu" sideOffset={2} alignOffset={-6} collisionPadding={8}>
          {children}
        </MB.SubContent>
      </MB.Portal>
    </MB.Sub>
  );
}

function TopMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <MB.Menu>
      <MB.Trigger className="ss-menubar-trigger">{label}</MB.Trigger>
      <MB.Portal>
        <MB.Content className="ss-menu min-w-[240px]" align="start" sideOffset={2} collisionPadding={8} onCloseAutoFocus={(e) => e.preventDefault()}>
          {children}
        </MB.Content>
      </MB.Portal>
    </MB.Menu>
  );
}

const Sep = () => <MB.Separator className="ss-menu-sep" />;

interface DocsMenubarProps {
  editor: Editor | null;
  editingDisabled: boolean;
  zoom: number | "fit";
  onZoom: (z: number | "fit") => void;
  railOpen: boolean;
  onToggleRail: () => void;
  onNewSync: () => void;
  onCreateDoc: () => void;
  onRefreshDocs: () => void;
  docUrl: string | null;
  onSignOut: () => void;
}

export function DocsMenubar(p: DocsMenubarProps) {
  const mod = useMod();
  const st = useEditorState({
    editor: p.editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const para = e.getAttributes("paragraph");
      return {
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        underline: e.isActive("underline"),
        strike: e.isActive("strike"),
        style: (para.styleName as NamedStyle) ?? "normal",
        align: (para.textAlign as string) ?? "left",
        spacing: (para.lineSpacing as number) ?? 115,
        firstLine: !!para.firstLine,
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
      };
    },
  });
  const run = (fn: (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => {
    if (p.editor) fn(p.editor.chain().focus()).run();
  };
  const off = p.editingDisabled || !st;

  return (
    <MB.Root className="ss-menubar" aria-label="Menu">
      <TopMenu label="File">
        <Item onSelect={p.onNewSync}>New sync</Item>
        <Item onSelect={p.onCreateDoc}>Create a new Google Doc</Item>
        <Item onSelect={p.onRefreshDocs}>Refresh document list</Item>
        <Item disabled={!p.docUrl} onSelect={() => p.docUrl && window.open(p.docUrl, "_blank", "noopener")}>Open in Google Docs</Item>
        <Sep />
        <Item onSelect={p.onSignOut}>Sign out</Item>
      </TopMenu>

      <TopMenu label="Edit">
        <Item disabled={off || !st?.canUndo} shortcut={`${mod}Z`} onSelect={() => run((c) => c.undo())}>Undo</Item>
        <Item disabled={off || !st?.canRedo} shortcut={`${mod}Y`} onSelect={() => run((c) => c.redo())}>Redo</Item>
        <Sep />
        <Item disabled={off} shortcut={`${mod}A`} onSelect={() => run((c) => c.selectAll())}>Select all</Item>
      </TopMenu>

      <TopMenu label="View">
        <Sub label="Zoom">
          <Item checkable checked={p.zoom === "fit"} onSelect={() => p.onZoom("fit")}>Fit</Item>
          {[50, 75, 90, 100, 125, 150].map((z) => (
            <Item key={z} checkable checked={p.zoom === z} onSelect={() => p.onZoom(z)}>{z}%</Item>
          ))}
        </Sub>
        <Item checkable checked={p.railOpen} onSelect={p.onToggleRail}>Show syncs</Item>
      </TopMenu>

      <TopMenu label="Format">
        <Sub label="Text" disabled={off}>
          <Item checkable checked={st?.bold} shortcut={`${mod}B`} onSelect={() => run((c) => c.toggleBold())}>Bold</Item>
          <Item checkable checked={st?.italic} shortcut={`${mod}I`} onSelect={() => run((c) => c.toggleItalic())}>Italic</Item>
          <Item checkable checked={st?.underline} shortcut={`${mod}U`} onSelect={() => run((c) => c.toggleUnderline())}>Underline</Item>
          <Item checkable checked={st?.strike} shortcut={`${mod}Shift+S`} onSelect={() => run((c) => c.toggleStrike())}>Strikethrough</Item>
        </Sub>
        <Sub label="Paragraph styles" disabled={off}>
          {NAMED_STYLE_ORDER.map((s) => (
            <Item key={s} checkable checked={st?.style === s} onSelect={() => run((c) => c.setNamedStyle(s))}>{NAMED_STYLES[s].label}</Item>
          ))}
        </Sub>
        <Sub label="Align & indent" disabled={off}>
          {(["left", "center", "right", "justify"] as const).map((a) => (
            <Item key={a} checkable checked={st?.align === a} onSelect={() => run((c) => c.setTextAlign(a))}>{a[0].toUpperCase() + a.slice(1)}</Item>
          ))}
          <Sep />
          <Item shortcut={`${mod}]`} onSelect={() => run((c) => c.indent())}>Increase indent</Item>
          <Item shortcut={`${mod}[`} onSelect={() => run((c) => c.outdent())}>Decrease indent</Item>
          <Item checkable checked={st?.firstLine} shortcut="Tab" onSelect={() => run((c) => c.setFirstLine(!st?.firstLine))}>Indent first line</Item>
        </Sub>
        <Sub label="Line & paragraph spacing" disabled={off}>
          {LINE_SPACINGS.map((ls) => (
            <Item key={ls.value} checkable checked={st?.spacing === ls.value} onSelect={() => run((c) => c.setLineSpacing(ls.value))}>{ls.label}</Item>
          ))}
        </Sub>
        <Sep />
        <Item disabled={off} shortcut={`${mod}\\`} onSelect={() => run((c) => c.clearFormatting())}>Clear formatting</Item>
      </TopMenu>
    </MB.Root>
  );
}
