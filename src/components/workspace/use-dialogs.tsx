"use client";

/** Which of the workspace's dialogs is open, and the dialogs themselves */

import React, { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { PageSetup } from "@/lib/page-setup";
import { PageSetupDialog } from "./page-setup-dialog";
import { BordersDialog, ColumnsDialog, CustomSpacingDialog } from "./format-dialogs";
import { ShortcutsDialog } from "./context-menu";

export function useDialogs() {
  const [pageSetupOpen, setPageSetupOpen] = useState(false);
  const [spacingOpen, setSpacingOpen] = useState(false);
  const [bordersOpen, setBordersOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(true);
  useEffect(() => {
    const open = () => setShortcutsOpen(true);
    window.addEventListener("ss-shortcuts", open);
    return () => window.removeEventListener("ss-shortcuts", open);
  }, []);
  return { pageSetupOpen, setPageSetupOpen, spacingOpen, setSpacingOpen, bordersOpen, setBordersOpen, columnsOpen, setColumnsOpen, shortcutsOpen, setShortcutsOpen, outlineOpen, setOutlineOpen };
}

export type Dialogs = ReturnType<typeof useDialogs>;

export function WorkspaceDialogs({ editor, dialogs, pageSetup, pageless, onApplyPageSetup, onSetPageDefault, textWidth }: {
  editor: Editor | null;
  dialogs: Dialogs;
  pageSetup: PageSetup;
  pageless: boolean;
  onApplyPageSetup: (setup: PageSetup, pageless: boolean) => void;
  onSetPageDefault: (setup: PageSetup, pageless: boolean) => void;
  textWidth: number;
}) {
  return (
    <>
      <PageSetupDialog
        open={dialogs.pageSetupOpen}
        setup={pageSetup}
        pageless={pageless}
        onClose={() => dialogs.setPageSetupOpen(false)}
        onApply={onApplyPageSetup}
        onSetDefault={onSetPageDefault}
      />
      <CustomSpacingDialog editor={editor} open={dialogs.spacingOpen} onClose={() => dialogs.setSpacingOpen(false)} />
      <BordersDialog editor={editor} open={dialogs.bordersOpen} onClose={() => dialogs.setBordersOpen(false)} />
      <ColumnsDialog editor={editor} open={dialogs.columnsOpen} onClose={() => dialogs.setColumnsOpen(false)} textWidth={textWidth} />
      <ShortcutsDialog open={dialogs.shortcutsOpen} onClose={() => dialogs.setShortcutsOpen(false)} />
    </>
  );
}
