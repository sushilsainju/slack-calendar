# Phase 4 — Pro Features

**Duration:** 2–3 weeks
**Prerequisite:** Phase 3 complete (entitlements system must exist)
**Goal:** Deliver the features that make Pro tier feel meaningfully better than Free. These are the features that drive the initial upgrade decision.

---

## 4.1 `/whosout` Slash Command

### Overview
Allows any workspace member to instantly query team availability without opening the App Home tab. Works in any channel or DM. Response is ephemeral (only visible to the requester) by default, with a "Share" button to post publicly.

### Files changed
- `src/handlers/slash-commands.ts` (new)
- `src/ui/slash-response.ts` (new)
- `src/utils/date-parser.ts` (new)
- `src/app.ts` (register slash command handler)
- `slack-manifest.json` (add `/whosout` command definition)

### Slack Manifest Update
```json
{
  "features": {
    "slash_commands": [
      {
        "command": "/whosout",
        "description": "See who's out of office or in a meeting",
        "usage_hint": "[today|tomorrow|YYYY-MM-DD]",
        "should_escape": false
      }
    ]
  }
}
```

### Command Parsing

| Input | Resolved Date |
|-------|---------------|
| `/whosout` (no args) | Today |
| `/whosout today` | Today |
| `/whosout tomorrow` | Tomorrow |
| `/whosout monday` | Next Monday (or today if today is Monday) |
| `/whosout 2026-03-10` | March 10, 2026 |
| `/whosout next week` | Next Monday |
| `/whosout 2026-99-99` | Invalid — show error response |

**`src/utils/date-parser.ts`** (new file)
```typescript
export type ParseResult =
  | { ok: true; date: Date }
  | { ok: false; error: string };

export function parseCommandDate(arg: string | undefined): ParseResult {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!arg || arg === 'today') return { ok: true, date: today };

  if (arg === 'tomorrow') {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return { ok: true, date: d };
  }

  if (arg === 'next week') {
    const d = new Date(today);
    const daysUntilMonday = (8 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMonday);
    return { ok: true, date: d };
  }

  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayIdx = DAYS.indexOf(arg.toLowerCase());
  if (dayIdx !== -1) {
    const d = new Date(today);
    const diff = (dayIdx - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return { ok: true, date: d };
  }

  // Try ISO date YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    const iso = new Date(arg + 'T00:00:00');
    if (isNaN(iso.getTime())) {
      return { ok: false, error: `"${arg}" is not a valid date. Try: today, tomorrow, monday, or YYYY-MM-DD` };
    }
    return { ok: true, date: iso };
  }

  return { ok: false, error: `Unrecognized date "${arg}". Try: today, tomorrow, monday, or YYYY-MM-DD` };
}
```

### Handler

**`src/handlers/slash-commands.ts`** (new file)
```typescript
import { App } from '@slack/bolt';
import { getEntitlements } from '../services/entitlements';
import { getTeamStatuses } from '../services/team-status';
import { parseCommandDate } from '../utils/date-parser';
import {
  buildWhosOutResults,
  buildWhosOutEmpty,
  buildWhosOutUpgradePrompt,
  buildWhosOutInvalidDate,
} from '../ui/slash-response';
import { logger } from '../utils/logger';

export function registerSlashCommands(app: App): void {
  app.command('/whosout', async ({ command, ack, respond, body, client }) => {
    await ack();

    const teamId = body.team_id;
    const requestId = crypto.randomUUID();

    const ent = await getEntitlements(teamId);
    if (!ent.slashCommand) {
      await respond({ response_type: 'ephemeral', blocks: buildWhosOutUpgradePrompt() });
      return;
    }

    const parsed = parseCommandDate(command.text.trim() || undefined);
    if (!parsed.ok) {
      await respond({ response_type: 'ephemeral', blocks: buildWhosOutInvalidDate(parsed.error) });
      return;
    }

    try {
      const statuses = await getTeamStatuses(client, teamId, parsed.date, 'all');
      const ooo     = statuses.filter(s => s.status === 'out_of_office');
      const meeting = statuses.filter(s => s.status === 'in_meeting');

      if (ooo.length === 0 && meeting.length === 0) {
        await respond({ response_type: 'ephemeral', blocks: buildWhosOutEmpty(parsed.date) });
        return;
      }

      await respond({
        response_type: 'ephemeral',
        blocks: buildWhosOutResults(parsed.date, ooo, meeting),
      });
    } catch (err) {
      logger.error({ teamId, requestId, slackUserId: body.user_id, err }, '/whosout failed');
      await respond({
        response_type: 'ephemeral',
        text: ':warning: Something went wrong fetching team availability. Please try again.',
      });
    }
  });

  // Share button handler
  app.action<BlockAction>('whosout_share', async ({ action, body, ack, respond }) => {
    await ack();
    // The button value encodes the full blocks JSON to re-post publicly
    const payload = JSON.parse((action as ButtonAction).value) as {
      date: string;
      blocks: Block[];
    };
    // Re-post as in_channel (visible to everyone in the channel)
    await respond({
      response_type: 'in_channel',
      replace_original: false,
      blocks: payload.blocks,
      text: `Team availability for ${payload.date}`,
    });
  });
}
```

