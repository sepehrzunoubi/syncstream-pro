import { google, type docs_v1 } from "googleapis";
import { indexedText } from "./doc-import";

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code ?? (err as { status?: number })?.status;
      const isRetryable = code === 429 || (typeof code === "number" && code >= 500);
      if (!isRetryable || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("withRetry: unreachable");
}

export function getOAuth2Client(redirectUri?: string) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error(
      "Missing required environment variables: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env.local"
    );
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri || process.env.GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl(redirectUri?: string) {
  const client = getOAuth2Client(redirectUri);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });
}

export async function getTokensFromCode(code: string, redirectUri?: string) {
  const client = getOAuth2Client(redirectUri);
  const { tokens } = await client.getToken(code);
  return tokens;
}

export async function listRecentDocs(accessToken: string, maxResults = 15) {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });

  const drive = google.drive({ version: "v3", auth: client });
  const res = await withRetry(() =>
    drive.files.list({
      q: "mimeType='application/vnd.google-apps.document'",
      orderBy: "modifiedTime desc",
      pageSize: maxResults,
      fields: "files(id, name, modifiedTime)",
    })
  );

  return (res.data.files || []).map((f) => ({
    id: f.id!,
    name: f.name!,
    modifiedTime: f.modifiedTime!,
  }));
}

export async function createGoogleDoc(
  accessToken: string,
  title: string = "Untitled Document"
): Promise<{ id: string; name: string }> {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });

  const docs = google.docs({ version: "v1", auth: client });
  const res = await withRetry(() =>
    docs.documents.create({
      requestBody: { title },
    })
  );

  return {
    id: res.data.documentId!,
    name: res.data.title || title,
  };
}

export interface DocSnapshot {
  /** Index just past the last character (insert at endIndex - 1 to append) */
  endIndex: number;
  /** Last characters of the document body, for idempotency checks */
  tail: string;
  wordCount: number;
  /** The body with position i holding the character at Docs index i (see indexedText) */
  chars: string;
  revisionId: string;
}

/** The whole document, as documents.get returns it */
export async function getDocument(accessToken: string, documentId: string): Promise<docs_v1.Schema$Document> {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const docs = google.docs({ version: "v1", auth: client });
  const doc = await withRetry(() => docs.documents.get({ documentId }));
  return doc.data;
}

/** One documents.get that yields everything the runner needs about the target doc. */
export async function getDocSnapshot(accessToken: string, documentId: string, tailChars = 400): Promise<DocSnapshot> {
  return snapshotOf(await getDocument(accessToken, documentId), tailChars);
}

export function snapshotOf(data: docs_v1.Schema$Document, tailChars = 400): DocSnapshot {
  const content = data.body?.content ?? [];
  const endIndex = content.slice(-1)[0]?.endIndex ?? 1;
  let text = "";
  for (const element of content) {
    for (const el of element.paragraph?.elements ?? []) {
      if (el.textRun?.content) text += el.textRun.content;
      // An inline image occupies one index, like the placeholder in our source text
      else if (el.inlineObjectElement) text += "\uFFFC";
    }
  }
  const chars = indexedText(data);
  const words = chars.replace(/[\u0000\uFFFC]/g, " ").trim();
  const wordCount = words ? words.split(/\s+/).length : 0;
  // Google Docs always ends the body with a trailing newline that is not user text.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return { endIndex, tail: body.slice(-tailChars), wordCount, chars, revisionId: data.revisionId ?? "" };
}

export async function deleteRange(
  accessToken: string,
  documentId: string,
  startIndex: number,
  endIndex: number
) {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const docs = google.docs({ version: "v1", auth: client });
  await withRetry(() =>
    docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            deleteContentRange: {
              range: { startIndex, endIndex },
            },
          },
        ],
      },
    })
  );
}

/** Apply Docs requests in one atomic batchUpdate */
export async function batchUpdate(accessToken: string, documentId: string, requests: object[]) {
  if (requests.length === 0) return;
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const docs = google.docs({ version: "v1", auth: client });
  await withRetry(() => docs.documents.batchUpdate({ documentId, requestBody: { requests } }));
}

export async function insertAtIndex(
  accessToken: string,
  documentId: string,
  text: string,
  index: number,
  /** Formatting requests applied atomically with the insert */
  extraRequests: object[] = []
) {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const docs = google.docs({ version: "v1", auth: client });
  await withRetry(() =>
    docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{ insertText: { location: { index }, text } }, ...extraRequests],
      },
    })
  );
  return { insertedAt: index, length: text.length };
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  expiry_date: number;
} | null> {
  try {
    const client = getOAuth2Client();
    client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await client.refreshAccessToken();
    if (credentials.access_token) {
      return {
        access_token: credentials.access_token,
        expiry_date: credentials.expiry_date || Date.now() + 3600 * 1000,
      };
    }
    return null;
  } catch (error) {
    console.error("Token refresh error:", error);
    return null;
  }
}

export async function getUserInfo(accessToken: string) {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });

  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const res = await oauth2.userinfo.get();
  return {
    id: res.data.id || "",
    name: res.data.name || "User",
    email: res.data.email || "",
    picture: res.data.picture || "",
  };
}
