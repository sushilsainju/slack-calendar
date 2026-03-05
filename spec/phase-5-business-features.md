# Phase 5 — Business Features

**Duration:** 3–4 weeks
**Prerequisite:** Phase 4 complete
**Goal:** Deliver the automation and proactive notification features that justify the Business tier price for larger teams. These features shift the app from "reactive lookup" to "proactive awareness."

---

## 5.1 Daily OOO Digest DM

### Overview
Each morning, every workspace member receives a private DM summarising who is out of office today. This removes the need to manually check the app and creates a daily habit loop.

### Schedule
- Default: 8:30 AM in the **workspace's timezone** (configurable by admin)
- Runs on weekdays only (Mon–Fri)
- Skip if no one is OOO (configurable — default: skip)

> **Block limit:** `chat.postMessage` has a **50-block limit** (not 100). Keep digest DMs under 50 blocks. For large teams, cap OOO rows at 15 members and summarize the rest as "+N more".

### Implementation

**`src/services/digest.ts`** (new file)

```typescript
import { WebClient } from '@slack/web-api';
import { getTeamStatuses } from './team-status';
import { buildDailyDigestBlocks } from '../ui/digest-view';
import { logger } from '../utils/logger';

export async function sendDailyDigest(
  client: WebClient,
  teamId: string,
): Promise<void> {
  const today = new Date();
  const statuses = await getTeamStatuses(client, teamId, today, 'all');
  const ooo = statuses.filter(s => s.status === 'out_of_office');

  // Get all workspace members to DM
  const allMembers = statuses.map(s => s.slackUserId);

  for (const userId of allMembers) {
    try {
      const dm = await client.conversations.open({ users: userId });
      await client.chat.postMessage({
        channel: dm.channel!.id!,
        blocks: buildDailyDigestBlocks(today, ooo, userId),
        text: ooo.length > 0
          ? `${ooo.length} teammate(s) are out of office today`
          : 'Everyone is in today',
      });
    } catch (err) {
      logger.error({ userId, teamId, err }, 'Failed to send digest DM');
    }
  }
}
```

**Scheduler — `src/handlers/scheduled.ts`** (new file)

Use a cron-style approach. On Railway, a simple in-process cron works for MVP. For reliability at scale, move to a dedicated worker or Railway's cron service.

```typescript
import cron from 'node-cron';
import { getAllInstallations } from '../services/installation-store';
import { getWorkspaceSettings } from '../services/workspace-store';
import { sendDailyDigest } from '../services/digest';

export function registerScheduledJobs(app: App): void {
  // Run every minute; check per-workspace if it's their digest time
  cron.schedule('* * * * *', async () => {
    const installations = await getAllInstallations();
    for (const { teamId, client } of installations) {
      const settings = await getWorkspaceSettings(teamId);
      if (!settings.digestEnabled) continue;
      if (!isDigestTime(settings.digestTime, settings.timezone)) continue;

      await sendDailyDigest(client, teamId);
    }
  });
}

function isDigestTime(digestTime: string, tz: string): boolean {
  const now = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz,
  });
  return now === digestTime;
}
```

Add `node-cron` dependency: `npm install node-cron && npm install -D @types/node-cron`

### Digest DM UI

```
┌─────────────────────────────────────────────────┐
│ 📅  Good morning! Here's your team update for   │
│     Wednesday, March 4                           │
│─────────────────────────────────────────────────│
│ 🔴  Out of Office Today (3)                     │
│                                                  │
│ [avatar] @alice  —  Vacation (back Thu)          │
│ [avatar] @bob    —  Out of Office                │
│ [avatar] @carol  —  PTO                          │
│─────────────────────────────────────────────────│
│ 🟢  Everyone else is in                         │
│─────────────────────────────────────────────────│
│         [ 📅 Open Team Calendar ]               │
└─────────────────────────────────────────────────┘
```

"Open Team Calendar" button uses `url` field deep-linking to the app's home tab:
`slack://app?team={team_id}&id={app_id}&tab=home`