### `/whosout` Block Limit Safety

`chat.respond` (via Slack's response URL) has a 50-block limit. Cap results:
- OOO members: max **15** shown inline; if more, append `+N more members are out of office`
- In-meeting members: max **5** shown inline; if more, append `+N more are in meetings`

This is enforced in `buildWhosOutResults`:
```typescript
const MAX_OOO     = 15;
const MAX_MEETING = 5;

const oooToShow     = ooo.slice(0, MAX_OOO);
const oooOverflow   = ooo.length - oooToShow.length;
const mtgToShow     = meeting.slice(0, MAX_MEETING);
const mtgOverflow   = meeting.length - mtgToShow.length;
```

### UI — Slash Command Response Blocks

**`src/ui/slash-response.ts`** (new file)

#### Results state
```
/whosout tomorrow

📅  Thursday, March 5, 2026

🔴  Out of Office (2)
  • @alice   Vacation
  • @bob     PTO

🟡  In Meetings (1)
  • @carol

🟢  12 members available

[ 📅 View in Team Calendar ]   [ 📢 Share with channel ]
```

**Full Block Kit JSON — Results:**
```json
[
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": ":calendar:  *Thursday, March 5, 2026*"
    }
  },
  { "type": "divider" },
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": ":red_circle:  *Out of Office (2)*\n• <@U001>   _Vacation_\n• <@U002>   _PTO_"
    }
  },
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": ":yellow_circle:  *In Meetings (1)*\n• <@U003>"
    }
  },
  {
    "type": "context",
    "elements": [
      { "type": "mrkdwn", "text": ":green_circle:  12 members available" }
    ]
  },
  {
    "type": "actions",
    "elements": [
      {
        "type": "button",
        "text": { "type": "plain_text", "text": ":calendar: View in Team Calendar", "emoji": true },
        "action_id": "open_team_calendar",
        "url": "slack://app?team=TEAM_ID&id=APP_ID&tab=home"
      },
      {
        "type": "button",
        "text": { "type": "plain_text", "text": ":mega: Share with channel", "emoji": true },
        "action_id": "whosout_share",
        "value": "{\"date\":\"2026-03-05\",\"blocks\":[...]}"
      }
    ]
  }
]
```

> **Note on Share button value:** The `value` field contains the blocks to re-post, JSON-encoded. Keep it under 2000 chars. If the blocks JSON is too large (many OOO members), generate a simplified version for the public share (name + status only, no meeting details).

#### Empty state
```json
[
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": ":calendar:  *Wednesday, March 4, 2026*"
    }
  },
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": ":green_circle:  *Everyone is available today!*\n_No OOO events or active meetings found._"
    }
  },
  {
    "type": "actions",
    "elements": [
      {
        "type": "button",
        "text": { "type": "plain_text", "text": ":calendar: View in Team Calendar", "emoji": true },
        "action_id": "open_team_calendar",
        "url": "slack://app?team=TEAM_ID&id=APP_ID&tab=home"
      }
    ]
  }
]
```

#### Upgrade prompt (Free tier)
```json
[
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": ":lock:  *Slash commands are a Pro feature.*\n\nUpgrade to Team Calendar Pro for `/whosout`, date navigation, status filters, and unlimited calendars."
    }
  },
  {
    "type": "actions",
    "elements": [
      {
        "type": "button",
        "text": { "type": "plain_text", "text": ":zap: Upgrade to Pro — $3.99/mo", "emoji": true },
        "action_id": "upgrade_prompt_slash_command",
        "value": "slash_command",
        "style": "primary"
      }
    ]
  }
]
```

#### Invalid date error
```json
[
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": ":warning:  *Invalid date.*\n\n\"2026-99-99\" is not a valid date. Try: `today`, `tomorrow`, `monday`, or `YYYY-MM-DD`"
    }
  }
]
```

---

## 4.2 Auto-Refresh

### Overview
On Free tier, the Home view only updates when the user opens the tab or clicks Refresh. On Pro, the view should reflect near-real-time status automatically.

### Approach
Slack does not push "user is viewing the home tab" events after the initial `app_home_opened`, so true server-push refresh is not possible. The practical solution is:
1. When a Pro user opens the Home tab, start a background `setInterval` that refreshes their view every 60 seconds
2. Track last-action time per user; stop refreshing if inactive for 5 minutes
3. Stop refreshing if the user switches to the Messages tab

### Files changed
- `src/services/refresh-scheduler.ts` (new)
- `src/handlers/app-home.ts`
- `src/handlers/actions.ts` (update `lastActionAt` on every action)

### Implementation

**`src/services/refresh-scheduler.ts`** (new file)
```typescript
import { WebClient } from '@slack/web-api';
import { ViewState } from '../types';
import { publishHomeView } from '../handlers/app-home';
import { logger } from '../utils/logger';

const activeRefreshes = new Map<string, NodeJS.Timeout>();

/**
 * Staleness tracking: record the last time each user performed an action.
 * Updated on every app_home_opened event and every block action.
 */
export const lastActionAt = new Map<string, number>();

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes of inactivity → stop refreshing

export function recordAction(userId: string): void {
  lastActionAt.set(userId, Date.now());
}

export function startAutoRefresh(
  client: WebClient,
  teamId: string,
  userId: string,
  getState: () => ViewState,
  intervalMs = 60_000,
): void {
  stopAutoRefresh(userId);
  recordAction(userId); // mark as active when refresh starts

  const timer = setInterval(async () => {
    // Stop refreshing if the user has been inactive for > 5 minutes
    const lastActive = lastActionAt.get(userId) ?? 0;
    if (Date.now() - lastActive > STALE_THRESHOLD_MS) {
      logger.debug({ userId, teamId }, 'Auto-refresh stopped — user inactive');
      stopAutoRefresh(userId);
      return;
    }

    try {
      await publishHomeView(client, teamId, userId, getState());
    } catch (err) {
      logger.warn({ userId, teamId, err }, 'Auto-refresh publish failed — stopping');
      stopAutoRefresh(userId);
    }
  }, intervalMs);

  activeRefreshes.set(userId, timer);
}

export function stopAutoRefresh(userId: string): void {
  const timer = activeRefreshes.get(userId);
  if (timer) {
    clearInterval(timer);
    activeRefreshes.delete(userId);
  }
}

/** Returns the number of currently active refresh timers (for monitoring). */
export function activeRefreshCount(): number {
  return activeRefreshes.size;
}
```

**`src/handlers/app-home.ts`** — start/stop on tab open:
```typescript
import { startAutoRefresh, stopAutoRefresh, recordAction } from '../services/refresh-scheduler';

app.event('app_home_opened', async ({ event, client, body }) => {
  if (event.tab !== 'home') {
    // User switched to Messages tab — stop refreshing to save resources
    stopAutoRefresh(event.user);
    return;
  }

  const teamId = body.team_id;
  const state: ViewState = parseStateFromEvent(event) ?? defaultState();
  recordAction(event.user);

  const ent = await getEntitlements(teamId);
  if (ent.autoRefresh) {
    // Capture state in a closure that always returns the most recent state
    let currentState = state;
    startAutoRefresh(client, teamId, event.user, () => currentState);
    // After publishing, update currentState so auto-refresh uses latest
    await publishHomeView(client, teamId, event.user, state);
    currentState = state; // state is immutable per view; update when actions fire
  } else {
    await publishHomeView(client, teamId, event.user, state);
  }
});
```

**`src/handlers/actions.ts`** — call `recordAction` on every action handler:
```typescript
import { recordAction } from '../services/refresh-scheduler';

// At the top of every action handler:
recordAction(body.user.id);
```

### UI — Last Updated Indicator

**Pro users:**
```json
{
  "type": "context",
  "elements": [
    { "type": "mrkdwn", "text": "_Last updated just now  ·  Auto-refreshes every 60 seconds_" }
  ]
}
```

**Free users** — show manual refresh only copy:
```json
{
  "type": "context",
  "elements": [
    { "type": "mrkdwn", "text": "_Manual refresh only on Free plan_  ·  <action:upgrade_prompt_auto_refresh|Upgrade to Pro for auto-refresh>" }
  ]
}
```

Since context blocks cannot contain buttons, use a mrkdwn link styled as text if needed. Alternatively, add a separate `section` block with the Refresh button as an accessory for Free users, and a plain context line for Pro users.

**Free tier footer section:**
```json
{
  "type": "section",
  "block_id": "refresh_footer",
  "text": {
    "type": "mrkdwn",
    "text": "_Manual refresh only on Free plan_"
  },
  "accessory": {
    "type": "button",
    "text": { "type": "plain_text", "text": ":arrows_counterclockwise: Refresh", "emoji": true },
    "action_id": "refresh_view",
    "value": "{\"date\":\"2026-03-04\",\"filter\":\"all\",\"page\":0}"
  }
}
```

---

## 4.3 Keyword-Based OOO Detection (Pro Only)

### Overview
`getStatusForDate` currently checks keyword-matching on all-day event titles (vacation, PTO, etc.). This is a Pro feature — Free users only get Google-native `outOfOffice` event type detection.

### Files changed
- `src/services/google-calendar.ts`
- `src/services/team-status.ts`

### Implementation

**`src/services/google-calendar.ts`** — add options parameter:
```typescript
export const DEFAULT_OOO_KEYWORDS = [
  'out of office', 'ooo', 'vacation', 'holiday', 'leave', 'pto', 'off',
];

export async function getStatusForDate(
  tokens: GoogleTokens,
  targetDate: Date,
  options: {
    keywordDetection: boolean;
    customKeywords?: string[];
  } = { keywordDetection: true },
): Promise<CalendarStatus> {
  // ... existing event fetch logic ...

  // Priority 1: Google-native outOfOffice (always checked)
  const nativeOoo = events.find(e => e.eventType === 'outOfOffice');
  if (nativeOoo) return { status: 'out_of_office', label: nativeOoo.summary ?? 'Out of Office' };

  // Priority 2: Keyword detection (Pro only)
  if (options.keywordDetection) {
    const keywords = [
      ...DEFAULT_OOO_KEYWORDS,
      ...(options.customKeywords ?? []).map(k => k.toLowerCase()),
    ];
    const allDayOoo = events.find(e =>
      e.start?.date && // all-day event has .date, not .dateTime
      keywords.some(kw => e.summary?.toLowerCase().includes(kw))
    );
    if (allDayOoo) return { status: 'out_of_office', label: allDayOoo.summary ?? 'OOO' };
  }

  // Priority 3: Active timed event (today only)
  // ...
}
```

**`src/services/team-status.ts`** — pass entitlement:
```typescript
const ent = await getEntitlements(teamId);
const settings = await getWorkspaceSettings(teamId);
const result = await getStatusForDate(record.tokens, targetDate, {
  keywordDetection: ent.keywordOooDetection,
  customKeywords: ent.customOooKeywords ? settings.customOooKeywords : undefined,
});
```

---

## 4.4 Date Navigation & Status Filters (Pro Only)

These features are gated in Phase 3 UI. Phase 4 ensures they are wired end-to-end and tested.

### Unlocked date navigation (Pro) block:
```json
{
  "type": "actions",
  "block_id": "date_navigation",
  "elements": [
    {
      "type": "button",
      "text": { "type": "plain_text", "text": "← Prev", "emoji": true },
      "action_id": "navigate_prev_day",
      "value": "{\"date\":\"2026-03-03\",\"filter\":\"all\",\"page\":0}"
    },
    {
      "type": "button",
      "text": { "type": "plain_text", "text": "Today", "emoji": false },
      "action_id": "navigate_today",
      "value": "{\"date\":\"2026-03-04\",\"filter\":\"all\",\"page\":0}"
    },
    {
      "type": "button",
      "text": { "type": "plain_text", "text": "Next →", "emoji": true },
      "action_id": "navigate_next_day",
      "value": "{\"date\":\"2026-03-05\",\"filter\":\"all\",\"page\":0}"
    }
  ]
}
```

All button `value` fields encode the full `ViewState` JSON. Handlers in `actions.ts` parse the value and call `publishHomeView`.

---

## 4.5 Pro Home View Enhancements

### Upcoming OOO preview (Pro only)
When viewing today's date, show a context block previewing tomorrow's OOO:
```json
{
  "type": "context",
  "elements": [
    { "type": "mrkdwn", "text": ":calendar:  *Tomorrow:* <@U001> and <@U002> are out of office" }
  ]
}
```

If no one is OOO tomorrow, omit this block.

### Connected calendar count (Pro footer)
```json
{
  "type": "context",
  "elements": [
    { "type": "mrkdwn", "text": "14 calendars connected  ·  <action:disconnect_google_calendar|Disconnect yours>" }
  ]
}
```

---

## Testing Checklist

- [ ] `/whosout` in a Free workspace → upgrade prompt blocks appear (ephemeral)
- [ ] `/whosout` in a Pro workspace (no args) → today's OOO list (ephemeral)
- [ ] `/whosout tomorrow` → correct date resolved and shown in header
- [ ] `/whosout monday` → next Monday's date (not today, even if today is Monday)
- [ ] `/whosout 2026-03-15` → correct ISO date
- [ ] `/whosout 2026-99-99` → invalid date error block appears
- [ ] Empty state: `/whosout` when all available → "Everyone is available" message
- [ ] OOO > 15 members → shows first 15 + "+N more members are out of office" context line
- [ ] Meeting > 5 members → shows first 5 + "+N more are in meetings" context line
- [ ] Share button (`whosout_share` action) → re-posts as `in_channel` with correct blocks
- [ ] Auto-refresh fires every 60s for Pro users on Home tab (verify via logs)
- [ ] Auto-refresh stops after 5 minutes of inactivity (`lastActionAt` check)
- [ ] Auto-refresh stops when user switches to Messages tab (`app_home_opened` with `tab !== 'home'`)
- [ ] Free tier footer shows "Manual refresh only on Free plan" context; Pro shows "Auto-refreshes every 60 seconds"
- [ ] Keyword OOO detection active for Pro ("Vacation" all-day event → OOO status)
- [ ] Keyword OOO detection inactive for Free ("Vacation" all-day event → Available)
- [ ] Date nav and filter buttons functional end-to-end with correct `ViewState` encoding
- [ ] `activeRefreshCount()` stays bounded (no leak after users close the tab)

## Definition of Done

`/whosout` deployed and usable by Pro workspaces. Auto-refresh runs 24h without memory leaks (verify `activeRefreshCount()` via Railway memory metrics over 24h). All Pro features gated correctly — Free users see upgrade prompts, not errors or blank screens. Block Kit JSON for all `/whosout` states is valid and renders correctly in Slack.
