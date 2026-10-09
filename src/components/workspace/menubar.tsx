"use client";

import React, { useEffect, useState } from "react";
import * as MB from "@radix-ui/react-menubar";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { Icon } from "./icon";
import { BULLET_PRESETS, LINE_SPACINGS, NAMED_STYLES, NAMED_STYLE_ORDER, NUMBER_PRESETS, type NamedStyle } from "@/lib/rich-text";
import { presetGlyph, glyphNumber } from "@/lib/list-labels";

/** "1. a. i." or "● ○ ■": the first three levels of a Docs list style */
function presetLabel(preset: string): string {
  return [0, 1, 2].map((level) => { const g = presetGlyph(preset, level); return typeof g === "string" ? g : g.format.replace(/%(\d)/g, (_m, d: string) => glyphNumber(1, Number(d) === level ? g.type : "DECIMAL")); }).join("  ");
}

function useMod() {
  const [mod, setMod] = useState("Ctrl+");
  useEffect(() => { if (/Mac|iPhone|iPad/.test(navigator.platform)) setMod("⌘"); }, []);
  return mod;
}

function Item({ children, onSelect, shortcut, disabled, checked, checkable }: { children: React.ReactNode; onSelect?: () => void; shortcut?: string; disabled?: boolean; checked?: boolean; checkable?: boolean }) {
  return (
    <MB.Item className="ss-menu-item" onSelect={onSelect} disabled={disabled} onMouseDown={keepSelection}>
      <span className="ss-check">{checkable && checked ? <Icon name="check" size={18} /> : null}</span>
      <span className="min-w-0 truncate">{children}</span>
      {shortcut && <span className="ss-shortcut">{shortcut}</span>}
    </MB.Item>
  );
}

function Sub({ label, children, disabled }: { label: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <MB.Sub>
      <MB.SubTrigger className="ss-menu-item" disabled={disabled} onMouseDown={keepSelection}>
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
      <MB.Trigger className="ss-menubar-trigger" onMouseDown={keepSelection}>{label}</MB.Trigger>
      <MB.Portal>
        <MB.Content className="ss-menu min-w-[240px]" align="start" sideOffset={2} collisionPadding={8} onCloseAutoFocus={(e) => e.preventDefault()}>
          {children}
        </MB.Content>
      </MB.Portal>
    </MB.Menu>
  );
}

const Sep = () => <MB.Separator className="ss-menu-sep" />;
/** Menus never take the editor's selection: a mousedown on them would collapse it before the command runs */
const keepSelection = (e: React.MouseEvent) => e.preventDefault();

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
  /** Open the Style engine tab */
  onOpenStyle?: () => void;
  docUrl: string | null;
  onSignOut: () => void;
  onPageSetup: () => void;
  onCustomSpacing: () => void;
  onBorders: () => void;
}

