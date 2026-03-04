# Team Calendar Slack App

A Slack app that shows your team's real-time availability by reading Google Calendar. See who's **Out of Office**, who's **In a Meeting**, and who's available — all from the App Home tab.

![App Home](https://via.placeholder.com/800x400?text=Team+Calendar+App+Home)

## Features

- **Team status dashboard** — see every workspace member's availability at a glance
- **Out of Office detection** — reads Google Calendar's native OOO blocks and all-day events (vacation, PTO, holiday, etc.)
- **In Meeting detection** — shows the meeting name and time for anyone currently in a call
- **Date navigation** — browse any day (past or future) with Prev/Today/Next
- **Status filters** — filter to only show OOO or In Meeting members
- **Per-user Google OAuth** — each person connects their own Google Calendar; no admin/service account needed
- **Auto token refresh** — Google OAuth tokens are refreshed automatically in the background

## How It Works

Each team member connects their Google Calendar once via OAuth. From then on, when anyone opens the App Home tab, the app fetches everyone's calendar events for the selected day and reports their status in real time.

Status priority order:
1. **Out of Office** — Google-native OOO event, or any all-day event containing: `out of office`, `ooo`, `vacation`, `holiday`, `leave`, `pto`, `off`
2. **In a Meeting** — active timed event right now (today only), not marked as free/cancelled
3. **Available**

## Setup

### Prerequisites

- Node.js 18+
- A Slack workspace where you can install apps
- A Google Cloud project with the Calendar API enabled

### 1. Clone & install

```bash
git clone https://github.com/sushilsainju/slack-calendar.git
cd slack-calendar
npm install
cp .env.example .env
```

### 2. Create the Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From a manifest** → paste the contents of [`slack-manifest.json`](./slack-manifest.json).

From the app settings copy into `.env`:
- `SLACK_BOT_TOKEN` — OAuth & Permissions → Bot User OAuth Token
- `SLACK_SIGNING_SECRET` — Basic Information → Signing Secret

### 3. Create a Google OAuth client

1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Library → enable **Google Calendar API**
2. APIs & Services → Credentials → **Create Credentials → OAuth 2.0 Client ID** (Web application)
3. Add your tunnel/server URL to **Authorized redirect URIs**:
   ```
   https://your-tunnel-url.com/oauth/google/callback
   ```
4. Copy into `.env`:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI`

### 4. Expose localhost (development)

Slack and Google both require a public HTTPS URL. Use [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) (no account needed):

```bash
cloudflared tunnel --url http://localhost:3001
```

Copy the `https://*.trycloudflare.com` URL and:
- Set it as the **Event Subscriptions** request URL in your Slack app: `https://your-url/slack/events`
- Set it as the **Interactivity & Shortcuts** request URL: `https://your-url/slack/events`
- Set `GOOGLE_REDIRECT_URI=https://your-url/oauth/google/callback` in `.env`
- Add the same redirect URI to Google Cloud Console

### 5. Run

```bash
npm run dev
```

Then reinstall the Slack app (**Install App → Reinstall to Workspace**) and open the **Home tab** in Slack.

## Development

```bash
npm run dev        # Start with hot-reload
npm run build      # Compile TypeScript → dist/
npm start          # Run compiled output
npm run type-check # TypeScript check without emitting
```

## Project Structure

```
src/
├── app.ts                  # Entry point
├── config/index.ts         # Environment config
├── types/index.ts          # Shared TypeScript types
├── services/
│   ├── google-calendar.ts  # Google OAuth + calendar status fetching
│   ├── token-store.ts      # OAuth token persistence (JSON file)
│   └── team-status.ts      # Combines Slack user list + calendar lookups
├── ui/
│   └── home-view.ts        # Block Kit home tab builder
└── handlers/
    ├── app-home.ts         # app_home_opened event handler
    ├── actions.ts          # Button action handlers
    └── oauth.ts            # Google OAuth callback route
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Used to verify requests from Slack |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret |
| `GOOGLE_REDIRECT_URI` | Must match exactly what's in Google Cloud Console |
| `PORT` | Server port (default: `3001`) |
| `TOKEN_STORE_PATH` | Path to token JSON file (default: `./tokens.json`) |

## Production Notes

- **Token storage** — `tokens.json` is a flat file store, fine for small teams. For production, replace `src/services/token-store.ts` with a database-backed implementation (the interface stays the same).
- **Tunnel** — replace Cloudflare Quick Tunnel with a proper domain + HTTPS server (Railway, Render, Fly.io, etc.). Update the Slack app URLs and Google redirect URI accordingly.
- **Team size** — the app fetches calendar status for all connected members in parallel. Works well for teams up to ~100 people.
