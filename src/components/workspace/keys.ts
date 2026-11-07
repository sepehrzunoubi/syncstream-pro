/**
 * Esc on the page: a mode the page is in (placing breaks, paint format) ends with Esc, unless that Esc
 * is someone else's: a menu, dialog or popover closing, or a text field taking it (the find bar, a
 * rename). Read in the capture phase, before any of them has handled it.
 */

/** Places whose Esc is their own */
const LAYERS = "[role='menu'], [role='menubar'], [role='dialog'], [role='listbox'], [role='search']";
/** Open menus and popovers that don't take focus (the right-click menu): Esc closes them first */
const OPEN_LAYERS = "[role='menu'], [role='dialog'], [role='listbox']";

/** Whether this keydown is an Esc that is free to end the page's mode. `own`: fields whose Esc it is */
export function escapeIsFree(e: KeyboardEvent, own: string[] = []): boolean {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return false;
  const t = e.target instanceof Element ? e.target : null;
  if (t && own.some((sel) => t.matches(sel))) return true;
  if (t?.closest(LAYERS)) return false;
  if (t?.matches("input, textarea, select")) return false;
  if (typeof document !== "undefined" && document.querySelector(OPEN_LAYERS)) return false;
  return true;
}

/** A keydown in a field the user types into, where a page-wide shortcut mustn't take the keys */
export function inTextField(e: KeyboardEvent): boolean {
  const t = e.target instanceof Element ? e.target : null;
  return !!t?.matches("input, textarea, select");
}