---

## 5.2 Channel OOO Notifications

### Overview
When a new OOO event appears on a team member's calendar (one they didn't have yesterday), post a notification to a designated channel. This is useful for unexpected absences and helps teams plan around them.

### Detection Strategy

OOO events are detected by comparing today's OOO list with yesterday's cached list. New OOO entries trigger a channel notification.

**`src/services/notifications.ts`** (new file)

```typescript
export async function checkAndNotifyNewOOO(
  client: WebClient,
  teamId: string,
  notifyChannelId: string,
): Promise<void> {
  const today = new Date();
  const currentOOO = (await getTeamStatuses(client, teamId, today, 'out_of_office'))
    .map(s => s.slackUserId);

  const previousKey = `ooo_snapshot:${teamId}:${toDateString(today)}`;
  const previousOOO: string[] = (await getCache(previousKey)) ?? [];

  const newOOO = currentOOO.filter(uid => !previousOOO.includes(uid));
  await setCache(previousKey, currentOOO, 24 * 60 * 60 * 1000);

  for (const userId of newOOO) {
    const status = ...; // get their status detail
    await client.chat.postMessage({
      channel: notifyChannelId,
      blocks: buildOOONotificationBlocks(userId, status),
      text: `<@${userId}> is out of office`,
    });
  }
}
```

### Channel Notification UI

```
┌─────────────────────────────────────────────────┐
│ 🔴  @alice is Out of Office                     │
│                                                  │
│     Vacation · Mar 4 – Mar 8                    │
│                                                  │
│     [ 📅 View Team Calendar ]                   │
└─────────────────────────────────────────────────┘
```

