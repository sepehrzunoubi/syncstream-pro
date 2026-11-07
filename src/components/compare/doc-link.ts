/**
 * Reading a Google Doc out of what is pasted into a picker: a Docs or Drive link, or a bare id.
 */

/** Drive ids are long runs of letters, digits, - and _ (Docs' own are 44 characters) */
const ID = /^[A-Za-z0-9_-]{25,}$/;

/** The document id in a Google Docs or Drive link, or the id itself; null when it is neither */
export function parseDocRef(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (ID.test(s)) return s;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!/(^|\.)google\.com$/i.test(url.hostname)) return null;
  // docs.google.com/document/d/{id}/edit, …/document/u/1/d/{id}, drive.google.com/file/d/{id}
  const path = url.pathname.match(/\/(?:document|file)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/);
  if (path && ID.test(path[1])) return path[1];
  // drive.google.com/open?id={id}
  const q = url.searchParams.get("id");
  return q && ID.test(q) ? q : null;
}
