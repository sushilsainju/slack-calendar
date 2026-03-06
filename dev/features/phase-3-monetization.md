# Phase 3 — Monetization

## What's Being Added

Stripe payments, a 14-day trial, feature gating by tier, and all upgrade UI surfaces. After this phase the app can generate revenue.

---

## Tiers

| Feature | Free | Pro ($3.99/mo) | Business ($9.99/mo) |
|---------|------|----------------|---------------------|
| Connected calendars | 10 | Unlimited | Unlimited |
| Date navigation | :lock: | :white_check_mark: | :white_check_mark: |
| Status filters (OOO / In Meeting) | :lock: | :white_check_mark: | :white_check_mark: |
| /whosout slash command | :lock: | :white_check_mark: | :white_check_mark: |
| Auto-refresh (60s) | :lock: | :white_check_mark: | :white_check_mark: |
| Keyword OOO detection | :lock: | :white_check_mark: | :white_check_mark: |
| Branding footer | shown | hidden | hidden |
| Daily digest DM | :lock: | :lock: | :white_check_mark: |
| Channel notifications | :lock: | :lock: | :white_check_mark: |
| Week view | :lock: | :lock: | :white_check_mark: |
| Custom OOO keywords | :lock: | :lock: | :white_check_mark: |
| Admin settings modal | :lock: | :lock: | :white_check_mark: |

---

## New Files

| File | Purpose |
|------|---------|
| `src/services/entitlements.ts` | Feature gate lookup; caches tier per workspace for 5 min |
| `src/services/stripe.ts` | Stripe client; `createCheckoutSession`, `createPortalSession` |
| `src/services/workspace-store.ts` | `getConnectedCount`, `getWorkspaceTier` |
| `src/handlers/stripe-webhooks.ts` | Stripe webhook handler (signature-verified) |

---

## Entitlements System

`getEntitlements(teamId)` is the single source of truth for feature access. Every gated feature checks it before rendering or executing.

- Cached in-memory per workspace for 5 minutes
- Trial promotion logic lives here: `tier === 'free'` + `trial_ends_at > NOW()` → treated as Pro
- `invalidateEntitlements(teamId)` called immediately after any tier change

---

## 14-Day Trial

- Created automatically when a workspace installs (set in `installationStore.storeInstallation`)
- No credit card required to start — verify Stripe trial config matches this before shipping
- Trial state is read-only: expires naturally; no cron job needed
- Subscription cancellation does NOT restore trial — user drops directly to Free

**Trial states:**

| State | Condition | UI shown |
|-------|-----------|----------|
| `active` | `tier = 'free'` AND `trial_ends_at > NOW()` | Trial banner with days remaining |
| `expired` | `tier = 'free'` AND `trial_ends_at < NOW()` | Expired banner |
| `none` | `tier = 'pro'`/`'business'` OR no `trial_ends_at` | No banner |

---

## Stripe Integration

**Webhook events handled:**

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Update `workspaces.tier`, store `stripe_customer` + `stripe_sub_id`, send upgrade DM |
| `customer.subscription.deleted` | Revert tier to `'free'`, null `stripe_sub_id`. Does NOT restore `trial_ends_at` |
| `invoice.payment_failed` | Log warning (DM handling optional) |

**Webhook safety:** Missing `teamId` in metadata → respond 200 + warn log, no DB update. Internal error → respond 500 so Stripe retries.

**New env vars:**
```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRO_PRICE_ID=price_...
STRIPE_BUSINESS_PRICE_ID=price_...
STRIPE_PORTAL_RETURN_URL=https://slack-calendar-production.up.railway.app/billing/return
APP_URL=https://slack-calendar-production.up.railway.app
```

**New HTTP routes:**
- `POST /stripe/webhook` — webhook receiver (raw body, before Express JSON middleware)
- `GET /billing/success` — post-checkout landing page
- `GET /billing/cancel` — cancel landing page
- `GET /billing/return` — billing portal return page

---

## UI Surfaces

> UX reviewed by ux-ui-designer agent. Changes from review incorporated below.

### 1. Free Tier Home Tab

**Date navigation** — merged into a single section block (not a standalone actions bar):
```
:lock: Date Navigation  ·  Wednesday, March 4, 2026   [Refresh ↻]
```
Clicking the lock opens the upgrade modal for `date_navigation`.

