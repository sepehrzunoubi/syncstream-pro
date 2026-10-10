# SyncStream Pro

A utility for **human-cadence text synchronization into Google Docs**. The dashboard is a Google Docs look-alike editor: open one of your Docs, see it exactly as Docs lays it out, edit it (edits save straight to Docs), add text that glows, and start a sync that types the glowing text in at a human pace. A second tab, the **Style engine**, rewrites text in a house style learned from a developer-curated dataset of input/output pairs and served by a local Llama model.

Sign in with any Google account and start syncing. There is no license key or allow-list.

## Tech Stack

- **Framework:** Next.js 14 (App Router), TypeScript
- **Editor:** TipTap 3 / ProseMirror with a pagination plugin; Radix menus
- **Styling:** Tailwind CSS for the shell, `docs.css` for the Docs-like workspace (light, like Docs)
- **Animations:** Framer Motion, tsParticles on the landing page
- **Icons:** Material Symbols (subset loaded in the dashboard layout), Lucide on the landing page
- **Backend:** Next.js API Routes
- **Google APIs:** `googleapis` (OAuth2, Docs, Drive)
- **Job state:** Upstash Redis (in-memory fallback for local dev)
- **Background delivery:** Upstash QStash (direct HTTP fallback for local dev)
- **Style engine:** a local model (Ollama or any OpenAI-compatible server); Claude only as an optional cloud provider for testing prompts

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use existing)
3. Enable **Google Docs API** and **Google Drive API**
4. Create **OAuth 2.0 Client ID** (Web application)
5. Add `http://localhost:3000/api/auth/callback` as an authorized redirect URI
6. On the OAuth consent screen, publish the app (or add each tester's Gmail address while it is in "Testing" mode). While the consent screen is in Testing, Google only lets listed test users sign in.

Never commit the downloaded `client_secret_*.json` file. It is git-ignored.

### 3. Set environment variables

Copy `.env.example` to `.env.local` and fill in real values:

```bash
cp .env.example .env.local
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | yes | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | yes | `<base-url>/api/auth/callback` |
| `NEXT_PUBLIC_BASE_URL` | yes | Public origin of the app (used for OAuth and QStash callbacks) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | production | Persistent job state across serverless instances |
| `QSTASH_URL` / `QSTASH_TOKEN` / `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | production | Guaranteed background delivery of sync steps. Copy all four from the QStash console; `QSTASH_URL` selects your account's region |
| `CRON_SECRET` | production | Protects `/api/cron/sync-watchdog` |
| `ERROR_WEBHOOK_URL` | optional | Incoming webhook (Slack, Discord or any HTTPS endpoint) that receives unhandled errors and failed syncs; see Operations |
| `RATE_LIMIT_DISABLED` | optional | `1` turns per-route rate limiting off (local dev, tests) |
| `LOG_LEVEL` / `LOG_PRETTY` | optional | Log threshold (`debug`, `info`, `warn`, `error`) and `0`/`1` to force JSON or readable lines |
| `LLM_PROVIDER` | Style engine | `ollama` (default), `openai` (any OpenAI-compatible server) or `anthropic` (cloud, for testing prompts) |
| `LLM_BASE_URL` | Style engine | The model server, default `http://127.0.0.1:11434` for Ollama |
| `LLM_MODEL` | Style engine | Model name, default `llama3.1` |
| `LLM_API_KEY` / `ANTHROPIC_API_KEY` | optional | Only for OpenAI-compatible servers that need a key, or for the `anthropic` provider |

Without a reachable model server the Style engine tab shows a notice and syncing is unaffected. A deployment on Vercel cannot reach a model on your own machine; run the app where it can reach the model server, or point `LLM_BASE_URL` at a server with a public address.

Locally, the Upstash and QStash variables are optional: the app falls back to an in-memory store and a direct HTTP self-call.

### 4. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deploying to Vercel

Once deployed, sign in and open `/api/health` to verify every service is reachable with the deployment's environment variables.

1. Import the repository into Vercel.
2. Set every variable from the table above in **Project Settings → Environment Variables**, using your production domain:

   ```env
   GOOGLE_REDIRECT_URI=https://your-domain.com/api/auth/callback
   NEXT_PUBLIC_BASE_URL=https://your-domain.com
   ```

3. Add `https://your-domain.com/api/auth/callback` to the OAuth client's authorized redirect URIs.

`vercel.json` schedules the sync watchdog cron once a day (`0 0 * * *`). Hobby plans only allow daily crons, and a more frequent schedule makes the whole deployment fail. On a Pro plan you can tighten it (for example `*/2 * * * *`) for faster recovery of stalled jobs. QStash retries already cover normal delivery, so the cron is only a safety net.

`/api/sync/process` declares `maxDuration = 300`. If your Vercel plan caps function duration lower, reduce that value; the route chains itself well before the limit. `/api/style/transform` declares the same `maxDuration`, because a long text on a small local model can take minutes; it streams its reply, so the browser sees text as soon as it is written.

## Self-hosting with a local model

The Style engine runs on a model you host, so the whole app can live on your own machine or server with nothing leaving it but the Google Docs calls.

**Everything in one command.** `docker-compose.yml` starts Ollama, pulls the model named by `LLM_MODEL` once (default `llama3.1`), and builds and runs the app against it:

```bash
cp .env.example .env.local      # Google OAuth values; set LLM_MODEL if you want a different model
docker compose up --build       # app on http://localhost:3000, Ollama on http://localhost:11434
```

Add `http://localhost:3000/api/auth/callback` to the OAuth client's redirect URIs. For a GPU, uncomment the `deploy` block in the compose file (NVIDIA container toolkit required); without one, a 7B to 8B model runs on CPU at a few tokens per second, which the streaming UI tolerates. `llama3.1:70b` needs roughly 40 GB of memory.

**App and model on different machines.** Run Ollama where the hardware is (`ollama serve`, `ollama pull llama3.1`) and point the app at it with `LLM_PROVIDER=ollama`, `LLM_BASE_URL=http://<host>:11434`, `LLM_MODEL=llama3.1`. Ollama only listens on localhost by default; set `OLLAMA_HOST=0.0.0.0` on that machine, and keep the port inside your network or behind a tunnel (for example `cloudflared tunnel --url http://localhost:11434` or `ngrok http 11434`), since Ollama has no authentication of its own. Any OpenAI-compatible server (llama.cpp's `llama-server`, vLLM, LM Studio) works the same way with `LLM_PROVIDER=openai` and, if it needs one, `LLM_API_KEY`.

**Check it.** Sign in and open `/api/health`: the `styleEngine` row says whether the model server answers and whether a style has been compiled. The Style engine tab shows the same in its header.

**Vercel.** A Vercel deployment cannot reach a model on a private machine, so there the tab shows a notice unless `LLM_BASE_URL` points at a publicly reachable server. Syncing is unaffected either way.

## Architecture

```
src/
├── app/
│   ├── api/
│   │   ├── auth/        # OAuth login, callback, logout, me
│   │   ├── cron/        # sync-watchdog (daily safety net for lost queue messages)
│   │   ├── docs/        # List, create, read (content), edit, rename, revision (change polling), pages (Google's page breaks from the PDF export)
│   │   ├── health/      # Live check of every configured service (signed-in users)
│   │   ├── images/      # Upload pasted images and serve them so Google Docs can fetch them
│   │   ├── style/       # Style engine: status of the model server and compiled style; transform (text → text, streamed)
│   │   └── sync/        # start / list / status / pause / resume / cancel / dismiss / source / process
│   ├── dashboard/       # Authenticated workspace (layout loads fonts, docs.css holds the Docs styles)
│   │   └── style/       # The Style engine tab
│   ├── privacy/, tos/   # Legal pages
│   └── page.tsx         # Landing page with Google sign-in
├── components/
│   ├── workspace/
│   │   ├── workspace.tsx        # State and layout of the dashboard
│   │   ├── header.tsx           # Target doc picker, Start sync, account menu
│   │   ├── toolbar.tsx          # Docs formatting toolbar
│   │   ├── menubar.tsx          # File / Edit / View / Insert / Format / Help menus
│   │   ├── context-menu.tsx     # Right-click menu and the keyboard shortcuts dialog
│   │   ├── outline.tsx          # Document outline (headings) in the left panel
│   │   ├── find.ts, find-bar.tsx # Find (Ctrl+F) and find & replace (Ctrl+H)
│   │   ├── insert-popovers.tsx  # Link and image dialogs
│   │   ├── dialog.tsx, format-dialogs.tsx, page-setup-dialog.tsx  # Docs-style dialogs: spacing, borders, columns, page setup
│   │   ├── color-menu.tsx       # Text and highlight colour palettes
│   │   ├── image-upload.ts      # Downscale and upload images
│   │   ├── ruler.tsx            # Ruler with draggable indent markers
│   │   ├── extensions.ts        # Editor (TipTap) setup: paragraph styles, indents, fonts, lists, tables, breaks, footnotes, columns, paste
│   │   ├── pagination.ts        # Splits the document into pages (page setup, keep rules, Google's own breaks); marks typing progress
│   │   ├── line-metrics.ts      # Measures each font's natural line height, as Docs spaces lines
│   │   ├── doc-sync.ts          # New text glows as an addition; list numbers; locked regions
│   │   ├── paged-surface.tsx    # Draws the page sheets, headers, footers and footnotes behind the editor
│   │   ├── segment-editor.tsx   # Editors for headers, footers and footnotes
│   │   ├── sync-panel.tsx       # Total time, breaks, typos, start time, plan
│   │   ├── job-panel.tsx        # Status and controls of a running sync
│   │   ├── sync-rail.tsx        # List of syncs
│   │   └── workspace-tabs.tsx   # Sync / Style engine switch in the header
│   ├── style/
│   │   ├── style-workspace.tsx  # The Style engine tab: text in, rewritten text out
│   │   ├── diff-view.tsx        # Removed text struck through, added text highlighted
│   │   ├── style-api.ts         # Reads the streamed replies of the style routes
│   │   └── style-store.ts       # Last text and result on this device; hand-off of a result to the sync editor
│   ├── dashboard/login-screen.tsx  # Landing page
│   └── ui/                      # Button, particles
├── lib/
│   ├── drip-engine.ts   # Seeded planner: chunks, pauses, typos, breaks, target duration
│   ├── rich-text.ts     # Formatting model and the Docs formatting requests for any text range
│   ├── image-store.ts   # Redis storage for uploaded images (14 days)
│   ├── doc-import.ts    # Reads an existing Google Doc into the editor (styles, lists, tables, breaks, headers, footnotes, page setup)
│   ├── doc-model.ts     # Compares the editor with the saved doc: direct edits to save, additions to sync
│   ├── page-setup.ts    # Paper sizes, margins, orientation; the Docs documentStyle requests
│   ├── page-text.ts, page-offsets.ts  # Google's page breaks: text per PDF page, matched back to the document
│   ├── list-labels.ts   # Bullet and numbering glyphs per preset and level
│   ├── secret.ts        # Signed cookies, sealed tokens at rest, internal secrets
│   ├── sync-runner.ts   # Queue-driven worker: bounded windows, lock, idempotent writes, retries
│   ├── sync-store.ts    # Redis-backed plans, jobs, per-user index, locks, control intents
│   ├── sync-api.ts      # Ownership checks and lock-aware job mutations for the routes
│   ├── style-metrics.ts # Sentence, clause, pacing, transition and punctuation measurements; word-level diff
│   ├── fingerprint.ts   # Stylistic fingerprint of a dataset: pacing, clause density, vocabulary, rules, match score, exemplar choice
│   ├── style-candidates.ts # The prompt strategies the style lab competes against each other
│   ├── style-spec.ts    # The compiled style the app ships, and the request built from it for a user's text
│   ├── llm.ts           # The model behind the Style engine: Ollama, OpenAI-compatible, or Claude; complete and stream
│   ├── style-engine.ts  # Limits and the summary shown next to a result
│   ├── auth.ts          # Cookie helpers and user resolution
│   ├── google.ts        # OAuth2, Drive, Docs helpers
│   ├── qstash.ts        # QStash client / receiver / enqueue helper
│   └── base-url.ts      # Public origin resolution
└── middleware.ts        # Redirects between / and /dashboard based on auth cookies
scripts/style-lab/       # Developer tooling: dataset, scoring, the prompt search (run.ts), compile.ts, a mock Ollama
style-data/<name>/       # A dataset: samples.jsonl (x → z), config.json, compiled.json (shipped), results/ (lab runs)
```

## How a sync runs

1. The dashboard builds a preview plan from your text with a random seed and shows exactly what will happen: total time, finish time, number of edits and typos, and the list of breaks. "Shuffle" picks a new seed.
2. `POST /api/sync/start` rebuilds the same plan from the same seed, stores it once, stores a small job record, and publishes one QStash message.
3. QStash calls `POST /api/sync/process`. Each call takes a Redis lock, works for at most 20 seconds (typing a few chunks), persists the cursor after every edit, then re-publishes itself with the exact delay until the next edit. Long waits and breaks therefore live in the queue, not in a running function.
4. The dashboard polls `GET /api/sync/list` every few seconds while anything is active. Pause, resume and cancel go through the lock; if the worker is mid-edit they leave an intent that it applies within three seconds.
5. A daily cron re-kicks any job whose queue message was lost. This is only a safety net.

### Reliability

- **No browser needed.** Once started (or scheduled), a sync finishes even if the tab is closed or the computer is off. Close the tab and reopen the dashboard later; your syncs are listed from the server.
- **Never types twice.** Queues deliver at least once. The lock rejects concurrent deliveries, and before every write the worker records what it is about to insert and checks the document's tail, so a retry after a lost response skips the edit that already landed.
- **Survives hiccups.** A failed Google call is retried three times with backoff before the job is marked as an error. Expired access tokens are refreshed with the stored refresh token.
- **Ownership.** Every job route checks that the job belongs to the signed-in Google account.

### QStash usage

Each hand-off is one QStash message. A typical 300-word sync uses roughly 60 to 80 messages; a very long, slow sync uses about one message per edit. Upstash's free tier allows a limited number of messages per day, so check the QStash dashboard if you plan to run many syncs.

## Controls

The dashboard is laid out like Google Docs: a File, Edit, View, Insert and Format menu bar, the formatting toolbar, a ruler with draggable indent markers, the page in the middle, your syncs on the left and the sync settings on the right. Animations use Framer Motion and turn off when the system asks for reduced motion.

- **Documents that already have text.** Pick a document and it opens on the page, fully editable. Formatting, deleting and restructuring existing text saves straight to Google Docs, like Docs autosave. Anything you type or paste is new text: it glows until a sync types it in, and you can add it in as many places as you like. Start sync types every glowing addition, top to bottom, each at its own spot. While it runs, the worker finds each spot again before every edit, so changes elsewhere in the document don't throw it off. Additions are kept on this device per document until they are synced. If the document changes in Google Docs (checked every few seconds while the tab is visible), SyncStream reloads it and puts your additions back where they were.
- **Pages.** The editor lays the document out on pages exactly as Docs does: File > Page setup sets paper size, orientation, margins and page colour (or Pageless), lines are spaced with each font's natural line height, and page breaks follow Google's own pagination (read from the Doc's PDF export). Narrow screens always use pageless. While a sync runs, the same paginated page shows what has been typed so far, with a caret at the current position.
- **Formatting.** Paragraph styles (Normal text, Title, Subtitle, Headings 1 to 6), fonts, sizes in points, bold, italic, underline, strikethrough, superscript, subscript, small caps, capitalization, text colour, highlight, links, alignment, line and paragraph spacing (custom spacing dialog), keep with next, keep lines together, widow control, borders and shading, indents and first-line indent (ruler or Tab at the start of a paragraph). The toolbar also has undo, redo, print, spell check and paint format. The same shortcuts as Docs work, with Help > Keyboard shortcuts (Ctrl+/) and a right-click menu. Pasting from Google Docs or Word keeps this formatting (Ctrl+Shift+V pastes plain). Every chunk is typed into the Google Doc together with its formatting in a single API call.
- **Lists.** Bulleted, numbered and checklists with every Docs bullet and numbering style, nested up to eight levels with Tab and Shift+Tab. They become real Docs lists. Checklist items are created unchecked because the Docs API cannot tick them.
- **Structure.** Page breaks (Ctrl+Enter), section breaks, columns, headers and footers (double-click the page margin), footnotes (Ctrl+Alt+F), tables (insert from the grid, edit cells, add or delete rows and columns), find and replace, a document outline, and renaming the document. All of it is written through the Docs API so Docs shows the same result. Smart chips, suggestions, comments, page numbers and positioned images are shown as Docs has them but cannot be edited here, because the Docs API cannot write them.
- **Images.** Paste, drop, upload or insert by URL. Uploaded images are downscaled to under 700 KB and stored in Redis for 14 days so Google can fetch them when the sync reaches that point. PNG, JPEG and GIF are supported.
- **Not supported.** Comments cannot be added, because the Google Docs API has no way to create a comment anchored to text.

- **Total time.** Auto types at a natural pace (roughly 35 words per minute plus pauses). A target duration is met exactly: a longer target inserts away-time between paragraphs, a shorter one drops automatic breaks and types faster, down to a realistic floor.
- **Breaks.** Auto picks a few based on text length, None disables them, Custom lets you choose up to eight from 5 minutes to 3 hours. They run in order, spread through the text at paragraph or sentence ends.
- **Typos.** From rare to frequent. Each typo types a plausible slip, waits briefly, deletes it and types the correct words.
- **Start.** Now, or in 5 minutes to 12 hours. Scheduled syncs run on the server.
- **Several at once.** Start as many syncs as you like, each to its own document. The strip above the editor lets you switch between them.

## Style engine

The second tab (the switch sits in the header next to Start sync; File > Style engine opens it too) rewrites whatever the user pastes into a fixed house style. Users only send text. The style itself is trained by the developer from a dataset of real examples and shipped with the app.

The problem it solves: we have **x**, what users typed, and **z**, the output we want to mirror, but not **y**, the instructions that make a local model turn x into z. The style lab searches for y.

**Dataset.** `style-data/solvely/samples.jsonl` holds one `{"id", "input", "output"}` per line (see the README there). The developer adds every new "I sent this, I got this back" pair; users never contribute.

**Fingerprint.** `src/lib/fingerprint.ts` measures the dataset without any model: sentence-length mix and rhythm, words per clause, commas, subordination, transitions and where they sit, contractions, person, passive voice, hedges, punctuation habits, list and paragraph structure, the words outputs prefer or drop, substitutions mined from word-level diffs, signature phrases, sentence openers, and what survives verbatim. It turns the numbers into explicit rules with evidence counts, and it can score any candidate output against the targets. `npm run style:fingerprint` prints it.

**Candidates.** `src/lib/style-candidates.ts` holds the prompt strategies: rules only, numeric targets, examples as prior chat turns or inline, terse versions for small models, an editor's-pass framing, and so on. Each builds the messages a model receives from the fingerprint, a few exemplars chosen for the input, and the input itself.

**Lab.** `npm run style:eval` replays the dataset's original inputs through every candidate on the configured model (`LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`; `--model` overrides), holding out a share of the samples (or leave-one-out for small sets), and scores each reply against the real output: wording overlap (token F1 and ordered overlap), style match against the fingerprint, and fidelity (names and numbers kept, length). It prints a leaderboard and saves the run under `style-data/solvely/results/`. Options: `--candidates a,b`, `--holdout N`, `--loo`, `--runs 2`, `--limit 10`, `--concurrency 2`, `--verbose`, `--promote`.

**Ship.** `npm run style:compile -- --candidate <winner>` (or `--promote` on the lab run) writes `style-data/solvely/compiled.json`: the fingerprint, the rules, every sample as a runtime exemplar, and the winning candidate. The app bundles it at build time. At request time `/api/style/transform` picks the exemplars closest to the user's text, builds the winning prompt, and streams the model's reply. "Revise again" sends the draft back with the fingerprint's deviations as instructions.

**Plumbing without a model.** `npm run style:mock` starts a fake Ollama on port 11434 that answers with a crude rewrite; use it to check the lab and the tab end to end. Its scores mean nothing.

## Operations

### Logs

Every server-side log line is one JSON object on stdout (info) or stderr (warn, error): `{"ts","level","event",...fields}`. Events are dotted names (`sync.write`, `docs.edit`, `route.failed`, `rate_limit.hit`), and every line about a sync carries `job` and `uid`. User ids only ever appear as `uid`, a short SHA-256 prefix; tokens, cookies, email addresses and document text are never logged (field names that look like secrets are redacted, emails inside strings are masked, long strings are cut). In development the same records print as one readable line; set `LOG_PRETTY=0` (or `LOG_JSON=1`) to force JSON locally, and `LOG_LEVEL=debug|info|warn|error` to change the threshold (default `info`).

To ship them: on Vercel, add a Log Drain (Project → Settings → Log Drains) to Datadog, Axiom, Better Stack or any HTTPS endpoint; the drain receives the lines as written, so they can be parsed as JSON. With Docker, point the container's log driver at your collector (`--log-driver`), or tail stdout/stderr with Vector, Fluent Bit or Promtail and parse as JSON. Useful queries: `event:sync.failed` (every runner failure, with `kind` = `auth`, `not_found`, `quota`, `rejected` or `transient`), `event:sync.write` (one line per Docs batch: `chars`, `requests`, `docsMs`, `snapshotMs`), `event:sync.stale_revision` and `event:google.retry` (contention and Google hiccups), `event:rate_limit.hit`, `event:route.failed` (unhandled errors, as JSON 500s).

### Error reporting

Set `ERROR_WEBHOOK_URL` to be told when something goes wrong: unhandled errors in any API route, a sync that gave up (`sync.error`), a sync the watchdog had to re-kick (`sync.stuck`), a failed sync start or resume. The app POSTs a compact JSON payload with a 3s timeout:

```json
{ "text": "[syncstream production] sync.error at /api/sync/process: …",
  "service": "syncstream", "env": "production", "event": "sync.error",
  "message": "…", "stack": "…(truncated)", "context": { "route": "…", "uid": "…", "jobId": "…" }, "ts": "…" }
```

`text` is a one-line summary, so a Slack or Discord incoming webhook renders it as is; generic receivers get the structured fields. The same message on the same route is sent at most once a minute per process, so an error storm is one notification. A webhook that is down or slow is logged as a warning and never affects the request.

### Rate limits

Budgets are per minute, keyed by the signed-in user (a hashed id) or, before sign-in, by client IP (first hop of `x-forwarded-for`, else `x-real-ip`). Over budget, a route answers `429 {"error":…,"code":"rate_limited"}` with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers. Counters live in Upstash Redis when it is configured (one Lua round trip per request), otherwise in a bounded in-memory map; if Redis fails the limiter lets the request through and logs `rate_limit.store_error`. `RATE_LIMIT_DISABLED=1` turns limiting off for local development and tests.

| Route | Key | Budget | Why |
| --- | --- | --- | --- |
| `GET /api/auth/login`, `GET /api/auth/callback` | IP | 20 | OAuth round trips |
| `GET /api/auth/me` | IP | 120 | Session check, polled by the dashboard |
| `POST /api/docs/edit` | user | 120 | Autosave is debounced ~700ms, so continuous typing stays near 60 |
| `GET /api/docs/content` | user | 60 | Full document read |
| `GET /api/docs/pages` | user | 90 | PDF export, refreshed 1.5s after edits |
| `GET /api/docs/revision` | user | 120 | Polled every few seconds |
| `GET /api/docs` | user | 60 | Drive listing |
| `POST /api/docs/create` | user | 20 | |
| `POST /api/docs/rename` | user | 30 | |
| `POST /api/images` | user | 30 | Uploads into Redis |
| `POST /api/sync/start` | user | 10 | Plans a job and publishes to QStash |
| `GET /api/sync/list`, `GET /api/sync/status`, `GET /api/sync/source` | user | 240 | Polled while a sync runs |
| `POST /api/sync/pause`, `resume`, `cancel`, `dismiss` | user | 60 | |
| `POST /api/style/transform` | user | 6 | Minutes of model time each |
| `GET /api/style/status` | user | 60 | |
| `GET /api/health` | IP | 30 | |
| `POST /api/sync/process`, `GET /api/cron/sync-watchdog`, `GET /api/images/[id]` | — | none | Internal (signature or secret protected) or fetched by Google |

### Health endpoint

`GET /api/health` answers for anyone with liveness only: `{ ok, service, version, uptime }`. Point an uptime monitor at it. A signed-in user additionally gets configuration presence (`deployment, env, redis: {configured}, qstash: {configured, signing}, errorWebhook: {configured}, rateLimit: {enabled, store}`), live checks (`checks.redis` pings Redis, `checks.qstash` lists schedules with the token, Google and Style engine configuration) and, per variable, whether it is present, its length and whether it has stray whitespace.

## Live end-to-end test

`npm run e2e:live` proves the two write paths against the real Google Docs API, in a throwaway document it creates and deletes. Unit tests use fakes; this is the one check where Google itself is in the loop.

**Authorize once.** `npm run e2e:live:auth` prints a Google sign-in URL for the app's own OAuth client (same scopes as the app, with `access_type=offline&prompt=consent` so Google issues a refresh token). Sign in as a Google account whose Drive may hold the test document, consent, and the script catches the redirect (it listens on `GOOGLE_REDIRECT_URI` when nothing else does; otherwise paste the `code` from the browser's address bar). It prints `E2E_GOOGLE_REFRESH_TOKEN=...`: put that line in `.env.local`, or add it as a repository secret. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` come from `.env.local` as usual. The token is as sensitive as a signed-in session; OAuth apps still in "Testing" status expire refresh tokens after seven days, so re-run the authorization when the test says the token no longer works.

**Run.** `npm run e2e:live` (add `-- --keep` to keep the document, `--seed N` to repeat a plan, `--verbose` for every runner step). Every assertion prints a `PASS`/`FAIL` line, the exit code is non-zero when anything failed, and the document's URL is printed whenever it is kept, including after a failure.

**What it checks.**
- *A. Typing.* Additions are built exactly as the editor builds them (`additions()`), turned into a job exactly as `POST /api/sync/start` does (`src/lib/sync-plan.ts`), and typed by the real runner running in-process with the in-memory store: three segments with headings, bold, italic and a link, a bulleted list nested three levels deep, a numbered list, words typed into the middle of an existing sentence, and a page break, typos and a break included. The runner's waits run on a virtual clock (it takes `now` and `sleep` as dependencies), so a plan that would take minutes finishes in seconds while every delay is still computed. The document is read back with `importDoc` and compared: text, named styles, bold/italic/link runs, list items and levels, page breaks.
- *B. Direct edits.* The document is imported, changed as a user would in the editor (split a heading, remove the bullet from one item, change words mid-sentence, delete the last paragraph, insert a 2×2 table) and saved with `directEdits()`, including the editor's read-back after a table structure change. The document must match the editor's target, saving must converge, and the editor's idea of the saved document must match Google's.
- *C. Collaborator mid-sync.* While the runner is between two batches, another writer inserts a paragraph at the top of the document. The sync must still land its text at the right place (the runner finds its spot again from the text before it).

**Cost and scope.** A run makes a few hundred Docs API requests (one `documents.get` and one `batchUpdate` per typed chunk, plus the deletes and re-inserts of typos), spaced about 700 ms apart to stay inside the Docs API's 60-writes-per-minute quota, so it takes two to four minutes. It never touches any document other than the one it creates. `npm run e2e:live -- --dry-run` runs the same scenarios against an in-memory Docs stub (`scripts/e2e-live/stub-docs.ts`) without Google, and `npm test` does that too, so a failing live run points at Google's behaviour, not at the harness. `.github/workflows/e2e-live.yml` runs it on demand (and weekly) when the three secrets are set, and skips with a notice otherwise.

## Development

```bash
npm run dev        # local server (in-memory store, direct self-calls instead of QStash)
npm test           # planner, runner, document model, import, formatting requests, pagination, page setup, secrets, style, rate limiter, logger, monitor, route wrapper unit tests, live e2e harness against the stub
npm run style:fingerprint   # print the dataset's fingerprint and rules
npm run style:eval -- --loo # run every prompt candidate against the model and rank them
npm run style:compile -- --candidate rules-fewshot   # ship a candidate
npm run typecheck
npm run lint
npm run e2e:live:auth       # once: a refresh token for the live end-to-end test
npm run e2e:live            # the live end-to-end test against Google Docs (see above)
```
