# Phase 3 — Monetization

**Duration:** 2–3 weeks
**Prerequisite:** Phase 2 complete (multi-workspace required before gating by team)
**Goal:** Implement Stripe payments, a 14-day trial, feature gating, and all upgrade UI surfaces. After this phase the app can generate revenue.

---

## 3.1 Entitlements System

The central feature-gate module. Every gated feature checks here before rendering or executing.

### Files changed
- `src/services/entitlements.ts` (new)

### `src/services/entitlements.ts`

```typescript
import { pool } from './token-store';
import { logger } from '../utils/logger';

export interface Entitlements {
  maxConnectedCalendars: number;   // 10 (free) | Infinity (pro/business)
  dateNavigation: boolean;         // false | true | true
  statusFilters: boolean;          // false | true | true
  keywordOooDetection: boolean;    // false | true | true
  slashCommand: boolean;           // false | true | true
  autoRefresh: boolean;            // false | true | true
  showBranding: boolean;           // true  | false | false
  dailyDigest: boolean;            // false | false | true
  channelNotifications: boolean;   // false | false | true
  weekView: boolean;               // false | false | true
  customOooKeywords: boolean;      // false | false | true
  adminSettings: boolean;          // false | false | true
}

export type Tier = 'free' | 'pro' | 'business';

const TIER_ENTITLEMENTS: Record<Tier, Entitlements> = {
  free: {
    maxConnectedCalendars: 10,
    dateNavigation: false,
    statusFilters: false,
    keywordOooDetection: false,
    slashCommand: false,
    autoRefresh: false,
    showBranding: true,
    dailyDigest: false,
    channelNotifications: false,
    weekView: false,
    customOooKeywords: false,
    adminSettings: false,
  },
  pro: {
    maxConnectedCalendars: Infinity,
    dateNavigation: true,
    statusFilters: true,
    keywordOooDetection: true,
    slashCommand: true,
    autoRefresh: true,
    showBranding: false,
    dailyDigest: false,
    channelNotifications: false,
    weekView: false,
    customOooKeywords: false,
    adminSettings: false,
  },
  business: {
    maxConnectedCalendars: Infinity,
    dateNavigation: true,
    statusFilters: true,
    keywordOooDetection: true,
    slashCommand: true,
    autoRefresh: true,
    showBranding: false,
    dailyDigest: true,
    channelNotifications: true,
    weekView: true,
    customOooKeywords: true,
    adminSettings: true,
  },
};

// In-memory cache — refresh every 5 minutes to avoid a DB hit on every request
const cache = new Map<string, { ent: Entitlements; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getEntitlements(teamId: string): Promise<Entitlements> {
  const cached = cache.get(teamId);
  if (cached && Date.now() < cached.expiresAt) return cached.ent;

  const { rows } = await pool!.query(
    `SELECT tier, trial_ends_at FROM workspaces WHERE team_id = $1`,
    [teamId]
  );

  const row = rows[0];
  if (!row) {
    logger.warn({ teamId }, 'No workspace record found — defaulting to free entitlements');
    return TIER_ENTITLEMENTS.free;
  }

  let effectiveTier: Tier = row.tier as Tier;

  // Trial: treat as pro if trial hasn't expired AND current tier is still free
  // A paid user cannot re-enter trial — if tier is pro/business, ignore trial_ends_at
  if (effectiveTier === 'free' && row.trial_ends_at && new Date(row.trial_ends_at) > new Date()) {
    effectiveTier = 'pro';
  }

  const ent = TIER_ENTITLEMENTS[effectiveTier] ?? TIER_ENTITLEMENTS.free;
  cache.set(teamId, { ent, expiresAt: Date.now() + CACHE_TTL_MS });
  return ent;
}

/** Force-invalidate a team's entitlements cache entry. Call after any tier change. */
export function invalidateEntitlements(teamId: string): void {
  cache.delete(teamId);
  logger.debug({ teamId }, 'Entitlements cache invalidated');
}
```

