# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Run with hot-reload (ts-node-dev)
npm run build        # Compile TypeScript → dist/
npm start            # Run compiled output
npm run type-check   # TypeScript check without emitting
```

Copy `.env.example` to `.env` and fill in credentials before running.

## Architecture

A Slack Bolt (Node.js/TypeScript) app that shows team availability on the **App Home tab** by reading Google Calendar events. Users connect their own Google Calendar via OAuth 2.0; the app reads their events and reports status to the whole team.

### Request flow

1. User opens the App Home tab → `app_home_opened` event → `handlers/app-home.ts`
2. Handler publishes a loading skeleton, then fetches all workspace members (`users.list`) and, for each connected member, their Google Calendar events for the selected date
3. Status is derived: `outOfOffice` event type → OOO; all-day event with OOO keywords → OOO; active timed event (today only) → In Meeting; else Available
4. Block Kit home view is published via `views.publish`
5. User interactions (date navigation, filter buttons, connect/disconnect) fire block actions → `handlers/actions.ts` → re-publishes the view with new state

### Key files

| Path | Purpose |
|------|---------|
| `src/app.ts` | Entry point — wires up Bolt + ExpressReceiver + handlers |
| `src/config/index.ts` | Typed env var access; throws on startup if required vars are missing |
| `src/types/index.ts` | Shared types: `MemberStatus`, `ViewState`, `GoogleTokens`, etc. |
| `src/services/google-calendar.ts` | Google OAuth helpers (`getAuthUrl`, `exchangeCode`) and `getStatusForDate` |
| `src/services/token-store.ts` | Persists OAuth tokens to a JSON file (swap for a DB in production) |
| `src/services/team-status.ts` | Combines `users.list` + calendar lookups into `MemberStatusInfo[]` |
| `src/ui/home-view.ts` | Pure function that returns Slack Block Kit JSON for the App Home |
| `src/handlers/app-home.ts` | `app_home_opened` handler + `publishHomeView` (the central re-render fn) |
| `src/handlers/actions.ts` | All block action handlers (date nav, filters, connect/disconnect) |
| `src/handlers/oauth.ts` | `GET /oauth/google/callback` — completes OAuth and refreshes the home view |

### View state

All interactive state (selected date, active filter) is encoded as JSON in each button's `value` field (`ViewState` type). When any action fires, the handler reads the new state from the button value and calls `publishHomeView(app, userId, state)` to re-render. There is no server-side session state per user.

### Google Calendar status detection

`getStatusForDate` checks in priority order:
1. `eventType === 'outOfOffice'` (Google-native OOO blocks)
2. All-day event whose title contains: `out of office`, `ooo`, `vacation`, `holiday`, `leave`, `pto`, `off`
3. Active timed event (start ≤ now ≤ end, not free/cancelled) — **today only**

The googleapis client auto-refreshes tokens when they expire (via the `tokens` event); refreshed tokens are persisted back to the store.

### Slack app setup

Import `slack-manifest.json` at https://api.slack.com/apps to create the app with the correct scopes and event subscriptions pre-configured.

Required bot scopes: `users:read`, `users:read.email`, `chat:write`, `im:write`
Required event: `app_home_opened`

### Google Cloud setup

1. Create an OAuth 2.0 Client ID (Web application) in Google Cloud Console
2. Add the redirect URI to "Authorized redirect URIs" (must match `GOOGLE_REDIRECT_URI` exactly)
3. Enable the **Google Calendar API** for the project
4. For local dev use `http://localhost:3000/oauth/google/callback`; production requires HTTPS

### Token storage

`tokens.json` is a flat JSON map of `slackUserId → UserTokenRecord`. It is created automatically on first connect. For multi-instance or production deployments, replace `src/services/token-store.ts` with a database-backed implementation — the interface (`saveTokens`, `getTokenRecord`, `removeTokens`, `isConnected`, `getAllConnectedUsers`) stays the same.

### Tunneling for local development

Slack and Google both require a publicly accessible URL. Use ngrok or a similar tool:
```bash
ngrok http 3000
```
Update `GOOGLE_REDIRECT_URI` in `.env` and the event/interactivity URLs in `slack-manifest.json` with the ngrok URL. Re-install the Slack app if you change the manifest.
