# Google Docs clipboard captures

What Google Docs (web) put on the clipboard for a Ctrl+A copy (`full`) and four partial selections of three documents: two public test documents (`lists`, `inline`) and the reference document (`reference`; its `full` capture is `../web-structured-data.slice.json`).

Each capture is three files:

- `<k>-slice.json` is the raw `application/x-vnd.google-docs-document-slice-clip+wrapped` string.
- `<k>.html` is the `text/html` copied with it (the reference document's `full` one is `../web-structured-data.html`).
- `<k>.txt` is the `text/plain` copied with it.

| capture | what was selected |
|---|---|
| `full` | Ctrl+A. It leaves out the document's last paragraph mark. |
| `partial-a` | Mid-paragraph to mid-paragraph, across an empty paragraph and list levels. |
| `partial-b` | From mid-paragraph to a paragraph's end, newline included. `lists`: a level-3 numbered item inside a bulleted list. `reference`: a level-2 bullet. |
| `partial-c` | A fragment inside one paragraph. |
| `partial-d` | `lists`: a checklist with a checked item. `inline`: a fragment with superscript and subscript. `reference`: from the document's start into a nested list. |

`scripts/fidelity/sync-fidelity.test.ts` pastes each capture into an empty document with the editor's own paste code. It then syncs the result into a strict stub Google Doc and requires the document to come out as the editor shows it.

`e2e/paste-html.spec.ts` pastes each capture twice in the app, from Docs' own copy and from its HTML alone (as Safari pastes it), and requires the two to come out the same but for what Docs' HTML doesn't carry.
