"use client";

import React, { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Dialog, ColorSelect } from "./dialog";
import { Icon } from "./icon";
import { BORDER_SIDES, BORDER_WIDTHS, type Border, type BorderSide, type Borders } from "@/lib/rich-text";

const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : NaN; };

/** Format > Line & paragraph spacing > Custom spacing */
export function CustomSpacingDialog({ editor, open, onClose }: { editor: Editor | null; open: boolean; onClose: () => void }) {
  const [line, setLine] = useState("1.15");
  const [before, setBefore] = useState("0");
  const [after, setAfter] = useState("0");
  useEffect(() => {
    if (!open || !editor) return;
    const a = editor.getAttributes("paragraph");
    const box = a.box as { above?: number | null; below?: number | null } | null;
    setLine(String(((a.lineSpacing as number) ?? 115) / 100));
    setBefore(String(box?.above ?? 0));
    setAfter(String(box?.below ?? 0));
  }, [open, editor]);
  const ok = num(line) >= 0.5 && num(line) <= 5 && num(before) >= 0 && num(after) >= 0;
  const apply = () => {
    if (!editor || !ok) return;
    editor.chain().focus().setLineSpacing(Math.round(num(line) * 100)).setParagraphSpace({ above: num(before), below: num(after) }).run();
    onClose();
  };
  return (
    <Dialog open={open} title="Custom spacing" onClose={onClose} onSubmit={apply} width={360} footer={
      <>
        <span className="flex-1" />
        <button type="button" className="ss-btn ss-btn-text" onClick={onClose}>Cancel</button>
        <button type="submit" className="ss-btn ss-btn-filled" disabled={!ok}>Apply</button>
      </>
    }>
      <div className="flex flex-col gap-5">
        <label className="block">
          <span className="ss-field-label">Line spacing</span>
          <input className="ss-input" inputMode="decimal" value={line} onChange={(e) => setLine(e.target.value)} aria-label="Line spacing" style={{ width: 120 }} />
        </label>
        <fieldset>
          <legend className="ss-field-label">Paragraph spacing (pts)</legend>
          <div className="flex gap-4">
            <label className="block"><span className="ss-field-sub">Before</span><input className="ss-input" inputMode="decimal" value={before} onChange={(e) => setBefore(e.target.value)} aria-label="Space before paragraph" style={{ width: 120 }} /></label>
            <label className="block"><span className="ss-field-sub">After</span><input className="ss-input" inputMode="decimal" value={after} onChange={(e) => setAfter(e.target.value)} aria-label="Space after paragraph" style={{ width: 120 }} /></label>
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}

const SIDE_ICONS: Record<BorderSide, string> = { top: "border_top", bottom: "border_bottom", left: "border_left", right: "border_right", between: "border_horizontal" };
const SIDE_LABELS: Record<BorderSide, string> = { top: "Top border", bottom: "Bottom border", left: "Left border", right: "Right border", between: "Between paragraphs" };

/** Format > Paragraph styles > Borders and shading */
export function BordersDialog({ editor, open, onClose }: { editor: Editor | null; open: boolean; onClose: () => void }) {
  const [sides, setSides] = useState<Record<BorderSide, boolean>>({ top: false, bottom: false, left: false, right: false, between: false });
  const [width, setWidth] = useState(1);
  const [dash, setDash] = useState<Border["dash"]>("SOLID");
  const [color, setColor] = useState("#000000");
  const [shading, setShading] = useState<string | null>(null);
  const [padding, setPadding] = useState("0");
  useEffect(() => {
    if (!open || !editor) return;
    const a = editor.getAttributes("paragraph");
    const b = (a.borders as Borders | null) ?? {};
    const any = BORDER_SIDES.map((s) => b[s]).find(Boolean);
    setSides({ top: !!b.top, bottom: !!b.bottom, left: !!b.left, right: !!b.right, between: !!b.between });
    setWidth(any?.width ?? 1);
    setDash(any?.dash ?? "SOLID");
    setColor(any?.color ?? "#000000");
    setPadding(String(any?.padding ?? 0));
    setShading((a.shading as string | null) ?? null);
  }, [open, editor]);
  const apply = () => {
    if (!editor) return;
    const border: Border = { width, color, dash, padding: Math.max(0, num(padding) || 0) };
    const out: Borders = {};
    for (const s of BORDER_SIDES) if (sides[s] && width > 0) out[s] = border;
    editor.chain().focus().setBorders(Object.keys(out).length ? out : null, shading).run();
    onClose();
  };
  const reset = () => {
    setSides({ top: false, bottom: false, left: false, right: false, between: false });
    setWidth(1); setDash("SOLID"); setColor("#000000"); setShading(null); setPadding("0");
  };
  return (
    <Dialog open={open} title="Borders and shading" onClose={onClose} onSubmit={apply} footer={
      <>
        <button type="button" className="ss-btn ss-btn-text ss-btn-quiet" onClick={reset}>Reset</button>
        <span className="flex-1" />
        <button type="button" className="ss-btn ss-btn-text" onClick={onClose}>Cancel</button>
        <button type="submit" className="ss-btn ss-btn-filled">Apply</button>
      </>
    }>
      <div className="flex flex-col gap-5">
        <div>
          <span className="ss-field-label">Position</span>
          <div className="flex gap-1">
            {BORDER_SIDES.map((s) => (
              <button key={s} type="button" className="ss-icon-btn" data-on={sides[s]} aria-pressed={sides[s]} title={SIDE_LABELS[s]} aria-label={SIDE_LABELS[s]} onClick={() => setSides({ ...sides, [s]: !sides[s] })}>
                <Icon name={SIDE_ICONS[s]} />
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="ss-field-label">Border width</span>
            <select className="ss-select" value={String(width)} onChange={(e) => setWidth(parseFloat(e.target.value))}>
              {BORDER_WIDTHS.map((w) => <option key={w} value={String(w)}>{w} pt</option>)}
            </select>
          </label>
          <label className="block">
            <span className="ss-field-label">Border dash</span>
            <select className="ss-select" value={dash} onChange={(e) => setDash(e.target.value as Border["dash"])}>
              <option value="SOLID">Solid</option>
              <option value="DOT">Dotted</option>
              <option value="DASH">Dashed</option>
            </select>
          </label>
          <div className="block">
            <span className="ss-field-label">Border color</span>
            <ColorSelect value={color} onChange={(c) => setColor(c ?? "#000000")} label="Border color" />
          </div>
          <div className="block">
            <span className="ss-field-label">Background color</span>
            <ColorSelect value={shading} onChange={setShading} label="Background color" none />
          </div>
          <label className="block">
            <span className="ss-field-label">Paragraph padding</span>
            <input className="ss-input" inputMode="decimal" value={padding} onChange={(e) => setPadding(e.target.value)} aria-label="Paragraph padding in points" />
          </label>
        </div>
      </div>
    </Dialog>
  );
}
