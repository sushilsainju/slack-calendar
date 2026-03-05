# Phase 1 — Security & Stability

**Duration:** 2–3 weeks
**Prerequisite:** None — start immediately
**Goal:** Make the app safe to run publicly and reliably at scale.

---

## 1.1 Fix OAuth CSRF Vulnerability

### Overview
`src/services/google-calendar.ts` passes the raw `slackUserId` as the OAuth `state` parameter. An attacker can craft a callback URL with any `slackUserId` and link their own Google Calendar to a victim's Slack account.

### Solution
Generate a cryptographic nonce per OAuth initiation, store it server-side with a short TTL, verify it on callback.

### Files changed
- `src/services/google-calendar.ts`
- `src/handlers/oauth.ts`
- `src/services/oauth-state.ts` (new)
- `src/services/token-store.ts` (add `pending_oauth_states` to `initTokenStore`)

### New table
```sql
CREATE TABLE pending_oauth_states (
  nonce         TEXT PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-expire index
CREATE INDEX ON pending_oauth_states (created_at);
```

### Implementation

**`src/services/oauth-state.ts`** (new file)
```typescript
import crypto from 'crypto';
import { pool } from './token-store'; // re-use pool

export async function createOAuthState(slackUserId: string): Promise<string> {
  const nonce = crypto.randomBytes(32).toString('hex');
  await pool!.query(
    `INSERT INTO pending_oauth_states (nonce, slack_user_id) VALUES ($1, $2)`,
    [nonce, slackUserId]
  );
  // Clean up states older than 10 minutes on each insert (cheap enough)
  await pool!.query(
    `DELETE FROM pending_oauth_states WHERE created_at < NOW() - INTERVAL '10 minutes'`
  );
  return nonce;
}

export async function consumeOAuthState(nonce: string): Promise<string | null> {
  const { rows } = await pool!.query(
    `DELETE FROM pending_oauth_states
     WHERE nonce = $1 AND created_at > NOW() - INTERVAL '10 minutes'
     RETURNING slack_user_id`,
    [nonce]
  );
  return rows[0]?.slack_user_id ?? null;
}
```

**`src/services/google-calendar.ts`** — update `getAuthUrl`:
```typescript
// Before:
state: slackUserId,

// After:
state: await createOAuthState(slackUserId),
```

**`src/handlers/oauth.ts`** — update callback:
```typescript
const { code, state: nonce, error } = req.query;
if (!nonce || typeof nonce !== 'string') {
  return res.status(400).send(html('❌ Bad Request', '<p>Missing state parameter.</p>'));
}
const slackUserId = await consumeOAuthState(nonce);
if (!slackUserId) {
  return res.status(400).send(html('❌ Link Expired', '<p>This authorization link has expired or was already used. Please try again from Slack.</p>'));
}
```

**Error handling:**
- If `consumeOAuthState` throws (DB error): catch, log with `{ nonce, err }`, return 500 with generic "Something went wrong" HTML
- If `nonce` is missing from query: return 400 immediately before any DB call

---

## 1.2 Fix XSS in OAuth Callback

### Overview
`src/handlers/oauth.ts` interpolates the `error` query parameter directly into HTML without escaping. Any user-supplied query parameter must be escaped before rendering.

### Files changed
- `src/handlers/oauth.ts`
- `src/utils/html.ts` (new)

### Implementation

**`src/utils/html.ts`** (new file)
```typescript
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
```

**`src/handlers/oauth.ts`** — apply to all user-supplied values:
```typescript
import { escapeHtml } from '../utils/html';

// In error path:
`<p>${escapeHtml(String(error || 'Missing required parameters.'))}</p>`

// In success path:
`connected as <strong>${escapeHtml(email)}</strong>`
```

**Edge cases:**
- Apply `escapeHtml` to every query parameter echoed into HTML, not just `error`
- Also escape the `email` value returned from Google (could contain special characters)

---

## 1.3 Encrypt Tokens at Rest

### Overview
Google OAuth `refresh_token` values are stored as plain JSONB in Postgres. A database breach exposes long-lived credentials for all connected users. AES-256-GCM provides authenticated encryption so tampering is also detected.