---

## 3.2 Trial Logic

### 14-Day Trial Flow

Trials are created automatically when a workspace installs the app (set in `installationStore.storeInstallation` — Phase 2):

```sql
INSERT INTO workspaces (team_id, tier, trial_ends_at)
VALUES ($1, 'free', NOW() + INTERVAL '14 days')
ON CONFLICT (team_id) DO NOTHING;
```

- Tier stays `'free'` in the DB — `getEntitlements` promotes to `pro` entitlements while `trial_ends_at > NOW()`
- When the trial expires, entitlements naturally revert to Free without any cron job
- No credit card required to start the trial

### Trial State Determination

```typescript
export type TrialState = 'active' | 'expired' | 'none';

export async function getTrialState(
  teamId: string,
): Promise<{ state: TrialState; daysLeft?: number }> {
  const { rows } = await pool!.query(
    `SELECT tier, trial_ends_at FROM workspaces WHERE team_id = $1`,
    [teamId]
  );
  const row = rows[0];

  // 'none' cases:
  // - No workspace record
  // - Paid tier (trial is irrelevant once paid)
  // - trial_ends_at is NULL (shouldn't happen but be defensive)
  if (!row?.trial_ends_at || row.tier !== 'free') return { state: 'none' };

  const now = new Date();
  const trialEnd = new Date(row.trial_ends_at);
  if (trialEnd > now) {
    const daysLeft = Math.ceil((trialEnd.getTime() - now.getTime()) / 86_400_000);
    return { state: 'active', daysLeft };
  }
  return { state: 'expired' };
}
```

### Trial edge cases

| Scenario | Correct Behavior |
|----------|-----------------|
| Paid user (Pro/Business) calls `getTrialState` | Returns `{ state: 'none' }` — trial banner is not shown |
| Subscription deleted → tier reverts to `'free'` | Tier = `'free'`, `trial_ends_at` is NOT restored — user enters Free (not trial) |
| `trial_ends_at` in the past, tier = `'free'` | `getTrialState` returns `{ state: 'expired' }`; `getEntitlements` returns free tier |
| New install after prior uninstall | `ON CONFLICT DO NOTHING` in `storeInstallation` means trial is NOT re-granted |

---

## 3.3 Stripe Integration

### Dependencies

```bash
npm install stripe
```

### New environment variables

```
STRIPE_SECRET_KEY=sk_live_...          # use sk_test_... in development
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRO_PRICE_ID=price_...          # $3.99/month product
STRIPE_BUSINESS_PRICE_ID=price_...     # $9.99/month product
STRIPE_PORTAL_RETURN_URL=https://your-domain.com/billing/return
APP_URL=https://your-domain.com        # used in Stripe success/cancel URLs
```

### Files changed
- `src/services/stripe.ts` (new)
- `src/handlers/stripe-webhooks.ts` (new)
- `src/app.ts` (register webhook route)

### `src/services/stripe.ts`

```typescript
import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20',
});

/**
 * Create a Stripe Checkout session for a workspace upgrade.
 * Throws if the Stripe API call fails — caller must handle and show an error to the user.
 */
export async function createCheckoutSession(
  teamId: string,
  slackUserId: string,
  priceId: string,
): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { teamId, slackUserId, priceId },
    success_url: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}&slack_user=${encodeURIComponent(slackUserId)}&team=${encodeURIComponent(teamId)}`,
    cancel_url: `${process.env.APP_URL}/billing/cancel`,
  });
  if (!session.url) throw new Error('Stripe returned a session without a URL');
  return session.url;
}

/**
 * Create a Stripe Customer Portal link for billing management.
 * Throws if the Stripe API call fails.
 */
export async function createPortalSession(stripeCustomerId: string): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: process.env.STRIPE_PORTAL_RETURN_URL!,
  });
  return session.url;
}
```

### `src/handlers/stripe-webhooks.ts`

```typescript
import express, { Router } from 'express';
import Stripe from 'stripe';
import { stripe } from '../services/stripe';
import { invalidateEntitlements } from '../services/entitlements';
import { pool } from '../services/token-store';
import { logger } from '../utils/logger';

