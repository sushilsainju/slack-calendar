# Phase 2 — Multi-Workspace Support

## What Changed

### Slack OAuth V2 Install Flow
The app now supports installation in any Slack workspace via the standard "Add to Slack" OAuth flow. Previously it was hardcoded to a single workspace via `SLACK_BOT_TOKEN`. Each installed workspace gets its own encrypted bot token stored in Postgres.

- Install landing page at `GET /`
- Slack handles the OAuth flow at `GET /slack/install` and `GET /slack/oauth_redirect`
- Bot token per workspace stored encrypted (AES-256-GCM) in the `installations` table

### New Database Tables

**`installations`** — one row per installed workspace
- `team_id`, `team_name`, `bot_token` (encrypted), `bot_user_id`, `installed_by`, `installed_at`, `uninstalled_at`

**`workspaces`** — workspace settings and tier tracking (used by Phase 3)
- `team_id`, `tier` (free/pro/business), `stripe_customer`, `stripe_sub_id`, `trial_ends_at`, `digest_enabled`, `digest_time`, `timezone`, `notify_channel_id`, `custom_ooo_keywords`

### All Data Scoped by `team_id`
User tokens, roster cache, and status cache are now scoped per workspace. A user in workspace A cannot see data from workspace B.

- `user_tokens` primary key changed from `(slack_user_id)` to `(team_id, slack_user_id)`
- All token store functions (`saveTokens`, `getTokenRecord`, `removeTokens`, `isConnected`, `getAllConnectedUsers`) take `teamId` as first param
- Roster cache key: `roster:{teamId}` — previously `roster:main`
- Status cache key: `status:{teamId}:{slackUserId}:{dateStr}`

### Lifecycle Events
- `app_uninstalled` — marks the installation as deleted, removes all user tokens for that workspace, invalidates roster cache
- `team_join` — invalidates the roster cache so the new member appears immediately

### Phase 1→2 Migration (Existing Workspace)
Existing single-workspace deployments are migrated automatically on startup:
1. `SLACK_TEAM_ID` env var triggers `migrateV1ToV2()` which backfills `team_id` on existing `user_tokens` rows
2. `SLACK_BOT_TOKEN` (if set alongside `SLACK_TEAM_ID`) triggers `seedLegacyInstallation()` which creates the `installations` row for the existing workspace

Both are safe to run multiple times (idempotent). Remove `SLACK_BOT_TOKEN` and `SLACK_TEAM_ID` from env after confirming migration.

## New Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_CLIENT_ID` | Yes | From api.slack.com → Basic Information |
| `SLACK_CLIENT_SECRET` | Yes | Same page |
| `SLACK_STATE_SECRET` | Yes | Random string — `openssl rand -hex 32` |
| `SLACK_TEAM_ID` | Migration only | Existing workspace team ID — remove after migration |
| `SLACK_BOT_TOKEN` | Migration only | Legacy bot token for seeding — remove after migration |

## Removed Environment Variables
- `SLACK_BOT_TOKEN` — no longer used after migration is complete

## New Slack App Config Required
- Add OAuth redirect URL in api.slack.com → OAuth & Permissions:
  `https://slack-calendar-production.up.railway.app/slack/oauth_redirect`
- Import updated `slack-manifest.json` to add `app_uninstalled` and `team_join` event subscriptions

## Branch
`phase-2-multi-workspace` — not yet merged to `main`
