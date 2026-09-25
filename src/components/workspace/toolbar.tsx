"use client";

import React, { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { Icon } from "./icon";
import { ColorMenu } from "./color-menu";
import { ImageMenu, LinkPopover } from "./insert-popovers";
import { Menu, MenuItem, MenuSeparator } from "./menu";
import {
  DEFAULT_FONT, FONT_FAMILIES, FONT_SIZES, LINE_SPACINGS, MAX_INDENT, NAMED_STYLES, NAMED_STYLE_ORDER,
  fontStack, type NamedStyle,
} from "@/lib/rich-text";

const ZOOMS = [50, 75, 90, 100, 125, 150];
const ALIGN_ICONS = { left: "format_align_left", center: "format_align_center", right: "format_align_right", justify: "format_align_justify" } as const;
const ALIGN_LABELS = { left: "Left", center: "Center", right: "Right", justify: "Justify" } as const;
const ALIGN_KEYS = { left: "L", center: "E", right: "R", justify: "J" } as const;

function useModKey() {
  const [mod, setMod] = useState("Ctrl+");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setMod("⌘");
  }, []);
  return mod;
}

interface ToolbarProps {
  editor: Editor | null;
  disabled?: boolean;
  onInsertImages: (files: File[]) => void;
  onInsertImageUrl: (url: string) => void;
  /** A percentage, or "fit" to scale the page to the available width */
  zoom: number | "fit";
  onZoom: (z: number | "fit") => void;
}

type Painter = { marks: { type: string; attrs: Record<string, unknown> }[]; para: Record<string, unknown> } | null;

