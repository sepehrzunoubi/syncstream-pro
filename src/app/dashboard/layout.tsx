import "./docs.css";

/** Google Sans for the interface, plus the editor fonts (and metric-compatible stand-ins for Office fonts). */
const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500&family=Arimo:ital,wght@0,400;0,700;1,400;1,700&family=Tinos:ital,wght@0,400;0,700;1,400;1,700&family=Carlito:ital,wght@0,400;0,700;1,400;1,700&family=Caladea:ital,wght@0,400;0,700;1,400;1,700&family=Cousine:ital,wght@0,400;0,700;1,400;1,700&family=Comic+Neue:ital,wght@0,400;0,700;1,400;1,700&family=EB+Garamond:ital,wght@0,400;0,700;1,400;1,700&family=Gelasio:ital,wght@0,400;0,700;1,400;1,700&family=Lato:ital,wght@0,400;0,700;1,400;1,700&family=Lexend:wght@400;700&family=Lora:ital,wght@0,400;0,700;1,400;1,700&family=Merriweather:ital,wght@0,400;0,700;1,400;1,700&family=Montserrat:ital,wght@0,400;0,700;1,400;1,700&family=Nunito:ital,wght@0,400;0,700;1,400;1,700&family=Open+Sans:ital,wght@0,400;0,700;1,400;1,700&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&family=Roboto:ital,wght@0,400;0,500;0,700;1,400;1,700&family=Roboto+Mono:ital,wght@0,400;0,700;1,400;1,700&family=Spectral:ital,wght@0,400;0,700;1,400;1,700&display=swap";

/** Material Symbols, subset to the icons the toolbar and header use (names must stay sorted) */
const ICONS_URL =
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,400,0,0&icon_names=add,arrow_drop_down,check,close,format_align_center,format_align_justify,format_align_left,format_align_right,format_bold,format_clear,format_indent_decrease,format_indent_increase,format_italic,format_line_spacing,format_strikethrough,format_underlined,menu,open_in_new,play_arrow,redo,remove,shuffle,undo&display=block";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href={FONTS_URL} />
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href={ICONS_URL} />
      {children}
    </>
  );
}
