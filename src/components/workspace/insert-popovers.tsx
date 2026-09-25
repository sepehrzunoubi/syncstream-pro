"use client";

import React, { useEffect, useRef, useState } from "react";
import * as PO from "@radix-ui/react-popover";
import type { Editor } from "@tiptap/react";
import { normalizeLink } from "@/lib/rich-text";
import { Icon } from "./icon";

/** Insert or edit a link, like Docs' link box. Opens from the toolbar or Ctrl+K. */
export function LinkPopover({ editor, disabled, active }: { editor: Editor | null; disabled?: boolean; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [href, setHref] = useState("");
  const [needsText, setNeedsText] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hrefRef = useRef<HTMLInputElement>(null);

  const prepare = () => {
    if (!editor) return;
    const current = editor.getAttributes("link").href as string | undefined;
    const { empty } = editor.state.selection;
    setHref(current ?? "");
    setNeedsText(empty && !current);
    setText("");
    setError(null);
  };

  useEffect(() => {
    const onOpen = () => { if (!disabled) { prepare(); setOpen(true); } };
    window.addEventListener("ss-open-link", onOpen);
    return () => window.removeEventListener("ss-open-link", onOpen);
  });

  const apply = () => {
    if (!editor) return;
    const url = normalizeLink(href);
    if (!url) { setError("Enter a web address (https://…) or an email link (mailto:…)"); return; }
    if (needsText) {
      const label = text.trim() || url;
      editor.chain().focus().insertContent({ type: "text", text: label, marks: [{ type: "link", attrs: { href: url } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
    setOpen(false);
  };
  const remove = () => {
    editor?.chain().focus().extendMarkRange("link").unsetLink().run();
    setOpen(false);
  };

  return (
    <PO.Root open={open} onOpenChange={(o) => { if (o) prepare(); setOpen(o); }}>
      <PO.Trigger asChild>
        <button className="ss-icon-btn" data-on={active} title="Insert link (Ctrl+K)" aria-label="Insert link" disabled={disabled} onMouseDown={(e) => e.preventDefault()}>
          <Icon name="link" />
        </button>
      </PO.Trigger>
      <PO.Portal>
        <PO.Content
          className="ss-popover"
          sideOffset={6}
          align="start"
          collisionPadding={8}
          onOpenAutoFocus={(e) => { e.preventDefault(); setTimeout(() => hrefRef.current?.focus(), 0); }}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <form onSubmit={(e) => { e.preventDefault(); apply(); }} className="flex flex-col gap-3">
            {needsText && (
              <label className="flex flex-col gap-1.5 text-[12px] text-[var(--ss-text-2)]">
                Text
                <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Text to show" />
              </label>
            )}
            <label className="flex flex-col gap-1.5 text-[12px] text-[var(--ss-text-2)]">
              Link
              <input ref={hrefRef} value={href} onChange={(e) => { setHref(e.target.value); setError(null); }} placeholder="Paste a link" inputMode="url" />
            </label>
            {error && <p className="text-[12px] text-[#b3261e]">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              {active && <button type="button" className="ss-btn ss-btn-text mr-auto" onClick={remove}>Remove link</button>}
              <button type="submit" className="ss-btn ss-btn-filled h-9 px-5">Apply</button>
            </div>
          </form>
        </PO.Content>
      </PO.Portal>
    </PO.Root>
  );
}

/** Insert an image from the computer or from a web address. */
export function ImageMenu({ onUpload, onUrl, disabled }: { onUpload: (files: File[]) => void; onUrl: (url: string) => void; disabled?: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"choose" | "url">("choose");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onUploadEvt = () => fileRef.current?.click();
    const onUrlEvt = () => { setMode("url"); setUrl(""); setError(null); setOpen(true); };
    window.addEventListener("ss-image-upload", onUploadEvt);
    window.addEventListener("ss-image-url", onUrlEvt);
    return () => {
      window.removeEventListener("ss-image-upload", onUploadEvt);
      window.removeEventListener("ss-image-url", onUrlEvt);
    };
  }, []);

  const submitUrl = () => {
    const u = url.trim();
    if (!/^https?:\/\/\S+$/i.test(u)) { setError("Paste a link to a PNG, JPEG or GIF image"); return; }
    onUrl(u);
    setOpen(false);
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onUpload(files);
        }}
      />
      <PO.Root open={open} onOpenChange={(o) => { setOpen(o); if (o) { setMode("choose"); setUrl(""); setError(null); } }}>
        <PO.Trigger asChild>
          <button className="ss-icon-btn" title="Insert image" aria-label="Insert image" disabled={disabled} onMouseDown={(e) => e.preventDefault()}>
            <Icon name="image" />
          </button>
        </PO.Trigger>
        <PO.Portal>
          <PO.Content className={mode === "choose" ? "ss-menu" : "ss-popover"} sideOffset={6} align="start" collisionPadding={8} onCloseAutoFocus={(e) => e.preventDefault()}>
            {mode === "choose" ? (
              <div role="menu">
                <button role="menuitem" className="ss-menu-item w-full" onClick={() => { setOpen(false); fileRef.current?.click(); }}>
                  <span className="ss-check"><Icon name="upload" size={18} /></span>Upload from computer
                </button>
                <button role="menuitem" className="ss-menu-item w-full" onClick={() => setMode("url")}>
                  <span className="ss-check"><Icon name="link" size={18} /></span>By URL
                </button>
              </div>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); submitUrl(); }} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5 text-[12px] text-[var(--ss-text-2)]">
                  Image address
                  <input autoFocus value={url} onChange={(e) => { setUrl(e.target.value); setError(null); }} placeholder="https://…" inputMode="url" />
                </label>
                <p className="text-[12px] leading-4 text-[var(--ss-text-3)]">Google fetches the image from this address when it types it, so it has to be public.</p>
                {error && <p className="text-[12px] text-[#b3261e]">{error}</p>}
                <div className="flex justify-end">
                  <button type="submit" className="ss-btn ss-btn-filled h-9 px-5">Insert image</button>
                </div>
              </form>
            )}
          </PO.Content>
        </PO.Portal>
      </PO.Root>
    </>
  );
}