### Files changed
- `src/services/token-store.ts`
- `src/utils/crypto.ts` (new)
- `.env.example` (add `TOKEN_ENCRYPTION_KEY`)

### New environment variable
```
TOKEN_ENCRYPTION_KEY=<64 hex chars — generate with: openssl rand -hex 32>
```

**`src/utils/crypto.ts`** (new file)
```typescript
import crypto from 'crypto';

const KEY = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'hex');
const ALGO = 'aes-256-gcm';

if (KEY.length !== 32) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
}

export function encryptJson(obj: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const plaintext = JSON.stringify(obj);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all base64)
  return [iv, tag, encrypted].map(b => b.toString('base64')).join(':');
}

export function decryptJson<T>(blob: string): T {
  const parts = blob.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted blob format');
  const [ivB64, tagB64, ctB64] = parts;
  const iv  = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct  = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext) as T;
}
```

**Schema migration:**
```sql
-- Change column type from JSONB to TEXT to store encrypted blob
ALTER TABLE user_tokens ALTER COLUMN tokens TYPE TEXT USING tokens::TEXT;
```

**`src/services/token-store.ts`** — wrap all token reads/writes:
```typescript
import { encryptJson, decryptJson } from '../utils/crypto';

// On save:
tokens: encryptJson(tokens)   // stored as TEXT

// On read:
tokens: decryptJson<GoogleTokens>(row.tokens)
```

### Token migration playbook

Existing rows contain plain JSON text. On first startup after deploying this change, `initTokenStore` must detect and re-encrypt them. Run this **after** the schema migration but **before** going live.

```typescript
// In initTokenStore(), call migrateV1Tokens() once at startup:
async function migrateV1Tokens(): Promise<void> {
  const { rows } = await pool!.query(
    `SELECT slack_user_id, tokens FROM user_tokens`
  );
  let migrated = 0;
  for (const row of rows) {
    // Plain JSON starts with '{', encrypted blobs contain ':' separators
    if (!row.tokens.includes(':')) {
      try {
        const parsed = JSON.parse(row.tokens);
        const encrypted = encryptJson(parsed);
        await pool!.query(
          `UPDATE user_tokens SET tokens = $1 WHERE slack_user_id = $2`,
          [encrypted, row.slack_user_id]
        );
        migrated++;
      } catch (err) {
        logger.error({ slackUserId: row.slack_user_id, err }, 'Failed to migrate token — skipping row');
      }
    }
  }
  if (migrated > 0) {
    logger.info({ migrated }, 'Migrated plain-text tokens to encrypted format');
  }
}
```

**Testing without data loss:**
1. Take a Postgres backup before deploying: `pg_dump $DATABASE_URL > backup-pre-encryption.sql`
2. Run migration against a staging database copy first
3. Verify row count is unchanged after migration
4. Verify one known user can still load their calendar (decryption succeeds)
5. Roll back plan: restore from backup and remove `TOKEN_ENCRYPTION_KEY` from env if migration fails

**Edge cases:**
- Row with invalid JSON (corrupt data): log error, skip row, do not abort migration
- `TOKEN_ENCRYPTION_KEY` missing at startup: throw immediately so the process doesn't start with unencrypted storage

---

## 1.4 Add Caching Layer

### Overview
Every user interaction fires a full `users.list` + N Google Calendar API calls with zero caching. Unusable for teams over ~20 people.

### Solution
In-memory LRU cache with two TTLs:
- **User roster:** 5 minutes (changes rarely)
- **Calendar status per user per date:** 90 seconds (balances freshness vs. API calls)

### Files changed
- `src/services/cache.ts` (new)
- `src/services/team-status.ts`

### Implementation

**`src/services/cache.ts`** (new file)
```typescript
import { SlackUser, CalendarStatus } from '../types';

interface CacheEntry<T> { value: T; expiresAt: number; }

export class LRUCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  constructor(private maxSize: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Move to end (most-recently-used)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.store.size >= this.maxSize) {
      // Evict least-recently-used (first entry)
      this.store.delete(this.store.keys().next().value!);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key: string): void { this.store.delete(key); }

  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}

// Singleton caches
export const rosterCache = new LRUCache<SlackUser[]>(50);        // keyed: roster:{teamId}
export const statusCache  = new LRUCache<CalendarStatus>(5000);  // keyed: status:{slackUserId}:{dateStr}
```

