# SyncStream Pro

A utility for **human-cadence text synchronization into Google Docs**, featuring an obsidian-dark dashboard UI built with the Aceternity Sidebar pattern. A second tab, the **Style engine**, rewrites text in a house style learned from a developer-curated dataset of input/output pairs and served by a local Llama model.

Sign in with any Google account and start syncing. There is no license key or allow-list.

## Tech Stack

- **Framework:** Next.js 14 (App Router), TypeScript
- **Styling:** Tailwind CSS, obsidian-dark theme
- **Animations:** Framer Motion (Aceternity Sidebar), tsParticles
- **Icons:** Lucide React
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

## Architecture

```
src/
├── app/
│   ├── api/
│   │   ├── auth/        # OAuth login, callback, logout, me
│   │   ├── cron/        # sync-watchdog (daily safety net for lost queue messages)
│   │   ├── docs/        # List recent Google Docs, create a doc, read a doc, save edits to it
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
│   │   ├── menubar.tsx          # File / Edit / View / Insert / Format menus
│   │   ├── insert-popovers.tsx  # Link and image dialogs
│   │   ├── color-menu.tsx       # Text and highlight colour palettes
│   │   ├── image-upload.ts      # Downscale and upload images
│   │   ├── ruler.tsx            # Ruler with draggable indent markers
│   │   ├── extensions.ts        # Editor (TipTap) setup: paragraph styles, indents, fonts, lists, images, paste
│   │   ├── pagination.ts        # Splits the document into US Letter pages; marks typing progress
│   │   ├── doc-sync.ts          # New text glows as an addition; list numbers; locked tables
│   │   ├── paged-surface.tsx    # Draws the page sheets behind the editor
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
│   ├── doc-import.ts    # Reads an existing Google Doc into the editor
│   ├── doc-model.ts     # Compares the editor with the saved doc: direct edits to save, additions to sync
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

- **Documents that already have text.** Pick a document and it opens on the page, fully editable. Formatting, deleting and restructuring existing text saves straight to Google Docs, like Docs autosave. Anything you type or paste is new text: it glows until a sync types it in, and you can add it in as many places as you like. Start sync types every glowing addition, top to bottom, each at its own spot. While it runs, the worker finds each spot again before every edit, so changes elsewhere in the document don't throw it off. Tables, smart chips and section breaks are shown but can't be edited here. Additions are kept on this device per document until they are synced. If the document changes in Google Docs, SyncStream reloads it and puts your additions back where they were.
- **Pages.** The editor splits your text into US Letter pages with one-inch margins, like Docs. File > Page setup switches to Pageless. Narrow screens always use pageless. While a sync runs, the same paginated page shows what has been typed so far, with a caret at the current position.
- **Formatting.** Paragraph styles (Normal text, Title, Subtitle, Headings 1 to 3), fonts, sizes in points, bold, italic, underline, strikethrough, text colour, highlight, links, alignment, line spacing, indents and first-line indent (Tab at the start of a paragraph). The toolbar also has undo, redo, print, spell check and paint format. The same shortcuts as Docs work. Pasting from Google Docs or Word keeps this formatting. Every chunk is typed into the Google Doc together with its formatting in a single API call.
- **Lists.** Bulleted, numbered and checklists, from the toolbar, the Format menu, or by typing "- ", "1. " or "[] ". They become real Docs lists. Nested lists are flattened to one level, and checklist items are created unchecked because the Docs API cannot tick them.
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

## Development

```bash
npm run dev        # local server (in-memory store, direct self-calls instead of QStash)
npm test           # planner, runner, style-metrics, fingerprint and style-lab unit tests
npm run style:fingerprint   # print the dataset's fingerprint and rules
npm run style:eval -- --loo # run every prompt candidate against the model and rank them
npm run style:compile -- --candidate rules-fewshot   # ship a candidate
npm run typecheck
npm run lint
```
