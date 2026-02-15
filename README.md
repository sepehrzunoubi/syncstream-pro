# SyncStream Pro

A SaaS-level utility for **throttled text synchronization into Google Docs**, featuring an obsidian-dark dashboard UI built with the Aceternity Sidebar pattern.

## Tech Stack

- **Framework:** Next.js 14 (App Router), TypeScript
- **Styling:** Tailwind CSS, obsidian-dark theme
- **Animations:** Framer Motion (Aceternity Sidebar)
- **Icons:** Lucide React
- **Backend:** Next.js API Routes
- **Google APIs:** `googleapis` (OAuth2, Docs, Drive)

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

### 3. Set environment variables

Edit `.env.local`:

```env
GOOGLE_CLIENT_ID=your-actual-client-id
GOOGLE_CLIENT_SECRET=your-actual-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/callback
```

### 4. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Architecture

```
src/
├── app/
│   ├── api/
│   │   ├── auth/        # OAuth login, callback, logout, me
│   │   ├── docs/        # List recent Google Docs
│   │   └── stream/      # SSE streaming endpoint (Drip Engine)
│   ├── globals.css      # Obsidian dark theme
│   ├── layout.tsx       # Root layout (Inter + JetBrains Mono)
│   └── page.tsx         # Main page (Aceternity Sidebar + Dashboard)
├── components/
│   ├── dashboard/
│   │   ├── dashboard-view.tsx   # Main dashboard wiring
│   │   ├── hero-status.tsx      # Live status card with progress
│   │   ├── login-screen.tsx     # Google OAuth login
│   │   ├── source-input.tsx     # Text input area
│   │   └── sync-controls.tsx    # Doc picker, rhythm, duration
│   └── ui/
│       └── sidebar.tsx          # Aceternity animated sidebar
├── lib/
│   ├── drip-engine.ts   # Packet splitting, Gaussian jitter
│   ├── google.ts        # OAuth2, Drive, Docs helpers
│   └── utils.ts         # cn() utility
```

## Drip Engine

The streaming engine splits input text into variable-size packets and calculates delays using a **Gaussian distribution** (Box-Muller transform) to simulate natural human writing patterns. Three rhythm profiles are available:

- **Steady** — fast, consistent pace (150-300 char packets, ~4s mean delay)
- **Natural** — balanced flow with moderate jitter (100-250 chars, ~6s)
- **Thoughtful** — slower drafting cadence (80-180 chars, ~12s)

Progress is streamed back to the frontend via **Server-Sent Events (SSE)**.

## Features

- Animated collapsible sidebar (hover to expand)
- Google OAuth2 authentication
- Recent document picker (15 most recent Google Docs)
- Real-time progress with countdown timer, ETA, and byte counter
- 4-card metric row with pulse animation
- Start/Stop/Resume sync controls
- Obsidian-dark aesthetic with neon-glow accents