**`src/services/team-status.ts`** — wrap calls with cache:
```typescript
import { rosterCache, statusCache } from './cache';

// Roster
const rosterKey = `roster:${teamId}`;
let users = rosterCache.get(rosterKey);
if (!users) {
  users = await fetchAllUsers(slackClient);
  rosterCache.set(rosterKey, users, 5 * 60 * 1000);
}

// Status per user
const statusKey = `status:${slackUserId}:${dateStr}`;
let status = statusCache.get(statusKey);
if (!status) {
  status = await getStatusForDate(tokens, targetDate);
  statusCache.set(statusKey, status, 90 * 1000);
}
```

### Cache invalidation rules

| Event | Cache key(s) to invalidate |
|-------|---------------------------|
| User connects Google Calendar | `status:{slackUserId}:*` (all dates for that user) — use `statusCache.invalidatePrefix('status:' + slackUserId)` |
| User disconnects Google Calendar | `status:{slackUserId}:*` (same as above) |
| Workspace installs or reinstalls | `roster:{teamId}` |
| `team_join` event fires | `roster:{teamId}` |
| `team_member_left` event fires | `roster:{teamId}` |

**Never** invalidate the whole cache on a single user action — only invalidate the affected keys.

---

## 1.5 Add Concurrency Limiter

### Overview
`Promise.all(statusPromises)` fires all Google Calendar requests simultaneously. For 200-person workspaces this causes rate limiting (HTTP 429) and memory pressure.

### Solution
Process in batches of 15 concurrent requests. Handle Google 429 responses explicitly.

### Files changed
- `src/utils/concurrency.ts` (new)
- `src/services/team-status.ts`

### Implementation

**`src/utils/concurrency.ts`** (new file)
```typescript
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}
```

**`src/services/team-status.ts`** — replace `Promise.all`:
```typescript
// Before:
const statuses = await Promise.all(statusPromises);

// After:
const statuses = await mapWithConcurrency(eligible, 15, async (user) => {
  try {
    return await getUserStatus(user, targetDate, teamId);
  } catch (err: any) {
    if (err?.code === 429 || err?.response?.status === 429) {
      logger.warn({ slackUserId: user.id, teamId }, 'Google API rate limited — returning unknown status');
      return { ...baseStatus(user), status: 'unknown' as const };
    }
    logger.error({ slackUserId: user.id, teamId, err }, 'Failed to fetch calendar status');
    return { ...baseStatus(user), status: 'unknown' as const };
  }
});
```

**Google 429 handling:**
- Do NOT retry within the same request — a 429 means the quota window is exhausted
- Return `status: 'unknown'` so the user sees a neutral state rather than crashing the whole view
- Log a `warn` (not `error`) — 429s are expected under load; alert only if rate is sustained
- The status cache will naturally absorb most traffic; 429s should be rare after Phase 1

---

## 1.6 Remove Redundant DB Calls

### Overview
`team-status.ts` calls `isConnected(userId)` then `getTokenRecord(userId)` — two queries when one suffices.

### Files changed
- `src/services/team-status.ts`

### Implementation
```typescript
// Before:
if (!(await isConnected(user.id!))) return base;
const record = await getTokenRecord(user.id!);

// After:
const record = await getTokenRecord(user.id!);
if (!record) return base;
```

The `isConnected` function can be kept as a convenience wrapper but should not be called in any hot path.

---

## 1.7 Add Error Boundaries

### Overview
If `publishHomeView` throws after the loading skeleton is shown, the user is stuck on a spinner with no recovery path.

### Files changed
- `src/ui/home-view.ts`
- `src/handlers/app-home.ts`

### Implementation

**`src/ui/home-view.ts`** — add `buildErrorView`:
```typescript
export function buildErrorView(state: ViewState): HomeTabView {
  return {
    type: 'home',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: ':calendar: Team Calendar', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':warning: *Something went wrong loading your team calendar.*\n_This is usually a temporary issue. Try refreshing._',
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: ':arrows_counterclockwise: Refresh', emoji: true },
          action_id: 'refresh_view',
          value: JSON.stringify(state),
        },
      },
    ],
  };
}
```

