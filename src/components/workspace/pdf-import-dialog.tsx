"use client";

/** File > Import PDF and the Sync settings card: choose a PDF, see what was read, choose where it goes */

import React, { useEffect, useRef, useState } from "react";
import { Check, FilePlus2, FileText, FileUp, ListEnd, LoaderCircle, Replace, TriangleAlert } from "lucide-react";
import { Dialog } from "./dialog";
import { fileSize, pageLabel, pdfTitle, READ_STEPS, summaryLine, type Destination, type PdfFile, type PdfImport } from "./use-pdf-import";

const CHOICES: { value: Destination; title: string; icon: React.ReactNode; body: (name: string) => string }[] = [
  { value: "new", title: "New Google Doc for this PDF", icon: <FilePlus2 className="h-5 w-5" />, body: (name) => `A new doc named “${name}”, with the PDF's page size and margins. This one stays as it is.` },
  { value: "append", title: "Add after what's here", icon: <ListEnd className="h-5 w-5" />, body: () => "The PDF goes after the last line, as new text. This doc's page size and margins stay as they are." },
  { value: "replace", title: "Replace what's here", icon: <Replace className="h-5 w-5" />, body: () => "Deletes this doc's content, then the sync types the PDF in. Takes the PDF's page size and margins." },
];

const PRIMARY: Record<Destination, string> = { new: "Create and import", append: "Add it", replace: "Replace…" };

