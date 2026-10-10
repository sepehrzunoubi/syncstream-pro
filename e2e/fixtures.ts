/**
 * Shared test harness: a fake Google behind every `/api/*` route, a signed-in
 * cookie, the editor exposed as `window.ssEditor`, and helpers to drive it.
 *
 * Tests import `test` and `expect` from here instead of `@playwright/test`.
 */
import { test as base, expect, type Page, type Route } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { ImportedDoc } from "../src/lib/doc-import";
import { fixtureContent, fixtureDocument, FIXTURE_DOC_ID, FIXTURE_DOC_NAME, type Fixture } from "./fixtures/google-doc";

declare global {
  interface Window {
    ssEditor?: Editor;
  }
}

export { expect };
/** The body editor (headers, footers and footnotes are `.ss-doc` editors of their own) */
export const DOC = '.ss-doc[aria-label="Text to sync"]';
export { CLOSING_TEXT, FIXTURE_DOC_ID, FIXTURE_DOC_NAME, LONG_BODY, plainParagraphs } from "./fixtures/google-doc";

/** One batchUpdate the editor sent to `/api/docs/edit` */
export interface EditBody {
  documentId: string;
  revisionId?: string;
  requests: Record<string, Record<string, unknown>>[];
}

/** What `/api/sync/start` received */
export interface StartBody {
  documentId: string;
  documentName?: string;
  revisionId?: string;
  segments?: { at: number; mode: "inline" | "before"; text: string; format: unknown }[];
  text?: string;
  context?: { doc?: unknown; ranges?: [number, number][] } | null;
  targetMinutes?: number | null;
  breaks?: "auto" | number[];
  typoFrequency?: number;
  seed?: number;
  startInMinutes?: number;
}

interface Draft {
  doc?: { type: "doc"; content: Record<string, unknown>[] };
  selectedDocId?: string | null;
  durationMinutes?: number | null;
  breaksMode?: "auto" | "none" | "custom";
  customBreaks?: number[];
  typoFrequency?: number;
  zoom?: number | "fit";
  pageless?: boolean;
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/**
 * Google, as the app sees it through its own API routes. Everything the
 * editor sends is recorded so tests can assert the exact Docs requests.
 */
export class FakeGoogle {
  readonly fixture: Fixture = fixtureDocument();
  user = { id: "user-1", name: "Test Author", email: "author@example.test", picture: "" };
  docs: { id: string; name: string; modifiedTime: string }[] = [{ id: FIXTURE_DOC_ID, name: FIXTURE_DOC_NAME, modifiedTime: new Date().toISOString() }];
  /** The body of `/api/docs/content`: the fixture document, imported like a real one */
  content: ImportedDoc = fixtureContent(this.fixture);
  revision = this.content.revisionId;
  /** The revisions returned to the editor, one per save or rename, in order */
  revisions: string[] = [];
  /** Google's own page starts (`/api/docs/pages`); none by default so the editor measures pages itself */
  pages: string[] = [];
  /**
   * How later reads of the content answer. After every save the app reads the document back to
   * compare it with what it expects; a stub can't apply Docs requests, so by default those reads
   * fail the way an unreachable Google does, and the editor keeps its own copy (which is what the
   * app does in that case). "always" serves the fixture every time, for reloads.
   */
  contentMode: "once" | "always" = "once";
  contentReads = 0;
  edits: EditBody[] = [];
  renames: { documentId: string; name: string }[] = [];
  starts: StartBody[] = [];
  jobs: Record<string, unknown>[] = [];
  /** Calls to API routes this fake doesn't know: always a bug in the test or the app */
  unexpected: string[] = [];

  /** Every Docs request sent so far, in order, optionally only those of one kind */
  requests(kind?: string): Record<string, unknown>[] {
    const all = this.edits.flatMap((e) => e.requests);
    return kind ? all.filter((r) => kind in r).map((r) => r[kind]) : all;
  }

  /** The kinds of request sent so far, e.g. ["updateTextStyle", "deleteContentRange"] */
  kinds(): string[] {
    return this.requests().map((r) => Object.keys(r)[0]);
  }

  private nextRevision(): string {
    this.revision = `fixture-rev-${this.revisions.length + 2}`;
    this.revisions.push(this.revision);
    return this.revision;
  }