**`src/handlers/app-home.ts`** — wrap `publishHomeView`:
```typescript
try {
  await publishHomeView(client, teamId, userId, state);
} catch (err) {
  logger.error({ teamId, slackUserId: userId, err }, '[app-home] Failed to publish home view');
  await client.views.publish({
    user_id: userId,
    view: buildErrorView(state) as any,
  }).catch(innerErr => {
    // If even the error view fails, log and give up — don't throw
    logger.error({ teamId, slackUserId: userId, err: innerErr }, '[app-home] Failed to publish error view');
  });
}
```

---

## 1.8 Add Graceful Shutdown

### Overview
Railway restarts drop in-flight requests; Postgres connection pool is abandoned without cleanup.

### Files changed
- `src/app.ts`
- `src/services/token-store.ts` (export `closePgPool`)

### Implementation

**`src/services/token-store.ts`** — export pool closer:
```typescript
export async function closePgPool(): Promise<void> {
  if (pool) await pool.end();
}
```

**`src/app.ts`** — register shutdown handlers:
```typescript
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down...');
  await app.stop();
  await closePgPool();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

---

## 1.9 Revoke Google Tokens on Disconnect

### Overview
Deleting tokens from the DB does not revoke them with Google. The app retains theoretical access to the user's calendar indefinitely until the token expires.

### Files changed
- `src/services/google-calendar.ts`
- `src/handlers/actions.ts`

### Implementation

**`src/services/google-calendar.ts`**:
```typescript
export async function revokeTokens(tokens: GoogleTokens): Promise<void> {
  if (!tokens.access_token) return;
  try {
    const auth = createOAuth2Client();
    auth.setCredentials(tokens as any);
    await auth.revokeToken(tokens.access_token);
  } catch (err) {
    // Log but don't throw — the DB removal must still proceed
    logger.warn({ err }, 'Google token revocation failed — token may have already expired');
  }
}
```

**`src/handlers/actions.ts`** — call before removal:
```typescript
const record = await getTokenRecord(teamId, userId);
if (record) await revokeTokens(record.tokens);
await removeTokens(teamId, userId);
```

**Error handling:** Revocation failure is non-fatal. A failed revocation means the token may still work briefly, but it will expire naturally. The important thing is the DB record is removed so the app no longer uses it.

---

## 1.10 Add Structured Logging

### Overview
`console.log`/`console.error` produce unstructured text that is hard to search on Railway logs.

### Files changed
- `src/utils/logger.ts` (new)
- All files using `console.log`/`console.error`

### Installation
```bash
npm install pino pino-pretty
```

**`src/utils/logger.ts`** (new file)
```typescript
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});
```

### Mandatory context fields

Every log line **must** include these fields:

```typescript
// Required for all handler-level logs:
logger.info({ teamId, slackUserId, requestId }, 'message');

// Required for service-level logs (where teamId/slackUserId available):
logger.error({ teamId, slackUserId, err }, 'Failed to fetch calendar status');

// requestId is generated per inbound Slack event/action:
// Set in a middleware or at the top of each handler:
const requestId = crypto.randomUUID();
```

### Log level guidelines

| Level | When to use |
|-------|-------------|
| `error` | Unrecoverable failure; requires investigation (DB errors, decryption failures, unexpected throws) |
| `warn` | Degraded operation; recoverable (Google 429, token revocation failure, missing optional config) |
| `info` | Normal lifecycle events (startup, shutdown, view published, digest sent) |
| `debug` | Detailed tracing for development only (cache hits/misses, individual status resolutions) |

---

## 1.11 Fix Block Limit for Large Workspaces

### Overview
Slack Home tabs have a 100-block limit. Teams with 90+ members will hit this silently (Slack returns an error, the view doesn't update).

### Solution
Paginate the member list. Show 50 members per page with Next/Prev pagination buttons.

### Files changed
- `src/ui/home-view.ts`
- `src/types/index.ts`
- `src/handlers/actions.ts` (handle `paginate_prev`, `paginate_next` actions)

### Implementation

**`src/types/index.ts`** — add `page` to `ViewState`:
```typescript
export interface ViewState {
  date: string;        // "YYYY-MM-DD"
  filter: StatusFilter;
  page: number;        // 0-indexed; defaults to 0
}
```

**`src/ui/home-view.ts`** — paginate before building blocks:
```typescript
const PAGE_SIZE = 50;
const page = state.page ?? 0;
const paged = members.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
const totalPages = Math.ceil(members.length / PAGE_SIZE);

