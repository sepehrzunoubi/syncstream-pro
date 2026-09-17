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
│   │   ├── cron/        # sync-watchdog (re-kicks stalled jobs)
│   │   ├── docs/        # List recent Google Docs, create a doc
│   │   ├── stream/      # Legacy SSE streaming endpoint
│   │   ├── sync/        # start / status / pause / resume / cancel / process / source
│   │   └── wordcount/   # Word count of a target doc
│   ├── dashboard/       # Authenticated dashboard (sidebar + settings)
│   ├── privacy/, tos/   # Legal pages
│   ├── globals.css      # Obsidian dark theme
│   ├── layout.tsx       # Root layout (Inter + JetBrains Mono)
│   └── page.tsx         # Landing page with Google sign-in
├── components/
│   ├── dashboard/
│   │   ├── dashboard-view.tsx   # Main dashboard wiring
│   │   ├── hero-status.tsx      # Live status card with progress
│   │   ├── login-screen.tsx     # Landing / Google OAuth login
│   │   ├── source-input.tsx     # Text input area
│   │   └── sync-controls.tsx    # Doc picker, rhythm, duration
│   └── ui/                      # Sidebar, button, slider, tooltip, particles
├── lib/
│   ├── drip-engine.ts   # Packet splitting, pacing, typos, pauses
│   ├── google.ts        # OAuth2, Drive, Docs helpers
│   ├── qstash.ts        # QStash client / receiver / enqueue helper
│   ├── sync-store.ts    # Redis-backed job + payload store
│   └── utils.ts         # cn() utility
└── middleware.ts        # Redirects between / and /dashboard based on auth cookies
```

## How a sync runs

1. `POST /api/sync/start` builds a drip plan from the source text and stores the job and its payload in Redis.
2. The plan is handed to `POST /api/sync/process` through QStash. The process route types actions into the doc, persists progress after every action, and re-enqueues itself before the function timeout or for long pauses.
3. The dashboard polls `GET /api/sync/status` and can pause, resume, or cancel the job.
4. The daily cron watchdog re-kicks any job that stopped updating and cleans up finished jobs.

## Drip Engine

The engine splits input text into variable-size packets and calculates delays using a **Gaussian distribution** (Box-Muller transform) to simulate natural human writing patterns, with optional simulated typos and corrections, and mandatory long pauses in burst modes.

## Features

- Animated collapsible sidebar (hover to expand)
- Google OAuth2 authentication, open to any Google account
- Recent document picker and one-click doc creation
- Real-time progress with countdown timer, ETA, and word counter
- Start / Pause / Resume / Cancel / Schedule controls
- Session restore after closing the tab
- Obsidian-dark aesthetic with neon-glow accents