Compact, single message per person. Does not @ mention the OOO person (they're out — no point notifying them).

---

## 5.3 Week View

### Overview
A week view (Mon–Fri) inside the App Home tab, showing which team members have OOO events on each day of the current week. Allows planning around absences.

### Block Kit Constraint

Slack's 100-block limit is the primary constraint. Solution: **render each day as a single `section` block with mrkdwn text**, listing all OOO/meeting members inline. This is far more efficient than one context block per member.

```
┌─────────────────────────────────────────────────────────┐
│  📅  Team Calendar                          [HEADER]    │
│  [ ← Prev Week ]  [ This Week ]  [ Next Week → ] [ACTIONS]│
│  Week of March 2 – 6, 2026  [↻ Refresh]   [SECTION]   │
│  Last updated just now · Auto-refreshes every 5 min [CTX]│
│  [ Day View ]  [● Week View ]               [ACTIONS]  │
│─────────────────────────────────────────────────────────│
│  Mon, Mar 2                                             │
│  🟢  All 12 members available               [SECTION]  │
│─────────────────────────────────────────────────────────│
│  Tue, Mar 3                                             │
│  🔴  @bob (Vacation)                                    │
│  🟢  11 available                           [SECTION]  │
│─────────────────────────────────────────────────────────│
│  Wed, Mar 4  ← Today                                   │
│  🔴  @bob (Vacation) · @grace (PTO)                    │
│  🟡  @carol (Team Standup, 10–10:30 AM)                │
│  🟢  9 available                            [SECTION]  │
│─────────────────────────────────────────────────────────│
│  Thu, Mar 5                                             │
│  🔴  @grace (PTO)                                       │
│  🟢  11 available                           [SECTION]  │
│─────────────────────────────────────────────────────────│
│  Fri, Mar 6                                             │
│  🔴  @bob (Vacation) · @grace (PTO)                    │
│  🟢  10 available                           [SECTION]  │
│─────────────────────────────────────────────────────────│
│  12 team members · Switch to Day View for meeting detail│
└─────────────────────────────────────────────────────────┘
```

### Block Budget

```
Header:                    1
Week nav (actions):        1
Week label + refresh:      1
Refresh context:           1
View mode switcher:        1
Overhead divider:          1
5 day sections:            5
4 inter-day dividers:      4
Footer context:            1
Calendar connection:       2
────────────────────────────
Total: 18 blocks  (limit: 100, headroom: 82)
```

### Day Section Assembly Rules

Build each day's mrkdwn string in order:
1. `*Mon, Mar 2*` — append `  ← Today` if the date matches today
2. If OOO members: `🔴  <@A> _(label)_  ·  <@B> _(label)_` — cap at 4 inline, then `+N more`
3. If meeting members (today only): `🟡  <@C> _(Meeting name)_` — omit for future dates
4. Available count: `🟢  N available`
5. If zero OOO and zero meetings: replace lines 2–4 with `🟢  All N members available`

### Implementation

**`src/ui/week-view.ts`** (new file)

```typescript
export async function buildWeekView(
  weekStartDate: Date,
  teamStatuses: Map<string, MemberStatusInfo[]>, // date string → members
): Promise<{ type: 'home'; blocks: Block[] }> {
  const blocks: Block[] = [];
  // Header + nav
  // For each of Mon–Fri:
  //   1 section block: "TUE 3   🔴 2 OOO" or "MON 2   🟢 Everyone in"
  //   For each OOO member: 1 context block with avatar + name + label
  return { type: 'home', blocks };
}
```

Week view fetches all 5 days in parallel (using concurrency limiter from Phase 1):
```typescript
const days = getWeekDays(weekStartDate); // Mon–Fri
const allStatuses = await mapWithConcurrency(days, 5, async (day) => {
  const statuses = await getTeamStatuses(client, teamId, day, 'out_of_office');
  return { day, statuses };
});
```

### ViewState Extension

```typescript
export interface ViewState {
  date: string;           // "YYYY-MM-DD" — day view selected date
  weekStart: string;      // "YYYY-MM-DD" — always a Monday
  viewMode: 'day' | 'week';   // renamed from view for clarity
  filter: StatusFilter;
}
```

Toggle between Day and Week view uses `switch_to_day_view` / `switch_to_week_view` action IDs, consistent with existing action routing in `handlers/actions.ts`. When switching day→week, use current date's week. When switching week→day, default to today.

> **Note:** All week navigation action values encode `viewMode: 'week'` in their JSON — the same handler that routes filter and nav actions routes week actions by `action_id` prefix (`navigate_prev_week`, `navigate_next_week`, `navigate_this_week`).

---

## 5.4 Admin Settings Modal

### Overview
Workspace admins can configure Business tier settings without leaving Slack.

### Access Control
Only users with `is_admin: true` in their Slack profile see the Settings button.

### Settings Modal Sections

**1. Notifications**
- Toggle: Enable daily digest DMs (on/off)
- Time picker: Digest delivery time (default 8:30 AM)
- Channel selector: OOO notification channel

**2. OOO Detection**
- Multi-line text input: Custom OOO keywords (one per line, in addition to defaults)

**3. Subscription**
- Current tier display
- Connected calendars count
- "Manage billing" button → Stripe customer portal link

### Implementation

**`src/services/workspace-store.ts`** (new file)

```typescript
interface WorkspaceSettings {
  digestEnabled: boolean;
  digestTime: string;        // "08:30"
  timezone: string;          // IANA timezone from Slack workspace
  notifyChannelId: string | null;
  customOooKeywords: string[];
}

export async function getWorkspaceSettings(teamId: string): Promise<WorkspaceSettings>
export async function updateWorkspaceSettings(teamId: string, settings: Partial<WorkspaceSettings>): Promise<void>
```

Add settings columns to `workspaces` table:
```sql
ALTER TABLE workspaces
  ADD COLUMN digest_enabled      BOOLEAN DEFAULT false,
  ADD COLUMN digest_time         TEXT    DEFAULT '08:30',
  ADD COLUMN timezone            TEXT    DEFAULT 'America/New_York',
  ADD COLUMN notify_channel_id   TEXT,
  ADD COLUMN custom_ooo_keywords TEXT[]  DEFAULT '{}';
```

### UI — Admin Settings Modal

```
┌──────────────────────────────────────────────┐
│  ⚙️  Team Calendar Settings                  │
├──────────────────────────────────────────────┤
│                                              │
│  NOTIFICATIONS                               │
│  ─────────────────────────────────────────  │
│  Daily digest DMs      [ ● On  / Off ]      │
│  Delivery time         [ 8:30 AM      ▼ ]  │
│  OOO alert channel     [ #general     ▼ ]  │
│                                              │
│  OOO DETECTION                              │
│  ─────────────────────────────────────────  │
│  Custom keywords                            │
│  ┌──────────────────────────────────────┐  │
│  │ sick                                 │  │
│  │ family leave                         │  │
│  │ conference                           │  │
│  └──────────────────────────────────────┘  │
│  (in addition to: ooo, vacation, pto...)    │
│                                              │
│  SUBSCRIPTION                               │
│  ─────────────────────────────────────────  │
│  Plan: Business  ·  14 calendars connected  │
│                                              │
│  [ Manage Billing ]                         │
│                                              │
├──────────────────────────────────────────────┤
│              [ Cancel ]  [ Save Settings ]   │
└──────────────────────────────────────────────┘
```

Block Kit structure:
- `conversations_select` element for digest channel and OOO alert channel (not `static_select` — it queries live channel list with search)
- `timepicker` element for digest delivery time
- `plain_text_input` (single line, comma-separated) for custom keywords — max 20 keywords, max 500 chars
- Modal `callback_id: 'admin_settings_modal'` — handle via `app.view('admin_settings_modal', ...)`
- Modal has `submit` and `close` buttons; no `actions` block needed inside

**Key Block Kit notes:**
- Mark OOO channel input `optional: true` — submitting empty disables notifications
- `hint` on the time picker should show the workspace timezone (e.g. "Sends in America/New_York")
- Re-verify admin status server-side when the action fires AND when the modal is submitted
- Modal block count: ~12 blocks (well within 100-block modal limit)

**Settings button** — only shown to admins in the Home tab footer:
```typescript
if (isAdmin) {
  blocks.push({
    type: 'actions',
    elements: [{ type: 'button', text: { type: 'plain_text', text: '⚙️ Admin Settings' }, action_id: 'open_admin_settings_modal' }]
  });
}
```

---

## 5.5 Multi-Calendar Support (Business)

### Overview
Business users can connect a second Google Calendar (e.g., personal calendar alongside work). Status is derived from the union of all connected calendars.

### Changes Required

- `user_tokens` gains a `calendar_index` column (0 = primary, 1 = secondary)
- `getStatusForDate` accepts an array of token records and merges results
- Connect modal shows "Connect additional calendar" option for Business users
- Max 2 calendars per user on Business tier (enforced via entitlements)

---

## Testing Checklist

- [ ] Daily digest fires at configured time in the workspace's timezone
- [ ] Digest skips weekends
- [ ] Digest sends only to Business workspaces
- [ ] Digest includes correct OOO members
- [ ] Digest "Open Team Calendar" button deep-links to App Home
- [ ] Channel notification fires when a new OOO appears (not on subsequent checks)
- [ ] Channel notification does not @ the OOO person
- [ ] Week view shows correct Mon–Fri range with OOO members
- [ ] Week navigation (prev/next week) works
- [ ] Week view block count never exceeds 100 (test with 50+ OOO members)
- [ ] Settings modal opens only for admins
- [ ] Settings save persists correctly to DB
- [ ] Custom OOO keywords are applied in status detection
- [ ] Digest settings changes take effect within 1 minute

## Definition of Done

Daily digest sends to a test workspace at the configured time for 3 consecutive weekdays without failures. Channel notifications fire correctly for at least 3 OOO scenarios. Week view renders without hitting block limits for workspaces with up to 100 members. Admin settings modal saves and applies all configuration options.
