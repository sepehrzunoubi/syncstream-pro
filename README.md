# SyncStream Pro

A utility for **human-cadence text synchronization into Google Docs**, featuring an obsidian-dark dashboard UI built with the Aceternity Sidebar pattern.

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

`/api/sync/process` declares `maxDuration = 300`. If your Vercel plan caps function duration lower, reduce that value; the route chains itself well before the limit.

## Architecture

```
src/
├── app/
│   ├── api/
│   │   ├── auth/        # OAuth login, callback, logout, me
│   │   ├── cron/        # sync-watchdog (daily safety net for lost queue messages)
│   │   ├── docs/        # List recent Google Docs, create a doc
│   │   ├── health/      # Live check of every configured service (signed-in users)
│   │   └── sync/        # start / list / status / pause / resume / cancel / dismiss / source / process
│   ├── dashboard/       # Authenticated workspace (layout loads fonts, docs.css holds the Docs styles)
│   ├── privacy/, tos/   # Legal pages
│   └── page.tsx         # Landing page with Google sign-in
├── components/
│   ├── workspace/
│   │   ├── workspace.tsx        # State and layout of the dashboard
│   │   ├── header.tsx           # Target doc picker, Start sync, account menu
│   │   ├── toolbar.tsx          # Docs formatting toolbar
│   │   ├── menubar.tsx          # File / Edit / View / Format menus
│   │   ├── ruler.tsx            # Ruler with draggable indent markers
│   │   ├── extensions.ts        # Editor (TipTap) setup: paragraph styles, indents, fonts, paste
│   │   ├── sync-panel.tsx       # Total time, breaks, typos, start time, plan
│   │   ├── job-panel.tsx        # Status and controls of a running sync
│   │   ├── progress-page.tsx    # Read-only page showing what has been typed
│   │   └── sync-rail.tsx        # List of syncs
│   ├── dashboard/login-screen.tsx  # Landing page
│   └── ui/                      # Button, particles
├── lib/
│   ├── drip-engine.ts   # Seeded planner: chunks, pauses, typos, breaks, target duration
│   ├── rich-text.ts     # Formatting model and the Docs formatting requests for any text range
│   ├── sync-runner.ts   # Queue-driven worker: bounded windows, lock, idempotent writes, retries
│   ├── sync-store.ts    # Redis-backed plans, jobs, per-user index, locks, control intents
│   ├── sync-api.ts      # Ownership checks and lock-aware job mutations for the routes
│   ├── auth.ts          # Cookie helpers and user resolution
│   ├── google.ts        # OAuth2, Drive, Docs helpers
│   ├── qstash.ts        # QStash client / receiver / enqueue helper
│   └── base-url.ts      # Public origin resolution
└── middleware.ts        # Redirects between / and /dashboard based on auth cookies
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

The dashboard is laid out like Google Docs: a File, Edit, View and Format menu bar, the formatting toolbar, a ruler with draggable indent markers, the page in the middle, your syncs on the left and the sync settings on the right. Animations use Framer Motion and turn off when the system asks for reduced motion.

- **Formatting.** Paragraph styles (Normal text, Title, Subtitle, Headings 1 to 3), fonts, sizes in points, bold, italic, underline, strikethrough, alignment, line spacing, indents and first-line indent (Tab at the start of a paragraph). The same shortcuts as Docs work. Pasting from Google Docs or Word keeps this formatting; lists are pasted as paragraphs that keep their bullets or numbers as text. Every chunk is typed into the Google Doc together with its formatting in a single API call.

- **Total time.** Auto types at a natural pace (roughly 35 words per minute plus pauses). A target duration is met exactly: a longer target inserts away-time between paragraphs, a shorter one drops automatic breaks and types faster, down to a realistic floor.
- **Breaks.** Auto picks a few based on text length, None disables them, Custom lets you choose up to eight from 5 minutes to 3 hours. They run in order, spread through the text at paragraph or sentence ends.
- **Typos.** From rare to frequent. Each typo types a plausible slip, waits briefly, deletes it and types the correct words.
- **Start.** Now, or in 5 minutes to 12 hours. Scheduled syncs run on the server.
- **Several at once.** Start as many syncs as you like, each to its own document. The strip above the editor lets you switch between them.

## Development

```bash
npm run dev        # local server (in-memory store, direct self-calls instead of QStash)
npm test           # planner and runner unit tests
npm run typecheck
npm run lint
```
