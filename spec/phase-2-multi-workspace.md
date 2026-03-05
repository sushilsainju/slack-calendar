# Phase 2 — Multi-Workspace Support

**Duration:** 3–4 weeks
**Prerequisite:** Phase 1 complete
**Goal:** Support installation in any Slack workspace. Replace the hardcoded single bot token with Bolt's `installationStore` pattern. This is required before any public distribution or paid tiers.

---

## 2.1 Why This Is Required

The current app uses a single `SLACK_BOT_TOKEN` env var, which means it can only ever serve one workspace. To:
- List on the Slack App Directory
- Accept payment from multiple workspaces
- Allow any team to install the app

…the app must support Slack's OAuth V2 install flow, which issues a unique bot token per workspace. Bolt has built-in support for this via `InstallProvider` and `installationStore`.

---

## 2.2 New Database Tables

```sql
-- Stores one record per installed workspace
CREATE TABLE installations (
  team_id        TEXT PRIMARY KEY,
  team_name      TEXT,
  bot_token      TEXT NOT NULL,   -- encrypted (same AES-256-GCM as token store)
  bot_user_id    TEXT NOT NULL,
  installed_by   TEXT,            -- Slack user ID who performed install
  installed_at   TIMESTAMPTZ DEFAULT NOW(),
  uninstalled_at TIMESTAMPTZ      -- set on app_uninstalled event; NULL = active
);

-- Workspaces table (tier tracking — used by Phase 3)
CREATE TABLE workspaces (
  team_id               TEXT PRIMARY KEY REFERENCES installations(team_id),
  tier                  TEXT NOT NULL DEFAULT 'free',  -- 'free' | 'pro' | 'business'
  stripe_customer       TEXT,
  stripe_sub_id         TEXT,
  trial_ends_at         TIMESTAMPTZ,
  digest_enabled        BOOLEAN DEFAULT false,
  digest_time           TEXT    DEFAULT '08:30',
  timezone              TEXT    DEFAULT 'UTC',
  notify_channel_id     TEXT,
  custom_ooo_keywords   TEXT[]  DEFAULT '{}',
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Scope user_tokens by team (migration handled by 2.9)
ALTER TABLE user_tokens ADD COLUMN team_id TEXT NOT NULL DEFAULT '';
ALTER TABLE user_tokens DROP CONSTRAINT user_tokens_pkey;
ALTER TABLE user_tokens ADD PRIMARY KEY (team_id, slack_user_id);
CREATE INDEX ON user_tokens (team_id);
```

---

## 2.3 Installation Store

**`src/services/installation-store.ts`** (new file)

Implements Bolt's `InstallationStore` interface backed by Postgres.

### `fetchInstallation` error contract
If no active installation exists for the given `teamId`, throw `new Error(...)`. Bolt catches this error internally and returns an appropriate HTTP error to Slack. Do **not** return `undefined` — Bolt's TypeScript types require either a valid `Installation` or a thrown error.

