import { google } from "googleapis";

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

export function getOAuth2Client() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      "Missing required environment variables: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env.local"
    );
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl() {
  const client = getOAuth2Client();
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

export async function getTokensFromCode(code: string) {
  const client = getOAuth2Client();
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

export async function appendToDoc(
  accessToken: string,
  documentId: string,
  text: string
) {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });

  const docs = google.docs({ version: "v1", auth: client });

  // Get current document length
  const doc = await withRetry(() => docs.documents.get({ documentId }));
  const endIndex = doc.data.body?.content?.slice(-1)?.[0]?.endIndex ?? 1;

  await withRetry(() =>
    docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: { index: endIndex - 1 },
              text,
            },
          },
        ],
      },
    })
  );

  return { insertedAt: endIndex - 1, length: text.length };
}

export async function getDocEndIndex(
  accessToken: string,
  documentId: string
): Promise<number> {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const docs = google.docs({ version: "v1", auth: client });
  const doc = await withRetry(() => docs.documents.get({ documentId }));
  return doc.data.body?.content?.slice(-1)?.[0]?.endIndex ?? 1;
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

export async function insertAtIndex(
  accessToken: string,
  documentId: string,
  text: string,
  index: number
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
            insertText: {
              location: { index },
              text,
            },
          },
        ],
      },
    })
  );
  return { insertedAt: index, length: text.length };
}

export async function getDocWordCount(
  accessToken: string,
  documentId: string
): Promise<number> {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const docs = google.docs({ version: "v1", auth: client });
  const doc = await withRetry(() => docs.documents.get({ documentId }));
  
  // Extract all text content from the document
  let text = "";
  const content = doc.data.body?.content || [];
  for (const element of content) {
    if (element.paragraph?.elements) {
      for (const elem of element.paragraph.elements) {
        if (elem.textRun?.content) {
          text += elem.textRun.content;
        }
      }
    }
  }
  
  // Count words (split by whitespace, filter empty)
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  return words.length;
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
    name: res.data.name || "User",
    email: res.data.email || "",
    picture: res.data.picture || "",
  };
}
