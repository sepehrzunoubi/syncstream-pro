import { google } from "googleapis";

export function getOAuth2Client() {
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
  const res = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.document'",
    orderBy: "modifiedTime desc",
    pageSize: maxResults,
    fields: "files(id, name, modifiedTime)",
  });

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
  const doc = await docs.documents.get({ documentId });
  const endIndex = doc.data.body?.content?.slice(-1)?.[0]?.endIndex ?? 1;

  await docs.documents.batchUpdate({
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
  });

  return { insertedAt: endIndex - 1, length: text.length };
}

export async function getDocEndIndex(
  accessToken: string,
  documentId: string
): Promise<number> {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const docs = google.docs({ version: "v1", auth: client });
  const doc = await docs.documents.get({ documentId });
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
  await docs.documents.batchUpdate({
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
  });
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
  await docs.documents.batchUpdate({
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
  });
  return { insertedAt: index, length: text.length };
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
