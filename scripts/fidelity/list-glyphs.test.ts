/**
 * A tab whose lists the Docs API gives no glyph for, read through the code that calls Google
 * (src/lib/google.ts): getDocument asks Docs' export of that tab what it draws, and a list it draws
 * as bullets reads as bullets; without the export, the list stays as the API gives it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { google, type docs_v1 } from "googleapis";
import { importDoc } from "../../src/lib/doc-import";
import { getDocument } from "../../src/lib/google";

const unnamed = (): docs_v1.Schema$List => ({ listProperties: { nestingLevels: [0, 1].map((n) => ({ glyphFormat: `%${n}` })) } });
const item = (at: number, text: string, nestingLevel: number): docs_v1.Schema$StructuralElement => ({
  startIndex: at, endIndex: at + text.length + 1,
  paragraph: { bullet: { listId: "kix.old", nestingLevel }, elements: [{ startIndex: at, endIndex: at + text.length + 1, textRun: { content: `${text}\n`, textStyle: {} } }], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } },
});
const tab = (tabId: string, content: docs_v1.Schema$StructuralElement[], lists: Record<string, docs_v1.Schema$List>): docs_v1.Schema$Tab => ({
  tabProperties: { tabId, title: tabId, index: 0, nestingLevel: 0 },
  documentTab: { body: { content: [{ endIndex: 1, sectionBreak: { sectionStyle: {} } }, ...content] }, lists },
});

(google as unknown as { docs: () => unknown }).docs = () => ({
  documents: {
    async get() {
      return { data: { documentId: "doc-lists-1234", title: "T", revisionId: "r1", tabs: [tab("t.0", [], {}), tab("t.web", [item(1, "Point", 0), item(7, "Sub point", 1)], { "kix.old": unnamed() })] } };
    },
  },
});

const realFetch = globalThis.fetch;
function serve(reply: (url: string, auth: string | null) => Response) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    return reply(url, new Headers(init?.headers).get("authorization"));
  }) as typeof fetch;
  return asked;
}

const lists = async () => importDoc((await getDocument("token-1", "doc-lists-1234", "t.web")).doc).nodes.filter((n) => n.attrs?.list).map((n) => [n.attrs?.list, (n.attrs?.glyph as { symbol?: string }).symbol]);

test("a tab's list the API gives no glyph for reads as the bullets Docs' export of that tab draws", async () => {
  const asked = serve((url, auth) => {
    assert.equal(auth, "Bearer token-1");
    return new Response('<style>.lst-kix_old-0>li:before{content:"\\0025cf  "}.lst-kix_old-1>li:before{content:"\\0025cb  "}</style>', { headers: { "content-type": "text/html; charset=utf-8" } });
  });
  try {
    assert.deepEqual(await lists(), [["bullet", "●"], ["bullet", "○"]]);
    assert.deepEqual(asked, ["https://docs.google.com/document/d/doc-lists-1234/export?format=html&tab=t.web"]);
  } finally { globalThis.fetch = realFetch; }
});

test("when the export can't be had, the list is as the API gives it", async () => {
  serve(() => new Response("no", { status: 403 }));
  try {
    assert.deepEqual(await lists(), [["check", null], ["check", null]]);
  } finally { globalThis.fetch = realFetch; }
});