// Pagination controls (only rendered when totalPages > 1):
if (totalPages > 1) {
  const prevState: ViewState = { ...state, page: page - 1 };
  const nextState: ViewState = { ...state, page: page + 1 };

  blocks.push({
    type: 'actions',
    block_id: 'pagination',
    elements: [
      ...(page > 0 ? [{
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: '← Previous', emoji: true },
        action_id: 'paginate_prev',
        value: JSON.stringify(prevState),
      }] : []),
      {
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: `Page ${page + 1} of ${totalPages}`, emoji: false },
        action_id: 'paginate_noop',
        value: JSON.stringify(state),
      },
      ...(page < totalPages - 1 ? [{
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: 'Next →', emoji: true },
        action_id: 'paginate_next',
        value: JSON.stringify(nextState),
      }] : []),
    ],
  });
}
```

### Pagination value encoding

The `value` field on every pagination button is a JSON-serialized `ViewState`:

```json
{
  "date": "2026-03-04",
  "filter": "all",
  "page": 1
}
```

When the action fires, `handlers/actions.ts` reads this value exactly like all other button actions:
```typescript
app.action<BlockAction>('paginate_next', async ({ action, ack, body, client }) => {
  await ack();
  const state = JSON.parse((action as ButtonAction).value) as ViewState;
  // state.page is already incremented (encoded in the button value)
  await publishHomeView(client, body.team_id, body.user.id, state);
});
```

**Edge cases:**
- `page` missing from older persisted states: default to `0`
- Filter or date change: always reset `page` to `0`
- Members shrink between requests: clamp `page` to `Math.max(0, totalPages - 1)`

---

## 1.12 Add Health Check Endpoint

### Overview
Railway health checks require an HTTP endpoint. Without it, Railway has no way to detect a crashed app.

### Files changed
- `src/app.ts`

### Implementation
```typescript
receiver.router.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});
```

---

## Testing Checklist

- [ ] OAuth CSRF: attempt callback with a fabricated `state` nonce → 400 "link expired" response
- [ ] OAuth CSRF: verify nonce is deleted after first use (cannot replay the callback URL)
- [ ] XSS: send `?error=<script>alert(1)</script>` to callback → script tag appears escaped in rendered HTML
- [ ] Encryption: verify `tokens` column in Postgres contains ciphertext (contains `:` separators, not raw JSON)
- [ ] Encryption migration: start fresh copy of app with pre-existing plain-text tokens → logs show "Migrated N tokens"; all users still load their calendar
- [ ] Caching: verify second Home tab open within 90s does not fire Google API calls (check debug logs for cache hits)
- [ ] Google 429: mock a 429 response → user sees `status: 'unknown'` in their row; rest of view still loads
- [ ] Concurrency: verify 200-user workspace load completes (all batches logged, no unhandled rejections)
- [ ] Error boundary: disconnect from internet, open Home tab → error view with Refresh button appears; clicking Refresh re-triggers load
- [ ] Graceful shutdown: send SIGTERM → logs show "Shutting down..."; process exits 0; no Postgres errors in logs
- [ ] Token revocation: disconnect calendar → verify Google token is invalid (HTTP 401 if used directly)
- [ ] Block limit: test with 95 fake members → view renders page 1 (50 members) with correct pagination buttons; page 2 has remaining 45
- [ ] Pagination value: verify `paginate_next` button value encodes `page: 1` correctly; clicking navigates to page 2
- [ ] Health check: `GET /health` → `{"status":"ok","uptime":N}`
- [ ] Logging: every log line includes `teamId` and `slackUserId` where applicable; no plain `console.log` remains

## Definition of Done

All checklist items above pass. No P0 or P1 security findings in an OWASP-style checklist review. App handles 200-member workspaces without timeout or rate limit errors. `TOKEN_ENCRYPTION_KEY` documented in `.env.example`. All `console.log`/`console.error` replaced with pino logger.