export function PdfImportDialog({ pdf }: { pdf: PdfImport }) {
  const { open, stage, pick } = pdf;
  const confirming = stage.kind === "result" && stage.confirming;
  const focusRef = useRef<HTMLElement | null>(null);
  const setFocus = (el: HTMLElement | null) => { focusRef.current = el; };

  // Each step takes focus to what it's about: Cancel while reading, the choice made, Back before replacing
  const focusKey = `${open}:${stage.kind}:${confirming}`;
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => focusRef.current?.focus({ preventScroll: true }), 0);
    return () => clearTimeout(id);
  }, [focusKey, open]);

  // A PDF dropped anywhere while the dialog waits for one is taken; the browser never opens it instead
  const picking = open && stage.kind === "pick";
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!picking) { setOver(false); return; }
    const files = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onOver = (e: DragEvent) => { if (files(e)) e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      setOver(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) void pick(file);
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => { window.removeEventListener("dragover", onOver); window.removeEventListener("drop", onDrop); };
  }, [picking, pick]);

  let body: React.ReactNode = null;
  let footer: React.ReactNode;
  const cancel = <button type="button" className="ss-btn ss-btn-text" onClick={pdf.close}>Cancel</button>;

  if (stage.kind === "pick") {
    body = (
      <>
        <label className="ss-pdf-drop" data-over={over || undefined} onDragEnter={() => setOver(true)} onDragOver={() => setOver(true)} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}>
          <input
            ref={setFocus}
            type="file"
            accept="application/pdf,.pdf"
            className="ss-pdf-file-input"
            aria-describedby="ss-pdf-drop-sub"
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void pdf.pick(file); }}
          />
          <span className="ss-pdf-drop-icon" aria-hidden="true"><FileUp className="h-6 w-6" /></span>
          <span className="ss-pdf-drop-title">Drop a PDF here or <span className="ss-pdf-choose">choose a file</span></span>
          <span className="ss-pdf-drop-sub" id="ss-pdf-drop-sub">PDF, up to 4 MB</span>
        </label>
        {stage.error ? <Problem text={stage.error} /> : <p className="ss-pdf-note">SyncStream rebuilds its text, fonts, lists, tables and images on the page. Nothing is typed into your Google Doc until you start the sync.</p>}
      </>
    );
    footer = <><span className="flex-1" />{cancel}</>;
  } else if (stage.kind === "reading") {
    body = (
      <>
        <FileRow file={stage.file} />
        <ol className="ss-pdf-steps" aria-label="Reading the PDF">
          {READ_STEPS.map((label, i) => {
            const state = i < stage.step ? "done" : i === stage.step ? "now" : "next";
            return (
              <li key={label} data-state={state} aria-current={state === "now" ? "step" : undefined}>
                <span className="ss-pdf-step-dot" aria-hidden="true">
                  {state === "done" ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : state === "now" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                </span>
                <span>{label}</span>
                {i === 0 && state === "now" && stage.sent > 0 && stage.sent < 1 && <span className="ss-pdf-step-pct">{Math.round(stage.sent * 100)}%</span>}
              </li>
            );
          })}
        </ol>
        <p className="sr-only" role="status">{READ_STEPS[stage.step]}</p>
      </>
    );
    footer = <><span className="flex-1" /><button ref={setFocus} type="button" className="ss-btn ss-btn-text" onClick={pdf.cancelReading}>Cancel</button></>;
  } else if (stage.kind === "result") {
    const r = stage.result;
    const name = pdfTitle(stage.file.name);
    const extras = [r.header && "header", r.footer && "footer"].filter(Boolean).join(" and ");
    // (a document with a header or footer of its own keeps it)
    const added = [r.header && !pdf.docHas.header && "header", r.footer && !pdf.docHas.footer && "footer"].filter(Boolean).join(" and ");
    body = (
      <>
        <FileRow file={stage.file} />
        <div className="ss-pdf-summary">
          <p className="ss-pdf-summary-line">{summaryLine(r)}</p>
          <dl className="ss-pdf-facts">
            {r.fonts.length > 0 && <div><dt>Fonts</dt><dd>{r.fonts.join(", ")}</dd></div>}
            <div><dt>Page</dt><dd>{pageLabel(r.pageSetup)}</dd></div>
            {extras && <div><dt>Also</dt><dd>{extras[0].toUpperCase() + extras.slice(1)} on every page</dd></div>}
          </dl>
        </div>
        {r.warnings.length > 0 && (
          <div className="ss-pdf-warn" role="note">
            <TriangleAlert className="ss-pdf-warn-icon h-[18px] w-[18px]" aria-hidden="true" />
            <div className="min-w-0">
              <p className="ss-pdf-warn-title">{r.warnings.length === 1 ? "One thing will look different" : "A few things will look different"}</p>
              <ul>{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          </div>
        )}
        {pdf.blank ? (
          <p className="ss-pdf-dest-note">This doc is empty, so the PDF goes straight onto the page, with its page size and margins{added ? ` and its ${added}` : ""}. You can edit it, add breaks, then start the sync.</p>
        ) : confirming ? (
          <p className="ss-pdf-confirm">This deletes everything in this document from Google Docs now. The PDF&apos;s content is then typed in by the sync.</p>
        ) : (
          <fieldset className="ss-pdf-choices">
            <legend className="ss-field-label">Where should it go?</legend>
            <p className="ss-pdf-choices-help">This doc already has content.</p>
            <div className="ss-pdf-choice-list">
              {CHOICES.map((c) => (
                <label key={c.value} className="ss-pdf-choice" data-on={stage.choice === c.value || undefined} data-danger={c.value === "replace" || undefined}>
                  <input ref={stage.choice === c.value ? setFocus : undefined} type="radio" name="ss-pdf-dest" value={c.value} checked={stage.choice === c.value} onChange={() => pdf.choose(c.value)} />
                  <span className="ss-pdf-choice-icon" aria-hidden="true">{c.icon}</span>
                  <span className="ss-pdf-choice-text">
                    <span className="ss-pdf-choice-title">{c.title}{c.value === "new" && <span className="ss-pdf-badge">Recommended</span>}</span>
                    <span className="ss-pdf-choice-body">{c.body(name)}</span>
                  </span>
                  <span className="ss-pdf-choice-dot" aria-hidden="true" />
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {stage.error && <Problem text={stage.error} />}
      </>
    );
    footer = pdf.blank ? (
      <><span className="flex-1" />{cancel}<button ref={setFocus} type="submit" className="ss-btn ss-btn-filled">Put it on the page</button></>
    ) : confirming ? (
      <><button ref={setFocus} type="button" className="ss-btn ss-btn-text" onClick={() => pdf.confirmReplace(false)}>Back</button><span className="flex-1" /><button type="submit" className="ss-btn ss-pdf-btn-danger">Replace</button></>
    ) : (
      <><span className="flex-1" />{cancel}<button type="submit" className={`ss-btn ${stage.choice === "replace" ? "ss-pdf-btn-danger-quiet" : "ss-btn-filled"}`}>{PRIMARY[stage.choice]}</button></>
    );
  } else {
    body = (
      <>
        <FileRow file={stage.file} />
        <div ref={setFocus} tabIndex={-1} className="ss-pdf-applying" role="status">
          <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
          <span>{stage.text}</span>
        </div>
      </>
    );
    footer = stage.cancelable ? <><span className="flex-1" />{cancel}</> : <span className="h-10" />;
  }

  return (
    <Dialog open={open} title={confirming ? "Replace what's here?" : "Import PDF"} onClose={pdf.close} onSubmit={stage.kind === "result" ? pdf.apply : undefined} width={stage.kind === "result" ? 520 : 480} footer={footer}>
      <div className="ss-pdf" data-stage={stage.kind}>{body}</div>
    </Dialog>
  );
}

function FileRow({ file }: { file: PdfFile }) {
  return (
    <div className="ss-pdf-file">
      <span className="ss-pdf-file-icon" aria-hidden="true"><FileText className="h-[18px] w-[18px]" /></span>
      <span className="ss-pdf-file-name" title={file.name}>{file.name}</span>
      <span className="ss-pdf-file-size">{fileSize(file.size)}</span>
    </div>
  );
}

function Problem({ text }: { text: string }) {
  return (
    <p role="alert" className="ss-pdf-problem">
      <TriangleAlert className="h-[18px] w-[18px] flex-none" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}
