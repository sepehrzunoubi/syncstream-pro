import React from "react";

/**
 * The Material Symbols icons the page loads: the dashboard layout asks Google Fonts for exactly these
 * (in this order, which its icon_names wants sorted), so an icon not listed here would show its name's
 * letters. Icon takes only these names, so the type check catches one that isn't.
 */
export const ICON_NAMES = [
  "add",
  "arrow_back",
  "arrow_drop_down",
  "article",
  "border_bottom",
  "border_horizontal",
  "border_left",
  "border_right",
  "border_top",
  "check",
  "checklist",
  "chevron_right",
  "close",
  "cloud_done",
  "cloud_off",
  "cloud_sync",
  "description",
  "format_align_center",
  "format_align_justify",
  "format_align_left",
  "format_align_right",
  "format_bold",
  "format_clear",
  "format_color_reset",
  "format_indent_decrease",
  "format_indent_increase",
  "format_italic",
  "format_line_spacing",
  "format_list_bulleted",
  "format_list_numbered",
  "format_paint",
  "format_strikethrough",
  "format_underlined",
  "image",
  "ink_highlighter",
  "keyboard_arrow_down",
  "keyboard_arrow_up",
  "link",
  "lock",
  "more_vert",
  "note_add",
  "notes",
  "open_in_new",
  "play_arrow",
  "print",
  "redo",
  "refresh",
  "remove",
  "spellcheck",
  "sync",
  "undo",
  "upload",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

export const ICONS_URL = `https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,400,0,0&icon_names=${ICON_NAMES.join(",")}&display=block`;

/** A Material Symbols icon, one of those the page loads (ICON_NAMES) */
export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <span className={`ss-icon ${className ?? ""}`} style={{ fontSize: size }} aria-hidden="true">
      {name}
    </span>
  );
}