export function createStripeWebhookRouter(): Router {
  const router = Router();

  router.post(
    '/stripe/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      const sig = req.headers['stripe-signature'] as string;
      let event: Stripe.Event;

      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET!,
        );
      } catch (err) {
        logger.warn({ err }, 'Stripe webhook signature verification failed');
        return res.status(400).send('Webhook signature verification failed');
      }

      // Guard: metadata.teamId must be present for all events we care about
      const teamId = (event.data.object as any).metadata?.teamId;
      if (!teamId) {
        // Log a warning but respond 200 — returning non-200 causes Stripe to retry
        logger.warn({ eventType: event.type, eventId: event.id }, 'Stripe webhook missing teamId in metadata — skipping');
        return res.json({ received: true });
      }

      try {
        switch (event.type) {
          case 'checkout.session.completed': {
            const session = event.data.object as Stripe.Checkout.Session;
            // Determine tier from the price ID stored in metadata
            const tier = session.metadata?.priceId === process.env.STRIPE_BUSINESS_PRICE_ID
              ? 'business' : 'pro';
            await pool!.query(
              `UPDATE workspaces
               SET tier = $1, stripe_customer = $2, stripe_sub_id = $3, trial_ends_at = NULL
               WHERE team_id = $4`,
              [tier, session.customer, session.subscription, teamId]
            );
            invalidateEntitlements(teamId);
            const slackUserId = session.metadata?.slackUserId;
            if (slackUserId) {
              await sendUpgradeSuccessMessage(slackUserId, teamId, tier);
            }
            logger.info({ teamId, tier, slackUserId }, 'Workspace upgraded via Stripe');
            break;
          }

          case 'customer.subscription.deleted': {
            // Subscription deleted — revert to free. Do NOT restore trial_ends_at.
            await pool!.query(
              `UPDATE workspaces SET tier = 'free', stripe_sub_id = NULL WHERE team_id = $1`,
              [teamId]
            );
            invalidateEntitlements(teamId);
            logger.info({ teamId }, 'Subscription deleted — workspace reverted to free tier');
            break;
          }

          case 'invoice.payment_failed': {
            // Optional: send a DM to the installing user about failed payment
            logger.warn({ teamId }, 'Invoice payment failed');
            break;
          }

          default:
            // Unknown event type — respond 200, do nothing
            break;
        }
      } catch (err) {
        logger.error({ teamId, eventType: event.type, err }, 'Error processing Stripe webhook');
        // Return 500 so Stripe retries this event
        return res.status(500).json({ error: 'Internal processing error' });
      }

      res.json({ received: true });
    }
  );

  return router;
}
```

### Billing routes

```typescript
// In src/app.ts or a dedicated billing.ts handler:
receiver.router.get('/billing/success', (_req, res) => {
  res.send(html(
    '✅ Upgrade Complete!',
    '<p>Your workspace is now upgraded. Check your Slack DMs for details.</p>' +
    '<script>setTimeout(() => window.close(), 3000);</script>',
  ));
});

receiver.router.get('/billing/cancel', (_req, res) => {
  res.send(html('Upgrade Cancelled', '<p>No changes were made. You can upgrade any time from the Team Calendar app.</p>'));
});

receiver.router.get('/billing/return', (_req, res) => {
  res.send(html('Billing Portal', '<p>Return to Slack to continue.</p>'));
});