  async install(page: Page): Promise<void> {
    // Google Fonts aren't reachable from the test runner; failing fast keeps page loads quick
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    await page.route(/\/api\//, async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const method = route.request().method();
      const body = () => (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      switch (path) {
        case "/api/auth/me":
          return json(route, { authenticated: true, user: this.user });
        case "/api/auth/logout":
          return json(route, { ok: true });
        case "/api/docs":
          return json(route, { docs: this.docs });
        case "/api/docs/content": {
          this.contentReads += 1;
          if (this.contentMode === "once" && this.contentReads > 1) return json(route, { error: "Couldn't load this document" }, 502);
          return json(route, { ...this.content, revisionId: this.revision });
        }
        case "/api/docs/revision":
          return json(route, { revisionId: this.revision });
        case "/api/docs/pages":
          return json(route, { pages: this.pages });
        case "/api/docs/edit": {
          const b = body() as unknown as EditBody;
          this.edits.push(b);
          return json(route, { revisionId: this.nextRevision(), replies: b.requests.map(() => ({})) });
        }
        case "/api/docs/rename": {
          const b = body() as { documentId: string; name: string };
          this.renames.push(b);
          this.docs = this.docs.map((d) => (d.id === b.documentId ? { ...d, name: b.name } : d));
          return json(route, { name: b.name });
        }
        case "/api/sync/list":
          return json(route, { jobs: this.jobs, now: Date.now() });
        case "/api/sync/start": {
          const b = body() as unknown as StartBody;
          this.starts.push(b);
          const text = b.segments ? b.segments.map((s) => s.text).join("") : b.text ?? "";
          const now = Date.now();
          const job = {
            id: `sync_${this.starts.length}`,
            userId: this.user.id,
            documentId: b.documentId,
            documentName: b.documentName ?? "Untitled document",
            status: "running",
            createdAt: now,
            startAt: now,
            startedAt: now,
            currentAction: 0,
            totalActions: 20,
            charsSent: 0,
            totalChars: text.length,
            typoSubStep: 0,
            typoCharsInDoc: 0,
            generation: 0,
            failures: 0,
            activity: "Typing",
            etaTargetAt: now + 10 * 60_000,
            nextActionAt: now + 3000,
            wpm: 32,
            baselineWordCount: 0,
            breaks: [],
            completedBreaks: [],
            lastUpdate: now,
            sourceText: text,
            context: b.context ?? null,
          };
          this.jobs = [job, ...this.jobs];
          return json(route, { job });
        }
        case "/api/sync/source": {
          const job = this.jobs.find((j) => j.id === url.searchParams.get("jobId"));
          if (!job) return json(route, { error: "Not found" }, 404);
          return json(route, { sourceText: job.sourceText, format: null, context: job.context });
        }
        case "/api/sync/pause":
        case "/api/sync/resume":
        case "/api/sync/cancel": {
          const id = body().jobId;
          const status = path.endsWith("pause") ? "paused" : path.endsWith("resume") ? "running" : "cancelled";
          this.jobs = this.jobs.map((j) => (j.id === id ? { ...j, status, lastUpdate: Date.now() } : j));
          return json(route, { job: this.jobs.find((j) => j.id === id) });
        }
        case "/api/sync/dismiss":
          this.jobs = this.jobs.filter((j) => j.id !== body().jobId);
          return json(route, { ok: true });
        default:
          this.unexpected.push(`${method} ${path}`);
          return json(route, { error: `e2e: no fake for ${method} ${path}` }, 404);
      }
    });
  }
}

/** A paragraph as the page shows it */
export interface ParagraphView {
  text: string;
  style: string;
  list: string | null;
  level: number;
  label: string | null;
  align: string;
}

/** Drives the dashboard through the real editor (`window.ssEditor`) */
export class App {
  constructor(readonly page: Page, readonly api: FakeGoogle) {}

  /** The body editor */
  get doc() {
    return this.page.locator(DOC);
  }

  /**
   * Open the dashboard. By default the fixture document is selected; `plain` instead opens a
   * draft typed without a document (nothing to save, everything pending), as the pagination
   * tests want.
   */
  async open(opts: { draft?: Draft; plain?: Record<string, unknown>[] } = {}): Promise<void> {
    const draft: Draft = { selectedDocId: FIXTURE_DOC_ID, breaksMode: "auto", durationMinutes: 60, ...opts.draft };
    if (opts.plain) {
      this.api.docs = [];
      draft.doc = { type: "doc", content: opts.plain };
      draft.selectedDocId = null;
    }
    await this.page.context().addCookies([{ name: "google_access_token", value: "e2e-token", domain: "localhost", path: "/" }]);
    await this.api.install(this.page);
    await this.page.addInitScript((d: Draft) => {
      localStorage.setItem("ss_debug", "1");
      localStorage.setItem("syncstream_draft_v2", JSON.stringify(d));
    }, draft);
    await this.page.goto("/dashboard");
    await this.doc.locator("p").first().waitFor();
    if (opts.plain) {
      await expect(this.doc).toContainText((opts.plain[0] as { content?: { text?: string }[] }).content?.[0]?.text ?? "");
    } else {
      // The document is in: its paragraphs are on the page and the editor glows new text
      await expect(this.page.locator(`${DOC}.ss-glow`)).toBeAttached();
      await expect(this.doc).toContainText(FIXTURE_DOC_NAME);
      await expect(this.subtitle()).toContainText(/Edits save to Google Docs|New text glows/);
    }
    await this.page.waitForFunction(() => !!window.ssEditor);
  }

  /** The line under the document name: what the workspace is doing */
  subtitle() {
    return this.page.locator("header .text-\\[12px\\]").first();
  }