export function Toolbar({ editor, disabled, zoom, onZoom, onInsertImages, onInsertImageUrl }: ToolbarProps) {
  const mod = useModKey();
  const [spellcheck, setSpellcheck] = useState(true);
  const [painter, setPainter] = useState<Painter>(null);

  useEffect(() => {
    editor?.view.dom.setAttribute("spellcheck", spellcheck ? "true" : "false");
  }, [editor, spellcheck]);

  // Paint format: copy the formatting at the cursor, apply it to the next selection
  useEffect(() => {
    if (!editor || !painter) return;
    const dom = editor.view.dom as HTMLElement;
    dom.classList.add("ss-painting");
    const applyPaint = () => setTimeout(() => {
      if (editor.state.selection.empty) return;
      let chain = editor.chain().focus().unsetAllMarks();
      for (const m of painter.marks) chain = chain.setMark(m.type, m.attrs);
      const { styleName, textAlign, lineSpacing, indent, firstLine, list } = painter.para;
      chain.updateAttributes("paragraph", { styleName, textAlign, lineSpacing, indent, firstLine, list }).run();
      setPainter(null);
    }, 0);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPainter(null); };
    dom.addEventListener("mouseup", applyPaint);
    window.addEventListener("keydown", onKey);
    return () => {
      dom.classList.remove("ss-painting");
      dom.removeEventListener("mouseup", applyPaint);
      window.removeEventListener("keydown", onKey);
    };
  }, [editor, painter]);

  const togglePainter = () => {
    if (!editor) return;
    if (painter) { setPainter(null); return; }
    const { state } = editor;
    const marks = (state.storedMarks ?? state.selection.$from.marks()).map((m) => ({ type: m.type.name, attrs: { ...m.attrs } }));
    setPainter({ marks, para: { ...editor.getAttributes("paragraph") } });
  };
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const ts = e.getAttributes("textStyle");
      const para = e.getAttributes("paragraph");
      const style = (para.styleName as NamedStyle) ?? "normal";
      return {
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        underline: e.isActive("underline"),
        strike: e.isActive("strike"),
        font: (ts.fontFamily as string) ?? DEFAULT_FONT,
        size: (ts.fontSize as number) ?? NAMED_STYLES[style]?.size ?? 11,
        style,
        align: ((para.textAlign as string) ?? "left") as keyof typeof ALIGN_ICONS,
        spacing: (para.lineSpacing as number) ?? 115,
        firstLine: !!para.firstLine,
        indent: (para.indent as number) ?? 0,
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        color: (ts.color as string | undefined) ?? null,
        highlight: (e.getAttributes("highlight").color as string | undefined) ?? (e.isActive("highlight") ? "#ffff00" : null),
        link: e.isActive("link"),
        list: (para.list as string | null) ?? null,
      };
    },
  });

  const [sizeDraft, setSizeDraft] = useState<string | null>(null);
  const run = (fn: (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => {
    if (!editor) return;
    fn(editor.chain().focus()).run();
  };
  const applySize = (pt: number) => {
    if (!Number.isFinite(pt) || pt <= 0) return;
    run((c) => c.setSize(Math.min(400, pt)));
  };
  const stepSize = (dir: 1 | -1) => {
    if (!s) return;
    const cur = s.size;
    const next = dir > 0 ? FONT_SIZES.find((x) => x > cur) ?? cur + 1 : [...FONT_SIZES].reverse().find((x) => x < cur) ?? Math.max(1, cur - 1);
    applySize(next);
  };

  const keep = (e: React.MouseEvent) => e.preventDefault(); // keep the editor selection
  const alignIcon = ALIGN_ICONS[s?.align ?? "left"] ?? ALIGN_ICONS.left;
  const off = disabled || !s;

  return (
    <div className="ss-toolbar" role="toolbar" aria-label="Formatting" aria-disabled={off ? "true" : undefined}>
      <button className="ss-icon-btn" onMouseDown={keep} onClick={() => run((c) => c.undo())} disabled={!s?.canUndo} title={`Undo (${mod}Z)`} aria-label="Undo">
        <Icon name="undo" />
      </button>
      <button className="ss-icon-btn" onMouseDown={keep} onClick={() => run((c) => c.redo())} disabled={!s?.canRedo} title={`Redo (${mod}Y)`} aria-label="Redo">
        <Icon name="redo" />
      </button>
      <button className="ss-icon-btn" onMouseDown={keep} onClick={() => window.print()} title={`Print (${mod}P)`} aria-label="Print">
        <Icon name="print" />
      </button>
      <button className="ss-icon-btn" data-on={spellcheck} onMouseDown={keep} onClick={() => setSpellcheck((v) => !v)} title="Spelling check" aria-label="Spelling check" aria-pressed={spellcheck}>
        <Icon name="spellcheck" />
      </button>
      <button className="ss-icon-btn" data-armed={!!painter} onMouseDown={keep} onClick={togglePainter} title="Paint format" aria-label="Paint format" aria-pressed={!!painter}>
        <Icon name="format_paint" />
      </button>

      <span className="ss-sep" />

      <Menu label="Zoom" trigger={<button className="ss-select-btn" title="Zoom">{zoom === "fit" ? "Fit" : `${zoom}%`}<Icon name="arrow_drop_down" /></button>}>
        <MenuItem checkable checked={zoom === "fit"} onSelect={() => onZoom("fit")}>Fit</MenuItem>
        {ZOOMS.map((z) => (
          <MenuItem key={z} checkable checked={z === zoom} onSelect={() => onZoom(z)}>{z}%</MenuItem>
        ))}
      </Menu>

      <span className="ss-sep" />

      <Menu keepFocus label="Styles" trigger={
        <button className="ss-select-btn min-w-[112px] justify-between pr-0.5" title="Styles">
          {NAMED_STYLES[s?.style ?? "normal"].label}<Icon name="arrow_drop_down" />
        </button>
      }>
        {NAMED_STYLE_ORDER.map((st) => (
          <MenuItem
            key={st}
            checkable
            checked={s?.style === st}
            onSelect={() => run((c) => c.setNamedStyle(st))}
            shortcut={st === "normal" ? `${mod}Alt+0` : st.startsWith("h") ? `${mod}Alt+${st.slice(1)}` : undefined}
            style={{ fontSize: `${Math.min(20, NAMED_STYLES[st].size * 1.1)}px`, color: st === "subtitle" ? "#666" : undefined, minHeight: st === "normal" ? 32 : 40 }}
          >
            {NAMED_STYLES[st].label}
          </MenuItem>
        ))}
      </Menu>

      <span className="ss-sep" />

      <Menu keepFocus label="Font" trigger={
        <button className="ss-select-btn min-w-[120px] justify-between pr-0.5" title="Font">
          <span className="max-w-[110px] truncate">{s?.font ?? DEFAULT_FONT}</span><Icon name="arrow_drop_down" />
        </button>
      }>
        {FONT_FAMILIES.map((f) => (
          <MenuItem key={f} checkable checked={s?.font === f} onSelect={() => run((c) => c.setFont(f))} style={{ fontFamily: fontStack(f) }}>
            {f}
          </MenuItem>
        ))}
      </Menu>

      <span className="ss-sep" />

      <button className="ss-icon-btn" onMouseDown={keep} onClick={() => stepSize(-1)} title="Decrease font size" aria-label="Decrease font size">
        <Icon name="remove" />
      </button>
      <Menu keepFocus label="Font size" trigger={
        <input
          className="ss-size-input"
          aria-label="Font size"
          inputMode="decimal"
          value={sizeDraft ?? String(s?.size ?? 11)}
          onFocus={(e) => { setSizeDraft(String(s?.size ?? 11)); e.currentTarget.select(); }}
          onChange={(e) => setSizeDraft(e.target.value.replace(/[^\d.]/g, "").slice(0, 5))}
          onBlur={() => setSizeDraft(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applySize(parseFloat(sizeDraft ?? ""));
              setSizeDraft(null);
            } else if (e.key === "Escape") {
              setSizeDraft(null);
              editor?.commands.focus();
            }
          }}
        />
      }>
        {FONT_SIZES.map((sz) => (
          <MenuItem key={sz} onSelect={() => applySize(sz)}>{sz}</MenuItem>
        ))}
      </Menu>
      <button className="ss-icon-btn" onMouseDown={keep} onClick={() => stepSize(1)} title="Increase font size" aria-label="Increase font size">
        <Icon name="add" />
      </button>

      <span className="ss-sep" />

      <button className="ss-icon-btn" data-on={s?.bold} onMouseDown={keep} onClick={() => run((c) => c.toggleBold())} title={`Bold (${mod}B)`} aria-label="Bold" aria-pressed={!!s?.bold}>
        <Icon name="format_bold" />
      </button>
      <button className="ss-icon-btn" data-on={s?.italic} onMouseDown={keep} onClick={() => run((c) => c.toggleItalic())} title={`Italic (${mod}I)`} aria-label="Italic" aria-pressed={!!s?.italic}>
        <Icon name="format_italic" />
      </button>
      <button className="ss-icon-btn" data-on={s?.underline} onMouseDown={keep} onClick={() => run((c) => c.toggleUnderline())} title={`Underline (${mod}U)`} aria-label="Underline" aria-pressed={!!s?.underline}>
        <Icon name="format_underlined" />
      </button>
      <button className="ss-icon-btn" data-on={s?.strike} onMouseDown={keep} onClick={() => run((c) => c.toggleStrike())} title={`Strikethrough (${mod}Shift+S)`} aria-label="Strikethrough" aria-pressed={!!s?.strike}>
        <Icon name="format_strikethrough" />
      </button>
      <ColorMenu editor={editor} kind="text" current={s?.color ?? null} />
      <ColorMenu editor={editor} kind="highlight" current={s?.highlight ?? null} />

      <span className="ss-sep" />

      <LinkPopover editor={editor} active={!!s?.link} disabled={off} />
      <ImageMenu onUpload={onInsertImages} onUrl={onInsertImageUrl} disabled={off} />

      <span className="ss-sep" />

      <Menu keepFocus label="Align" trigger={
        <button className="ss-select-btn" title="Align">
          <Icon name={alignIcon} className="text-[var(--ss-text-2)]" /><Icon name="arrow_drop_down" />
        </button>
      }>
        {(Object.keys(ALIGN_ICONS) as (keyof typeof ALIGN_ICONS)[]).map((a) => {
          return (
            <MenuItem key={a} checkable checked={s?.align === a} icon={<Icon name={ALIGN_ICONS[a]} />} shortcut={`${mod}Shift+${ALIGN_KEYS[a]}`} onSelect={() => run((c) => c.setTextAlign(a))}>
              {ALIGN_LABELS[a]}
            </MenuItem>
          );
        })}
      </Menu>

      <Menu keepFocus label="Line and paragraph spacing" trigger={
        <button className="ss-select-btn" title="Line & paragraph spacing">
          <Icon name="format_line_spacing" className="text-[var(--ss-text-2)]" /><Icon name="arrow_drop_down" />
        </button>
      }>
        {LINE_SPACINGS.map((ls) => (
          <MenuItem key={ls.value} checkable checked={s?.spacing === ls.value} onSelect={() => run((c) => c.setLineSpacing(ls.value))}>
            {ls.label}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem checkable checked={s?.firstLine} shortcut="Tab" onSelect={() => run((c) => c.setFirstLine(!s?.firstLine))}>
          Indent first line
        </MenuItem>
      </Menu>

      <button className="ss-icon-btn" data-on={s?.list === "check"} onMouseDown={keep} onClick={() => run((c) => c.toggleList("check"))} title={`Checklist (${mod}Shift+9)`} aria-label="Checklist" aria-pressed={s?.list === "check"}>
        <Icon name="checklist" />
      </button>
      <button className="ss-icon-btn" data-on={s?.list === "bullet"} onMouseDown={keep} onClick={() => run((c) => c.toggleList("bullet"))} title={`Bulleted list (${mod}Shift+8)`} aria-label="Bulleted list" aria-pressed={s?.list === "bullet"}>
        <Icon name="format_list_bulleted" />
      </button>
      <button className="ss-icon-btn" data-on={s?.list === "ordered"} onMouseDown={keep} onClick={() => run((c) => c.toggleList("ordered"))} title={`Numbered list (${mod}Shift+7)`} aria-label="Numbered list" aria-pressed={s?.list === "ordered"}>
        <Icon name="format_list_numbered" />
      </button>

      <span className="ss-sep" />

      <button className="ss-icon-btn" onMouseDown={keep} onClick={() => run((c) => c.outdent())} disabled={(s?.indent ?? 0) === 0} title={`Decrease indent (${mod}[)`} aria-label="Decrease indent">
        <Icon name="format_indent_decrease" />
      </button>
      <button className="ss-icon-btn" onMouseDown={keep} onClick={() => run((c) => c.indent())} disabled={(s?.indent ?? 0) >= MAX_INDENT} title={`Increase indent (${mod}])`} aria-label="Increase indent">
        <Icon name="format_indent_increase" />
      </button>
      <button className="ss-icon-btn" onMouseDown={keep} onClick={() => run((c) => c.clearFormatting())} title={`Clear formatting (${mod}\\)`} aria-label="Clear formatting">
        <Icon name="format_clear" />
      </button>

    </div>
  );
}