**Filter buttons** — "All Members" is functional; locked filters have distinct action IDs:
- `upgrade_prompt_filter_ooo` / value `status_filter_ooo`
- `upgrade_prompt_filter_meeting` / value `status_filter_meeting`

(Each gets contextual copy in the upgrade modal.)

**Member cap CTA** — only shown when `totalMembers > FREE_LIMIT` (10):
```
_Showing 10 of 24 members · 10/10 calendars connected_   [ ↑ Upgrade to Pro ]
```

**Branding footer** (Free only):
```
Powered by Team Calendar · Free Plan
```

---

### 2. Trial Banner (active)

Shown immediately below the header. Urgency escalates:

| Days left | Emoji | Copy |
|-----------|-------|------|
| > 3 | `:hourglass_flowing_sand:` | "Pro Trial — N days remaining · Full access until [date]." |
| 2–3 | `:hourglass:` | "N days left in your Pro trial · Subscribe now to keep access." |
| 1 | `:red_circle:` | "Last day of your Pro trial · Subscribe today to avoid losing access." |
| 0 (today) | `:red_circle:` | "Your Pro trial ends tonight · Subscribe now." |

CTA button: **"Subscribe Now"** (not "Upgrade Now" — the user hasn't paid yet, not downgrading).

---

### 3. Trial Expired Banner

```
:lock:  *Your Pro trial has ended*

Your data is safe — all connected calendars are still stored.

Features now locked:  Date navigation · Status filters · Full team view · /whosout

```
CTA: **":sparkles: Upgrade to Pro — $3.99/mo"** (primary)

Add one line noting what Free users *keep*: "_You can still see today's availability for up to 10 team members._"

---

### 4. Upgrade Modal

Opens from any locked feature click. Title: **"Upgrade to Pro"**. Close label: **"Maybe Later"** (lower psychological cost than "Cancel").

**First section copy** — dynamic per `featureKey`, no "You discovered a Pro feature" phrasing:

| featureKey | Copy |
|------------|------|
| `date_navigation` | "Date Navigation lets you browse to any past or future date — handy for planning ahead or reviewing last week." |
| `status_filter_ooo` | "The Out of Office filter shows only who's away — without scrolling through your whole team list." |
| `status_filter_meeting` | "The In Meeting filter shows who's currently in a call, in real time." |
| `member_limit` | "Full Team View removes the 10-member cap so your whole workspace is always visible." |
| `trial_expired` | "Your trial has ended. Upgrade to restore date navigation, filters, unlimited calendars, and /whosout." |

**Pricing line:** Use `:receipt:` not `:moneybag:` — less friction before a purchase decision.

**CTA:** `:rocket: Start 14-Day Free Trial` — opens Stripe Checkout URL (stored in button `url` field, not `value`).

**Admin note** (add to context block at bottom): "_Payment applies to your whole workspace. Anyone on your team can complete the upgrade._"

**No-op submit handler** registered in Bolt to prevent unhandled modal submission errors.

---

### 5. Upgrade Success DM

Sent as a real DM (not ephemeral) to `slackUserId` from Stripe session metadata.

```
:tada:  *You're on Team Calendar Pro, [First Name]!*

Unlocked for your whole workspace:
:white_check_mark:  Navigate to any date
:white_check_mark:  Filter by OOO or In Meeting
:white_check_mark:  See your full team (no cap)
:white_check_mark:  /whosout slash command
:white_check_mark:  Auto-refresh every 60 seconds

:receipt: Receipt sent to your billing email · Next charge: April 4, 2026 ($3.99)

[ :calendar: Open Team Calendar ]  ← deep link to App Home
```

**Deduplication:** Store processed Stripe `session_id` (or check `stripe_sub_id` already set) before sending DM and updating DB — prevents double-processing on webhook retry.

---

## Calendar Connect Limit Enforcement

When the 11th user on a Free workspace tries to connect Google Calendar:
- Stripe Checkout session is created first
- If it fails → ephemeral error message to user
- If it succeeds → upgrade modal opens instead of Google OAuth URL

---

## New Environment Variables

```
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRO_PRICE_ID
STRIPE_BUSINESS_PRICE_ID
STRIPE_PORTAL_RETURN_URL
APP_URL
```

---

## Branch
Not yet started — prerequisite: `phase-2-multi-workspace` merged to `main`.
