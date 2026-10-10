/**
 * The Google Docs calls the live test makes, behind one small interface so
 * the same scenarios run against Google (run.ts) and against the in-memory
 * stub (dry runs and unit tests).
 */

import { google, type docs_v1 } from "googleapis";
import { snapshotOf } from "../../src/lib/google";
import type { DocsApi } from "../../src/lib/sync-runner";
import { pacer, realSleep } from "./clock";

export interface E2EDocs {
  readonly kind: "google" | "stub";
  /** documents.create: the new document's id */
  create(title: string): Promise<string>;
  /** documents.get */
  get(documentId: string): Promise<docs_v1.Schema$Document>;
  /** documents.batchUpdate; with `requiredRevisionId` Google refuses it (400) when the document moved on */
  batchUpdate(documentId: string, requests: object[], requiredRevisionId?: string): Promise<void>;
  /** Drive files.delete */
  remove(documentId: string): Promise<void>;
  /** Calls made so far, for the cost line and for hooks */
  readonly calls: { reads: number; writes: number };
}

export const docUrl = (documentId: string) => `https://docs.google.com/document/d/${documentId}/edit`;

/** HTTP status of a Google API error, if any */
export function statusOf(err: unknown): number | undefined {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  const code = typeof e?.code === "number" ? e.code : undefined;
  return code ?? e?.status ?? e?.response?.status;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4, sleep = realSleep): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = statusOf(err);
      const retryable = status === 429 || (typeof status === "number" && status >= 500);
      if (!retryable || attempt >= attempts) throw err;
      await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 300);
    }
  }
}

export interface GoogleClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Minimum real time between two API calls (the Docs API allows 60 writes a minute per user) */
  paceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** A Docs client that signs with a refresh token and spaces its calls out */
export function googleDocs(opts: GoogleClientOptions): E2EDocs & { accessToken(): Promise<string> } {
  const auth = new google.auth.OAuth2(opts.clientId, opts.clientSecret);
  auth.setCredentials({ refresh_token: opts.refreshToken });
  const docs = google.docs({ version: "v1", auth, timeout: 30_000 });
  const drive = google.drive({ version: "v3", auth, timeout: 30_000 });
  const pace = pacer(opts.paceMs ?? 700, opts.sleep);
  const calls = { reads: 0, writes: 0 };
  const call = <T>(kind: "reads" | "writes", fn: () => Promise<T>) =>
    withRetry(async () => {
      await pace();
      calls[kind]++;
      return fn();
    }, 4, opts.sleep);
  return {
    kind: "google",
    calls,
    async accessToken() {
      const { token } = await auth.getAccessToken();
      if (!token) throw new Error("Google returned no access token for the refresh token");
      return token;
    },
    async create(title) {
      const res = await call("writes", () => docs.documents.create({ requestBody: { title } }));
      const id = res.data.documentId;
      if (!id) throw new Error("documents.create returned no documentId");
      return id;
    },
    async get(documentId) {
      const res = await call("reads", () => docs.documents.get({ documentId }));
      return res.data;
    },
    async batchUpdate(documentId, requests, requiredRevisionId) {
      if (!requests.length) return;
      await call("writes", () =>
        docs.documents.batchUpdate({
          documentId,
          requestBody: { requests, ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}) },
        })
      );
    },
    async remove(documentId) {
      await call("writes", () => drive.files.delete({ fileId: documentId }));
    },
  };
}

export interface RunnerHooks {
  /** Runs after every write the runner made, with the number of writes so far (collaborator edits go here) */
  afterWrite?: (writes: number) => Promise<void>;
}

/** The runner's view of a document: snapshots from documents.get, batches and deletes as batchUpdates */
export function runnerDocsApi(docs: E2EDocs, hooks: RunnerHooks = {}): DocsApi {
  let writes = 0;
  const after = async () => {
    writes++;
    await hooks.afterWrite?.(writes);
  };
  return {
    async snapshot(_token, documentId) {
      return snapshotOf(await docs.get(documentId));
    },
    async batch(_token, documentId, requests, requiredRevisionId) {
      await docs.batchUpdate(documentId, requests, requiredRevisionId);
      await after();
    },
    async deleteRange(_token, documentId, startIndex, endIndex, requiredRevisionId) {
      await docs.batchUpdate(documentId, [{ deleteContentRange: { range: { startIndex, endIndex } } }], requiredRevisionId);
      await after();
    },
  };
}