export function DocsMenubar(p: DocsMenubarProps) {
  const mod = useMod();
  const st = useEditorState({
    editor: p.editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const para = e.getAttributes("paragraph");
      const box = para.box as { above?: number | null; below?: number | null } | null;
      const keep = (para.keep as { withNext?: boolean; linesTogether?: boolean; singleLines?: boolean } | null) ?? {};
      return {
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        underline: e.isActive("underline"),
        strike: e.isActive("strike"),
        sup: e.isActive("superscript"),
        sub: e.isActive("subscript"),
        above: box?.above ?? 0,
        below: box?.below ?? 0,
        keepNext: !!keep.withNext,
        keepLines: !!keep.linesTogether,
        singleLines: keep.singleLines !== false,
        style: (para.styleName as NamedStyle) ?? "normal",
        align: (para.textAlign as string) ?? "left",
        spacing: (para.lineSpacing as number) ?? 115,
        firstLine: !!para.firstLine,
        list: (para.list as string | null) ?? null,
        preset: (para.preset as string | null) ?? null,
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
        {p.onOpenStyle && <Item onSelect={p.onOpenStyle}>Style engine</Item>}
        <Sep />
        <Item onSelect={p.onPageSetup}>Page setup</Item>
        <Item shortcut={`${mod}P`} onSelect={() => window.print()}>Print</Item>
        <Sep />
        <Item onSelect={p.onSignOut}>Sign out</Item>
      </TopMenu>

      <TopMenu label="Edit">
        <Item disabled={off || !st?.canUndo} shortcut={`${mod}Z`} onSelect={() => run((c) => c.undo())}>Undo</Item>
        <Item disabled={off || !st?.canRedo} shortcut={`${mod}Y`} onSelect={() => run((c) => c.redo())}>Redo</Item>
        <Sep />
        <Item disabled={off} shortcut={`${mod}X`} onSelect={() => { p.editor?.commands.focus(); document.execCommand("cut"); }}>Cut</Item>
        <Item disabled={off} shortcut={`${mod}C`} onSelect={() => { p.editor?.commands.focus(); document.execCommand("copy"); }}>Copy</Item>
        <Item disabled={off} shortcut={`${mod}V`} onSelect={() => window.dispatchEvent(new CustomEvent("ss-paste-hint"))}>Paste</Item>
        <Item disabled={off} shortcut={`${mod}Shift+V`} onSelect={() => window.dispatchEvent(new CustomEvent("ss-paste-hint"))}>Paste without formatting</Item>
        <Item disabled={off} onSelect={() => run((c) => c.deleteSelection())}>Delete</Item>
        <Sep />
        <Item disabled={off} shortcut={`${mod}A`} onSelect={() => run((c) => c.selectAll())}>Select all</Item>
        <Sep />
        <Item disabled={off} shortcut={`${mod}H`} onSelect={() => window.dispatchEvent(new CustomEvent("ss-find", { detail: "dialog" }))}>Find and replace</Item>
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

      <TopMenu label="Insert">
        <Sub label="Image" disabled={off}>
          <Item onSelect={() => window.dispatchEvent(new CustomEvent("ss-image-upload"))}>Upload from computer</Item>
          <Item onSelect={() => window.dispatchEvent(new CustomEvent("ss-image-url"))}>By URL</Item>
        </Sub>
        <Item disabled={off} shortcut={`${mod}K`} onSelect={() => window.dispatchEvent(new CustomEvent("ss-open-link"))}>Link</Item>
      </TopMenu>

      <TopMenu label="Format">
        <Sub label="Text" disabled={off}>
          <Item checkable checked={st?.bold} shortcut={`${mod}B`} onSelect={() => run((c) => c.toggleBold())}>Bold</Item>
          <Item checkable checked={st?.italic} shortcut={`${mod}I`} onSelect={() => run((c) => c.toggleItalic())}>Italic</Item>
          <Item checkable checked={st?.underline} shortcut={`${mod}U`} onSelect={() => run((c) => c.toggleUnderline())}>Underline</Item>
          <Item checkable checked={st?.strike} shortcut={`${mod}Shift+X`} onSelect={() => run((c) => c.toggleStrike())}>Strikethrough</Item>
          <Item checkable checked={st?.sup} shortcut={`${mod}.`} onSelect={() => run((c) => c.toggleMark("superscript"))}>Superscript</Item>
          <Item checkable checked={st?.sub} shortcut={`${mod},`} onSelect={() => run((c) => c.toggleMark("subscript"))}>Subscript</Item>
          <Sep />
          <Sub label="Size">
            <Item shortcut={`${mod}Shift+.`} onSelect={() => run((c) => c.stepFontSize(1))}>Increase font size</Item>
            <Item shortcut={`${mod}Shift+,`} onSelect={() => run((c) => c.stepFontSize(-1))}>Decrease font size</Item>
          </Sub>
          <Sub label="Capitalization">
            <Item onSelect={() => run((c) => c.setCapitalization("lower"))}>lowercase</Item>
            <Item onSelect={() => run((c) => c.setCapitalization("upper"))}>UPPERCASE</Item>
            <Item onSelect={() => run((c) => c.setCapitalization("title"))}>Title Case</Item>
          </Sub>
        </Sub>
        <Sub label="Paragraph styles" disabled={off}>
          <Item onSelect={p.onBorders}>Borders and shading</Item>
          <Sep />
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
        <Sub label="Bullets & numbering" disabled={off}>
          <Sub label="Numbered list">
            {NUMBER_PRESETS.map((p) => (
              <Item key={p} checkable checked={st?.list === "ordered" && (st?.preset ?? NUMBER_PRESETS[0]) === p} onSelect={() => run((c) => (st?.list ? c.setListPreset(p) : c.toggleList("ordered", p)))}>{presetLabel(p)}</Item>
            ))}
          </Sub>
          <Sub label="Bulleted list">
            {BULLET_PRESETS.filter((p) => p !== "BULLET_CHECKBOX").map((p) => (
              <Item key={p} checkable checked={st?.list === "bullet" && (st?.preset ?? BULLET_PRESETS[0]) === p} onSelect={() => run((c) => (st?.list ? c.setListPreset(p) : c.toggleList("bullet", p)))}>{presetLabel(p)}</Item>
            ))}
          </Sub>
          <Item checkable checked={st?.list === "check"} shortcut={`${mod}Shift+9`} onSelect={() => run((c) => c.toggleList("check"))}>Checklist</Item>
          <Item checkable checked={st?.list === "bullet"} shortcut={`${mod}Shift+8`} onSelect={() => run((c) => c.toggleList("bullet"))}>Bulleted list</Item>
          <Item checkable checked={st?.list === "ordered"} shortcut={`${mod}Shift+7`} onSelect={() => run((c) => c.toggleList("ordered"))}>Numbered list</Item>
        </Sub>
        <Sub label="Line & paragraph spacing" disabled={off}>
          {LINE_SPACINGS.map((ls) => (
            <Item key={ls.value} checkable checked={st?.spacing === ls.value} onSelect={() => run((c) => c.setLineSpacing(ls.value))}>{ls.label}</Item>
          ))}
          <Sep />
          <Item onSelect={() => run((c) => c.setParagraphSpace({ above: st?.above ? 0 : 10 }))}>{st?.above ? "Remove space before paragraph" : "Add space before paragraph"}</Item>
          <Item onSelect={() => run((c) => c.setParagraphSpace({ below: st?.below ? 0 : 10 }))}>{st?.below ? "Remove space after paragraph" : "Add space after paragraph"}</Item>
          <Item onSelect={p.onCustomSpacing}>Custom spacing</Item>
          <Sep />
          <Item checkable checked={st?.keepNext} onSelect={() => run((c) => c.setKeep({ withNext: !st?.keepNext }))}>Keep with next</Item>
          <Item checkable checked={st?.keepLines} onSelect={() => run((c) => c.setKeep({ linesTogether: !st?.keepLines }))}>Keep lines together</Item>
          <Item checkable checked={st?.singleLines} onSelect={() => run((c) => c.setKeep({ singleLines: !st?.singleLines }))}>Prevent single lines</Item>
        </Sub>
        <Sep />
        <Item disabled={off} shortcut={`${mod}\\`} onSelect={() => run((c) => c.clearFormatting())}>Clear formatting</Item>
      </TopMenu>
    </MB.Root>
  );
}