  /** The editor's document as JSON */
  json(): Promise<Record<string, unknown>> {
    return this.page.evaluate(() => window.ssEditor!.getJSON() as Record<string, unknown>);
  }

  /** All text in the editor, paragraphs joined with newlines */
  text(): Promise<string> {
    return this.page.evaluate(() => window.ssEditor!.state.doc.textBetween(0, window.ssEditor!.state.doc.content.size, "\n", "￼"));
  }

  /** The top-level paragraphs as the page renders them */
  paragraphs(): Promise<ParagraphView[]> {
    return this.page.evaluate((sel) =>
      Array.from(document.querySelectorAll<HTMLElement>(`${sel} > p`)).map((p) => ({
        text: p.textContent ?? "",
        style: p.dataset.style ?? "normal",
        list: p.dataset.list ?? null,
        level: Number(p.dataset.level ?? 0),
        label: p.dataset.label ?? null,
        align: getComputedStyle(p).textAlign,
      })), DOC
    );
  }

  /** The glowing (pending) text, in document order */
  pending(): Promise<string[]> {
    return this.page.evaluate((sel) => Array.from(document.querySelectorAll(`${sel} .ss-add`)).map((e) => e.textContent ?? ""), DOC);
  }

  /** Where `text` first occurs: editor positions of the match and of its paragraph's content */
  locate(text: string): Promise<{ from: number; to: number; paraStart: number; paraEnd: number }> {
    return this.page.evaluate((needle) => {
      const ed = window.ssEditor!;
      let found: { from: number; to: number; paraStart: number; paraEnd: number } | null = null;
      ed.state.doc.descendants((node, pos) => {
        if (found || !node.isTextblock) return !found;
        const t = node.textBetween(0, node.content.size, "", "￼");
        const i = t.indexOf(needle);
        if (i >= 0) found = { from: pos + 1 + i, to: pos + 1 + i + needle.length, paraStart: pos + 1, paraEnd: pos + 1 + node.content.size };
        return false;
      });
      if (!found) throw new Error(`"${needle}" is not in the document`);
      return found;
    }, text);
  }

  /** Put the caret right after the first occurrence of `text` and focus the editor */
  async caretAfter(text: string): Promise<void> {
    const { to } = await this.locate(text);
    await this.setSelection(to, to);
  }

  /** Put the caret right before the first occurrence of `text` */
  async caretBefore(text: string): Promise<void> {
    const { from } = await this.locate(text);
    await this.setSelection(from, from);
  }

  /** Put the caret at the end of the paragraph that contains `text` */
  async caretAtEnd(text: string): Promise<void> {
    const { paraEnd } = await this.locate(text);
    await this.setSelection(paraEnd, paraEnd);
  }

  /** Select the first occurrence of `text` */
  async select(text: string): Promise<void> {
    const { from, to } = await this.locate(text);
    await this.setSelection(from, to);
  }

  /** Select the whole paragraph that contains `text` */
  async selectParagraph(text: string): Promise<void> {
    const { paraStart, paraEnd } = await this.locate(text);
    await this.setSelection(paraStart, paraEnd);
  }

  async setSelection(from: number, to: number): Promise<void> {
    await this.page.evaluate(([f, t]) => { window.ssEditor!.chain().focus().setTextSelection({ from: f, to: t }).run(); }, [from, to]);
    await expect.poll(() => this.page.evaluate(() => window.ssEditor!.isFocused)).toBe(true);
  }

  /** Paste into the editor at the current selection, as the clipboard would (HTML and/or plain text) */
  async paste(data: { html?: string; text: string }): Promise<void> {
    await this.page.evaluate(({ html, text, sel }) => {
      const dt = new DataTransfer();
      if (html) dt.setData("text/html", html);
      dt.setData("text/plain", text);
      document.querySelector(sel)!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, { ...data, sel: DOC });
  }

  /** Number of page sheets drawn behind the text */
  sheets(): Promise<number> {
    return this.page.locator(".ss-sheet").count();
  }

  /** Open a top menu and choose an item */
  async menu(top: string, item: string): Promise<void> {
    await this.page.locator(".ss-menubar-trigger", { hasText: top }).click();
    // An item's accessible name includes its shortcut, so match the label itself
    await this.page.getByRole("menuitem").filter({ has: this.page.getByText(item, { exact: true }) }).click();
  }

  /** The Docs requests the editor saves; waits until at least `atLeast` batches were sent */
  async waitForSave(atLeast = 1): Promise<void> {
    await expect.poll(() => this.api.edits.length, { timeout: 5000 }).toBeGreaterThanOrEqual(atLeast);
  }
}

export const test = base.extend<{ api: FakeGoogle; app: App }>({
  api: async ({}, provide) => { // eslint-disable-line no-empty-pattern
    await provide(new FakeGoogle());
  },
  app: async ({ page, api }, provide) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await provide(new App(page, api));
    expect(errors, "no uncaught errors in the page").toEqual([]);
    expect(api.unexpected, "every API call had a fake").toEqual([]);
  },
});