receiver.router.use(createStripeWebhookRouter());
```

---

## 3.4 Upgrade Action Handler

When a user clicks any locked feature or the upgrade button:

### Files changed
- `src/handlers/actions.ts`

```typescript
// In src/handlers/actions.ts
app.action<BlockAction>(/^upgrade_prompt_/, async ({ action, body, ack, client }) => {
  await ack();
  const teamId = body.team_id;
  const featureKey = (action as ButtonAction).value; // e.g., 'date_navigation'

  let checkoutUrl: string;
  try {
    checkoutUrl = await createCheckoutSession(
      teamId,
      body.user.id,
      process.env.STRIPE_PRO_PRICE_ID!,
    );
  } catch (err) {
    logger.error({ teamId, slackUserId: body.user.id, err }, 'Failed to create Stripe checkout session');
    // Respond with an ephemeral error message — do not let the UI hang
    await client.chat.postEphemeral({
      channel: body.channel?.id ?? body.user.id,
      user: body.user.id,
      text: ':warning: Unable to open the upgrade page right now. Please try again in a moment.',
    });
    return;
  }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildUpgradeModal(featureKey, checkoutUrl),
  });
});
```

---

## 3.5 Tier-Aware Home View

`buildHomeView` receives entitlements and trial state and renders accordingly.

### Files changed
- `src/ui/home-view.ts`
- `src/handlers/app-home.ts`

### Updated signature

```typescript
export function buildHomeView(
  members: MemberStatusInfo[],
  state: ViewState,
  isViewerConnected: boolean,
  ent: Entitlements,
  trial: { state: TrialState; daysLeft?: number },
): HomeTabView
```

### UI Designs

---

#### Free Tier Home Tab

```
┌─────────────────────────────────────────────────────┐
│  :calendar: Team Calendar                  [HEADER] │
├─────────────────────────────────────────────────────┤
│  [ :lock: Date Navigation (Pro) ]          [ACTIONS]│
├─────────────────────────────────────────────────────┤
│  *Wednesday, March 4, 2026*  [:arrows_counterclockwise: Refresh] [SECTION]│
├─────────────────────────────────────────────────────┤
│  [All Members] [:lock: Out of Office] [:lock: In Meeting]        │
│                                            [ACTIONS]│
├─────────────────────────────────────────────────────┤
│  10 members · :red_circle: 2 OOO · :yellow_circle: 1 meeting · :green_circle: 7   │
│                                            [CONTEXT]│
├─────────────────────────────────────────────────────┤
│  :red_circle:  @alice    Vacation                   │
│  :red_circle:  @bob      PTO                        │
│  ...up to 10 members...                             │
├─────────────────────────────────────────────────────┤
│  _Showing 10 of 24 members · 10/10 calendars_       │
│  [ :arrow_up: Upgrade to Pro — see all 24 members ] │
├─────────────────────────────────────────────────────┤
│  _Powered by Team Calendar · Free Plan_    [CONTEXT]│
└─────────────────────────────────────────────────────┘
```

**Key Block Kit rules:**
- Locked buttons use no `style` — renders as gray (inactive-looking) without Slack's disabled state
- `:lock:` emoji is the universal gated-feature signal
- Locked buttons ARE clickable — they open the upgrade modal via `upgrade_prompt_*` action IDs
- Member list is capped at `ent.maxConnectedCalendars` (10 for free)
- "10/10 calendars connected" frames the limit as capacity, not punishment
- Branding footer: `context` block with italics — present, not distracting

**Block Kit — locked date navigation button:**
```json
{
  "type": "actions",
  "block_id": "date_navigation",
  "elements": [
    {
      "type": "button",
      "text": { "type": "plain_text", "text": ":lock: Date Navigation (Pro)", "emoji": true },
      "action_id": "upgrade_prompt_date_nav",
      "value": "date_navigation"
    }
  ]
}
```

**Block Kit — locked filter buttons:**
```json
{
  "type": "actions",
  "block_id": "status_filters",
  "elements": [
    {
      "type": "button",
      "text": { "type": "plain_text", "text": "All Members", "emoji": false },
      "action_id": "filter_all",
      "value": "{\"date\":\"2026-03-04\",\"filter\":\"all\",\"page\":0}",
      "style": "primary"
    },
    {
      "type": "button",
      "text": { "type": "plain_text", "text": ":lock: Out of Office", "emoji": true },
      "action_id": "upgrade_prompt_filter",
      "value": "status_filters"
    },
    {
      "type": "button",
      "text": { "type": "plain_text", "text": ":lock: In Meeting", "emoji": true },
      "action_id": "upgrade_prompt_filter",
      "value": "status_filters"
    }
  ]
}
```

**Block Kit — upgrade CTA when member cap is reached:**
```json
{
  "type": "section",
  "block_id": "upgrade_member_limit",
  "text": {
    "type": "mrkdwn",
    "text": "_Showing 10 of 24 members · 10/10 calendars connected_"
  },
  "accessory": {
    "type": "button",
    "text": { "type": "plain_text", "text": ":arrow_up: Upgrade to Pro", "emoji": true },
    "action_id": "upgrade_prompt_member_limit",
    "value": "member_limit",
    "style": "primary"
  }
}
```

---

#### Trial Active Banner (shown below header)

```
┌─────────────────────────────────────────────────────┐
│  :hourglass_flowing_sand: *Pro Trial — 11 days remaining*       │
│  Full access to all Pro features until March 15.    │
│                              [ :arrow_up: Upgrade Now ]  │
│                                            [SECTION]│
└─────────────────────────────────────────────────────┘
```

**Block Kit:**
```json
{
  "type": "section",
  "block_id": "trial_banner",
  "text": {
    "type": "mrkdwn",
    "text": ":hourglass_flowing_sand:  *Pro Trial — 11 days remaining*\nFull access to all Pro features until *March 15, 2026*."
  },
  "accessory": {
    "type": "button",
    "text": { "type": "plain_text", "text": ":arrow_up: Upgrade Now", "emoji": true },
    "action_id": "upgrade_from_trial_banner",
    "value": "trial_banner",
    "style": "primary"
  }
}
```

**Urgency escalation (set in `buildTrialBanner`):**
```typescript
function buildTrialBanner(daysLeft: number): SectionBlock {
  let emoji = ':hourglass_flowing_sand:';
  let text = `*Pro Trial — ${daysLeft} days remaining*\nFull access to all Pro features until *${trialEndDate}*.`;
  if (daysLeft <= 3) {
    emoji = ':warning:';
    text = `*:warning: ${daysLeft} days left in your Pro trial*\nUpgrade now to keep date navigation, filters, and unlimited calendars.`;
  }
  if (daysLeft === 1) {
    text = `*Tomorrow is your last day of Pro*\nUpgrade today to avoid losing access.`;
  }
  // ...
}
```

---

#### Trial Expired Banner

```json
{
  "type": "section",
  "block_id": "trial_expired_banner",
  "text": {
    "type": "mrkdwn",
    "text": ":unlock:  *Your Pro trial has ended*\n\nYou had access to:\n• Date navigation  • Status filters\n• Full team view  • /whosout command\n\nThese features are now locked. Your data is safe.\n"
  },
  "accessory": {
    "type": "button",
    "text": { "type": "plain_text", "text": ":sparkles: Upgrade to Pro — $3.99/mo", "emoji": true },
    "action_id": "upgrade_prompt_trial_expired",
    "value": "trial_expired",
    "style": "primary"
  }
}
```

---

#### Upgrade Modal (opens on any locked feature click)

```
┌──────────────────────────────────────────────────────┐
│  Upgrade to Pro                         [Modal title]│
├──────────────────────────────────────────────────────┤
│  :lock: You discovered a Pro feature                 │
│                                                      │
│  *Status Filters* let you instantly see who's Out    │
│  of Office or In a Meeting — without scrolling.      │
│                                          [SECTION]   │
├──────────────────────────────────────────────────────┤
│  :sparkles:  *What you get with Pro*                 │
│  :white_check_mark:  Navigate to any date            │
│  :white_check_mark:  Filter by OOO or In Meeting     │
│  :white_check_mark:  See your full team (no cap)     │
│  :white_check_mark:  /whosout slash command          │
│  :white_check_mark:  Auto-refresh every 60s          │
│                                          [SECTION]   │
├──────────────────────────────────────────────────────┤
│  :moneybag:  *$3.99 / month per workspace*           │
│  Cancel anytime. 14-day trial, no credit card.       │
│                                          [SECTION]   │
│  [ :rocket: Start 14-Day Free Trial ]    [ACTIONS]   │
├──────────────────────────────────────────────────────┤
│                             [ Maybe Later ]          │
└──────────────────────────────────────────────────────┘
```

**Full Block Kit JSON for upgrade modal:**
```json
{
  "type": "modal",
  "callback_id": "upgrade_modal",
  "title": { "type": "plain_text", "text": "Upgrade to Pro", "emoji": true },
  "close": { "type": "plain_text", "text": "Maybe Later", "emoji": false },
  "blocks": [
    {
      "type": "section",
      "block_id": "feature_description",
      "text": {
        "type": "mrkdwn",
        "text": ":lock: *You discovered a Pro feature*\n\n*Status Filters* let you instantly see who's Out of Office or In a Meeting — without scrolling through your whole team list."
      }
    },
    { "type": "divider" },
    {
      "type": "section",
      "block_id": "feature_list",
      "text": {
        "type": "mrkdwn",
        "text": ":sparkles:  *What you get with Pro*\n:white_check_mark:  Navigate to any date\n:white_check_mark:  Filter by OOO or In Meeting\n:white_check_mark:  See your full team (no cap)\n:white_check_mark:  /whosout slash command\n:white_check_mark:  Auto-refresh every 60 seconds"
      }
    },
    { "type": "divider" },
    {
      "type": "section",
      "block_id": "pricing",
      "text": {
        "type": "mrkdwn",
        "text": ":moneybag:  *$3.99 / month per workspace*\nCancel anytime. 14-day trial included, no credit card required."
      }
    },
    {
      "type": "actions",
      "block_id": "upgrade_cta",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": ":rocket: Start 14-Day Free Trial", "emoji": true },
          "action_id": "open_stripe_checkout",
          "value": "CHECKOUT_URL_PLACEHOLDER",
          "style": "primary"
        }
      ]
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "Already upgraded? <https://your-domain.com/billing/restore|Restore purchase>" }
      ]
    }
  ]
}
```

**Dynamic feature text** — `featureKey` (from the clicked button's `value`) controls the first section:

```typescript
const FEATURE_DESCRIPTIONS: Record<string, string> = {
  date_navigation: '*Date Navigation* lets you browse to any past or future date to plan ahead.',
  status_filters:  '*Status Filters* let you instantly see who\'s Out of Office or In a Meeting.',
  member_limit:    '*Full Team View* lets you see your entire workspace — no 10-member cap.',
  trial_banner:    'Upgrade to keep date navigation, filters, unlimited calendars, and /whosout.',
  trial_expired:   'Your trial has ended. Upgrade to restore all Pro features.',
};
```

**UX notes:**
- `close` label is "Maybe Later" not "Cancel" — lower psychological cost
- No modal submit button; CTA is an `actions` block button that opens the Stripe Checkout URL via `url` field
- The `value` field on the CTA button must be set to the actual Stripe checkout URL when building the modal

---

#### Upgrade Success DM (sent after Stripe checkout completes)

```json
{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":tada:  *You're now on Team Calendar Pro!*\n\nYour workspace is upgraded. Unlocked for everyone:\n:white_check_mark:  Date navigation\n:white_check_mark:  Status filters\n:white_check_mark:  Full team view (no cap)\n:white_check_mark:  /whosout slash command\n:white_check_mark:  Auto-refresh every 60 seconds"
      }
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": ":receipt: Receipt sent to your billing email · Next charge: April 4, 2026 ($3.99)" }
      ]
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": ":calendar: Open Team Calendar", "emoji": true },
          "action_id": "open_team_calendar",
          "url": "slack://app?team={team_id}&id={app_id}&tab=home",
          "style": "primary"
        }
      ]
    }
  ]
}
```

Sent as a DM (not ephemeral) via `chat.postMessage` to the `slackUserId` stored in the Stripe session metadata.

---

## 3.6 Calendar Connect Limit Enforcement

When the 11th user tries to connect Google Calendar on a Free workspace:

### Files changed
- `src/handlers/actions.ts`

```typescript
// In handlers/actions.ts — connect_google_calendar action:
const ent = await getEntitlements(teamId);
const connectedCount = await getConnectedCount(teamId);