```typescript
import { InstallationStore, Installation } from '@slack/bolt';
import { encryptJson, decryptJson } from '../utils/crypto';
import { pool } from './token-store';
import { logger } from '../utils/logger';

export const installationStore: InstallationStore = {
  async storeInstallation(installation) {
    const teamId = installation.team?.id;
    if (!teamId) throw new Error('No team ID in installation');

    const encryptedBotToken = encryptJson(installation.bot?.token);

    await pool!.query(
      `INSERT INTO installations (team_id, team_name, bot_token, bot_user_id, installed_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (team_id) DO UPDATE
         SET bot_token      = EXCLUDED.bot_token,
             bot_user_id    = EXCLUDED.bot_user_id,
             installed_by   = EXCLUDED.installed_by,
             uninstalled_at = NULL`,
      [
        teamId,
        installation.team?.name,
        encryptedBotToken,
        installation.bot?.userId,
        installation.user.id,
      ]
    );

    // Create workspace record with 14-day trial (idempotent — DO NOTHING if exists)
    await pool!.query(
      `INSERT INTO workspaces (team_id, tier, trial_ends_at)
       VALUES ($1, 'free', NOW() + INTERVAL '14 days')
       ON CONFLICT (team_id) DO NOTHING`,
      [teamId]
    );

    logger.info({ teamId, installedBy: installation.user.id }, 'App installed');
  },

  async fetchInstallation(query) {
    const teamId = query.teamId;
    if (!teamId) throw new Error('fetchInstallation called without teamId');

    const { rows } = await pool!.query(
      `SELECT bot_token, bot_user_id FROM installations
       WHERE team_id = $1 AND uninstalled_at IS NULL`,
      [teamId]
    );

    if (!rows[0]) {
      // Throw so Bolt returns 401 to Slack — do not return undefined
      throw new Error(`No active installation found for team ${teamId}`);
    }

    let botToken: string;
    try {
      botToken = decryptJson<string>(rows[0].bot_token);
    } catch (err) {
      logger.error({ teamId, err }, 'Failed to decrypt bot token');
      throw new Error(`Bot token decryption failed for team ${teamId}`);
    }

    return {
      team: { id: teamId },
      bot: {
        token: botToken,
        userId: rows[0].bot_user_id,
      },
    } as Installation;
  },

  async deleteInstallation(query) {
    await pool!.query(
      `UPDATE installations SET uninstalled_at = NOW() WHERE team_id = $1`,
      [query.teamId]
    );
    logger.info({ teamId: query.teamId }, 'Installation marked uninstalled');
  },
};

/** Returns all active installations with a web client for each. Used by scheduled jobs. */
export async function getAllInstallations(): Promise<Array<{ teamId: string; botToken: string }>> {
  const { rows } = await pool!.query(
    `SELECT team_id, bot_token FROM installations WHERE uninstalled_at IS NULL`
  );
  return rows.map(row => ({
    teamId: row.team_id,
    botToken: decryptJson<string>(row.bot_token),
  }));
}
```

---

## 2.4 Update `app.ts` — Enable OAuth Install Flow

```typescript
import { App, ExpressReceiver } from '@slack/bolt';
import { installationStore } from './services/installation-store';

const receiver = new ExpressReceiver({
  signingSecret: config.slack.signingSecret,
  clientId: config.slack.clientId,
  clientSecret: config.slack.clientSecret,
  stateSecret: config.slack.stateSecret,   // random string for Slack OAuth state param
  scopes: ['users:read', 'users:read.email', 'chat:write', 'im:write'],
  installationStore,
  installerOptions: {
    directInstall: true,               // skip intermediate page
    redirectUriPath: '/slack/oauth_redirect',
  },
});

// Bolt auto-registers:
//   GET  /slack/install          → Slack OAuth start
//   GET  /slack/oauth_redirect   → Slack OAuth callback
//   POST /slack/events           → event/action handler
```

Remove `token: config.slack.botToken` from the `App` constructor — Bolt now resolves the correct token per-workspace from the `installationStore`.

### New environment variables
```
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_STATE_SECRET=<random string>   # e.g. openssl rand -hex 32
```

### Removed environment variable
```
# No longer used — remove from .env and config.ts:
SLACK_BOT_TOKEN=...
```

### Bot token refresh failure
If `fetchInstallation` throws (token decryption failure, DB error), Bolt will catch the error and return HTTP 500 to Slack. Slack will retry the event delivery up to 3 times. Log the error at `error` level. Do **not** silently return a null/undefined token — this would cause hard-to-debug "missing token" errors downstream.

---

## 2.5 Scope Token Store by `team_id`

All token store functions gain a `teamId` parameter. Update every call site.

### Files changed
- `src/services/token-store.ts`
- All callers: `src/handlers/app-home.ts`, `src/handlers/actions.ts`, `src/handlers/oauth.ts`, `src/services/team-status.ts`

```typescript
export async function saveTokens(
  teamId: string,
  slackUserId: string,
  googleEmail: string,
  tokens: GoogleTokens,
): Promise<void>

export async function getTokenRecord(
  teamId: string,
  slackUserId: string,
): Promise<UserTokenRecord | undefined>

export async function removeTokens(
  teamId: string,
  slackUserId: string,
): Promise<void>

export async function isConnected(
  teamId: string,
  slackUserId: string,
): Promise<boolean>

export async function getAllConnectedUsers(
  teamId: string,
): Promise<UserTokenRecord[]>
```

Every caller obtains `teamId` from the Bolt event/action context:
```typescript
// In any Bolt handler:
const teamId = body.team_id ?? body.team?.id;
if (!teamId) throw new Error('Missing team_id in event body');
```

---

## 2.6 Scope `getTeamStatuses` by Workspace

`team-status.ts` currently uses the single app-level client. In multi-workspace mode, each call needs the workspace-specific client from Bolt's handler args.

### Files changed
- `src/services/team-status.ts`
- `src/handlers/app-home.ts`
- `src/handlers/actions.ts`

**Updated `publishHomeView` signature:**
```typescript
import { WebClient } from '@slack/web-api';

export async function publishHomeView(
  client: WebClient,
  teamId: string,
  userId: string,
  state: ViewState,
): Promise<void>
```

**In `app_home_opened` handler:**
```typescript
app.event('app_home_opened', async ({ event, client, body }) => {
  if (event.tab !== 'home') return;
  const teamId = body.team_id;
  const state: ViewState = { date: todayStr(), filter: 'all', page: 0 };
  await publishHomeView(client, teamId, event.user, state);
});
```

Note: `client` from Bolt handler args already has the correct bot token for this workspace — do not use `app.client`.

---

## 2.7 Handle `app_uninstalled` Event

When a workspace uninstalls the app, clean up their data.

### Files changed
- `src/handlers/app-home.ts` (or a dedicated `src/handlers/lifecycle.ts`)
- `slack-manifest.json` (add `app_uninstalled` to `bot_events`)

```typescript
app.event('app_uninstalled', async ({ body }) => {
  const teamId = body.team_id;
  try {
    await installationStore.deleteInstallation({ teamId, enterpriseId: undefined });
    // Delete all user tokens for the team
    await pool!.query('DELETE FROM user_tokens WHERE team_id = $1', [teamId]);
    logger.info({ teamId }, 'App uninstalled — installation and tokens removed');
  } catch (err) {
    // app_uninstalled fires asynchronously — Slack does not retry on failure.
    // Treat as best-effort: log the failure but do not throw.
    logger.error({ teamId, err }, 'Cleanup failed after app_uninstalled — manual cleanup may be required');
  }
});
```

**Important:** `app_uninstalled` fires asynchronously. Slack does not wait for acknowledgement and does not retry. This means cleanup is best-effort. If the DB is temporarily unavailable when uninstall fires, tokens will remain until the next scheduled cleanup job (add a periodic "orphan token cleanup" task if data hygiene is critical).

---

## 2.8 Update Slack App Manifest

```json
{
  "oauth_config": {
    "redirect_urls": ["https://your-domain.com/slack/oauth_redirect"],
    "scopes": {
      "bot": ["users:read", "users:read.email", "chat:write", "im:write"]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://your-domain.com/slack/events",
      "bot_events": ["app_home_opened", "app_uninstalled", "team_join"]
    },
    "interactivity": {
      "is_enabled": true,
      "request_url": "https://your-domain.com/slack/events"
    }
  }
}
```

---

## 2.9 Database Migration Strategy

Because existing workspaces have data in the old schema (no `team_id`), the migration must backfill `team_id` before adding the primary key constraint. Run this **before** deploying the Phase 2 code.

### Files changed
- `src/services/token-store.ts` (add `migrateV1ToV2` call in `initTokenStore`)

```typescript
// In initTokenStore():
// SLACK_TEAM_ID must be set in .env during the Phase 1 → Phase 2 transition.
// It is the single-workspace team ID from before multi-workspace support.
// Remove this env var after migration is confirmed complete.
const knownTeamId = process.env.SLACK_TEAM_ID;
if (knownTeamId) {
  await migrateV1ToV2(knownTeamId);
}

async function migrateV1ToV2(knownTeamId: string): Promise<void> {
  const { rows } = await pool!.query(
    `SELECT COUNT(*) FROM user_tokens WHERE team_id = ''`
  );
  const count = parseInt(rows[0].count, 10);
  if (count === 0) return; // already migrated or no rows exist

  logger.info({ knownTeamId, count }, 'Migrating v1 tokens to multi-workspace schema...');
  await pool!.query(
    `UPDATE user_tokens SET team_id = $1 WHERE team_id = ''`,
    [knownTeamId]
  );
  logger.info({ knownTeamId, count }, 'Migration complete');
}
```

### Migration steps (in order)

1. **Back up the database** before any schema changes
2. Run `ALTER TABLE user_tokens ADD COLUMN team_id TEXT NOT NULL DEFAULT ''`
3. Deploy Phase 2 code (includes `migrateV1ToV2` logic) with `SLACK_TEAM_ID` set
4. Verify migration ran: `SELECT COUNT(*) FROM user_tokens WHERE team_id = ''` → should return 0
5. Run `ALTER TABLE user_tokens DROP CONSTRAINT user_tokens_pkey; ALTER TABLE user_tokens ADD PRIMARY KEY (team_id, slack_user_id);`
6. Create the `installations` row for the existing workspace manually (or via a one-time script)
7. Remove `SLACK_TEAM_ID` from `.env` after confirmed

### Testing migration without data loss

- Run against a staging database copy first
- Verify row count is unchanged: `SELECT COUNT(*) FROM user_tokens` before and after
- Verify at least one existing user can still load their calendar after migration
- If any step fails, restore from backup and investigate before retrying

---

## 2.10 Install Page

Add a simple install landing page at `GET /`. Bolt generates the install URL automatically at `/slack/install`.

```typescript
receiver.router.get('/', (_req, res) => {
  res.send(`
    <html>
      <head><meta charset="utf-8"><title>Team Calendar</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:80px">
        <h1>Team Calendar</h1>
        <p>See who's out of office or in a meeting — right in Slack.</p>
        <a href="/slack/install">
          <img alt="Add to Slack" src="https://platform.slack-edge.com/img/add_to_slack.png" />
        </a>
      </body>
    </html>
  `);
});
```

---

## Testing Checklist

- [ ] Install app in a second Slack workspace → both workspaces show their own data independently
- [ ] User connects Google Calendar in workspace A → `getTokenRecord('teamA', userId)` returns record; `getTokenRecord('teamB', userId)` returns undefined
- [ ] Uninstall from workspace A → `installations.uninstalled_at` is set; `user_tokens` rows for that team are deleted
- [ ] `fetchInstallation` with unknown `teamId` throws an `Error` (not returns undefined)
- [ ] Bot token is encrypted in the `installations` table (contains `:` separators, not a raw JWT)
- [ ] Old `SLACK_BOT_TOKEN` env var removed from `.env.example` and `config.ts`
- [ ] `team_join` event fires → `rosterCache.invalidate('roster:' + teamId)` is called
- [ ] Migration: existing rows get correct `team_id`; no data loss
- [ ] `app_uninstalled` with DB temporarily unavailable → error logged, no unhandled rejection
- [ ] Two simultaneous `app_home_opened` events for different workspaces → each gets the correct bot token from `fetchInstallation`

## Definition of Done

App installs cleanly in any Slack workspace via the OAuth flow. All data is scoped by `team_id`. Uninstall marks the installation as deleted and removes user tokens. The hardcoded `SLACK_BOT_TOKEN` is removed from `config.ts`. `migrateV1ToV2` has been run and verified on staging.