if (connectedCount >= ent.maxConnectedCalendars) {
  let checkoutUrl: string;
  try {
    checkoutUrl = await createCheckoutSession(teamId, body.user.id, process.env.STRIPE_PRO_PRICE_ID!);
  } catch (err) {
    logger.error({ teamId, slackUserId: body.user.id, err }, 'Failed to create checkout session for connect limit');
    await client.chat.postEphemeral({
      channel: body.channel?.id ?? body.user.id,
      user: body.user.id,
      text: ':warning: Unable to open the upgrade page right now. Please try again in a moment.',
    });
    return;
  }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildUpgradeModal('member_limit', checkoutUrl),
  });
  return;
}
// proceed with Google OAuth URL...
```

---

## 3.7 Workspace Settings Helper

### Files changed
- `src/services/workspace-store.ts` (new or extend Phase 2 version)

```typescript
export async function getConnectedCount(teamId: string): Promise<number> {
  const { rows } = await pool!.query(
    `SELECT COUNT(*) FROM user_tokens WHERE team_id = $1`,
    [teamId]
  );
  return parseInt(rows[0].count, 10);
}

export async function getWorkspaceTier(teamId: string): Promise<Tier> {
  const { rows } = await pool!.query(
    `SELECT tier FROM workspaces WHERE team_id = $1`,
    [teamId]
  );
  return (rows[0]?.tier ?? 'free') as Tier;
}
```

---

## Testing Checklist

- [ ] Free tier: date nav and filter buttons show `:lock:` and open upgrade modal on click
- [ ] Free tier: 11th user connects → upgrade modal opens instead of OAuth URL
- [ ] Free tier: member list capped at 10 with "Upgrade to see all" CTA block
- [ ] Free tier: branding footer context block appears
- [ ] Trial: new install → Pro entitlements for 14 days without payment
- [ ] Trial: `getTrialState` for paid Pro user returns `{ state: 'none' }`
- [ ] Trial: subscription deleted → tier = `'free'`; `trial_ends_at` NOT restored; user enters Free (not trial)
- [ ] Trial banner: days remaining count correct; urgency changes at ≤ 3 days; `daysLeft === 1` shows special copy
- [ ] Trial expired: `getEntitlements` returns free tier entitlements; expired banner shown
- [ ] Stripe Checkout: clicking "Start Trial" button opens Stripe checkout URL
- [ ] Stripe webhook `checkout.session.completed` with missing `teamId` in metadata → 200 response, warning log, no DB update
- [ ] Stripe webhook `checkout.session.completed` with valid metadata → tier updated, cache invalidated, upgrade DM sent
- [ ] Stripe webhook `customer.subscription.deleted` → tier reverts to `'free'`, cache invalidated, `trial_ends_at` stays NULL
- [ ] `createCheckoutSession` throws → ephemeral error message shown to user
- [ ] Upgrade success DM: includes correct features list and deep-link button
- [ ] Pro tier: all gated features fully functional (date nav, filters, unlimited members)
- [ ] Entitlements cache invalidates immediately after `invalidateEntitlements(teamId)` call

## Definition of Done

At least one real Stripe payment processed end-to-end in test mode. Entitlements correctly gate all features across Free, Trial, Pro, and Business tiers. Upgrade modal opens from every locked feature. Webhook handler processes `checkout.session.completed` and `customer.subscription.deleted` correctly. Stripe metadata missing case is handled gracefully (no crash).
