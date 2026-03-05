# Team Calendar — Product & Engineering Roadmap

## Vision

Turn Team Calendar into the default way Slack workspaces track availability. Every team member should be able to open Slack and instantly know who is reachable, who is in a meeting, and who is out — without leaving Slack.

## Business Model

**Freemium, per-workspace pricing.**

| Tier | Price | Target |
|------|-------|--------|
| Free | $0 | Individual teams evaluating the app |
| Pro | $3.99/month | Small–medium teams (10–200 people) |
| Business | $9.99/month | Larger teams needing automation & notifications |

Per-workspace (not per-seat) pricing minimises purchase friction. A 100-person team pays the same as a 10-person team, making it a trivially easy expense to approve.

## Phases at a Glance

| Phase | Focus | Duration |
|-------|-------|----------|
| [1 — Security & Stability](./phase-1-security-stability.md) | Fix critical security issues and make the app production-safe | 2–3 weeks |
| [2 — Multi-Workspace](./phase-2-multi-workspace.md) | Support multiple workspace installs via Slack OAuth V2 | 3–4 weeks |
| [3 — Monetization](./phase-3-monetization.md) | Stripe integration, feature gating, trial, upgrade flows | 2–3 weeks |
| [4 — Pro Features](./phase-4-pro-features.md) | Slash command, auto-refresh, keyword OOO detection | 2–3 weeks |
| [5 — Business Features](./phase-5-business-features.md) | Digest DMs, channel notifications, week view, admin settings | 3–4 weeks |

**Total estimated timeline: 14–17 weeks**

## Phase Definition of Done (Summary)

| Phase | Exit Criteria |
|-------|--------------|
| 1 | 0 open P0/P1 security issues; 200-member workspace loads without timeout; all checklist items pass |
| 2 | App installs in ≥2 workspaces simultaneously; all data scoped by `team_id`; `SLACK_BOT_TOKEN` removed |
| 3 | ≥1 real Stripe payment in test mode end-to-end; all 4 tiers (free/trial/pro/business) gate correctly |
| 4 | `/whosout` live for Pro workspaces; auto-refresh runs 24h without memory leaks; all Pro features gated |
| 5 | Digest sends 3 consecutive weekdays without failure; week view renders under 100 blocks for 100-member workspaces |

## Guiding Principles

1. **Security before growth.** Phase 1 must be complete before any public promotion.
2. **Multi-workspace is a prerequisite for monetization.** Phase 2 must be complete before Phase 3.
3. **Free tier must be genuinely useful.** It should not feel broken or crippled — it should feel like a natural starting point that grows into something more.
4. **Every upsell surface should be additive.** Show what the user gains, never punish them for being on Free.
5. **Slack-native UX throughout.** Block Kit only, no external web UIs for core workflows.

## Tech Stack (current + planned additions)

| Layer | Current | Planned additions |
|-------|---------|-------------------|
| Runtime | Node.js 18+, TypeScript | — |
| Framework | @slack/bolt v3 | Multi-install `installationStore` |
| Database | Postgres (Railway) | `workspaces`, `installations`, `pending_states` tables |
| Payments | — | Stripe Checkout + Billing webhooks |
| Caching | None | In-memory LRU (roster + status) |
| Logging | console.log | pino structured logger |
| Secrets | ENV vars | Encrypted token fields (AES-256-GCM) |

## Environment Variables — Full Table

All environment variables used across all phases. Marked with the phase that introduces them.

| Variable | Phase | Required | Description |
|----------|-------|----------|-------------|
| `DATABASE_URL` | 1 | Yes | PostgreSQL connection string |
| `TOKEN_ENCRYPTION_KEY` | 1 | Yes | 64 hex chars (`openssl rand -hex 32`) |
| `LOG_LEVEL` | 1 | No | `info` (default) \| `debug` \| `warn` \| `error` |
| `PORT` | 1 | No | HTTP port, default `3000` |
| `SLACK_SIGNING_SECRET` | 1 | Yes | From Slack app settings |
| `SLACK_BOT_TOKEN` | 1→2 | Phase 1 only | Removed in Phase 2 |
| `GOOGLE_CLIENT_ID` | 1 | Yes | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | 1 | Yes | From Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | 1 | Yes | Must match Google Console (e.g., `https://your-domain.com/oauth/google/callback`) |
| `SLACK_CLIENT_ID` | 2 | Yes | From Slack app settings |
| `SLACK_CLIENT_SECRET` | 2 | Yes | From Slack app settings |
| `SLACK_STATE_SECRET` | 2 | Yes | Random string (`openssl rand -hex 32`) |
| `SLACK_TEAM_ID` | 2 | Phase 2 migration only | Single-workspace team ID for v1→v2 token backfill |
| `STRIPE_SECRET_KEY` | 3 | Yes | `sk_live_...` (or `sk_test_...` in dev) |
| `STRIPE_WEBHOOK_SECRET` | 3 | Yes | `whsec_...` from Stripe dashboard |
| `STRIPE_PRO_PRICE_ID` | 3 | Yes | Price ID for $3.99/month product |
| `STRIPE_BUSINESS_PRICE_ID` | 3 | Yes | Price ID for $9.99/month product |
| `STRIPE_PORTAL_RETURN_URL` | 3 | Yes | e.g., `https://your-domain.com/billing/return` |
| `APP_URL` | 3 | Yes | Public app URL (used in Stripe success/cancel URLs) |
| `SLACK_APP_ID` | 4 | Yes | For deep-link URLs in DMs (`slack://app?team=X&id=APP_ID`) |

## Repository Structure (target state after all phases)

```
src/
├── app.ts
├── config/index.ts
├── types/index.ts
├── services/
│   ├── token-store.ts          # Phase 1 (encryption), Phase 2 (team_id scope)
│   ├── google-calendar.ts      # Phase 1 (revocation)
│   ├── team-status.ts          # Phase 1 (caching, concurrency)
│   ├── entitlements.ts         # Phase 3 (new)
│   ├── stripe.ts               # Phase 3 (new)
│   ├── workspace-store.ts      # Phase 2 (new)
│   ├── installation-store.ts   # Phase 2 (new)
│   ├── cache.ts                # Phase 1 (new)
│   ├── oauth-state.ts          # Phase 1 (new)
│   ├── digest.ts               # Phase 5 (new)
│   ├── notifications.ts        # Phase 5 (new)
│   └── refresh-scheduler.ts    # Phase 4 (new)
├── ui/
│   ├── home-view.ts            # Phase 3 (tier-aware)
│   ├── week-view.ts            # Phase 5 (new)
│   ├── upgrade-modal.ts        # Phase 3 (new)
│   ├── slash-response.ts       # Phase 4 (new)
│   └── admin-modal.ts          # Phase 5 (new)
├── handlers/
│   ├── app-home.ts
│   ├── actions.ts
│   ├── oauth.ts                # Phase 2 (Slack install route)
│   ├── slash-commands.ts       # Phase 4 (new)
│   ├── stripe-webhooks.ts      # Phase 3 (new)
│   └── scheduled.ts            # Phase 5 (new)
└── utils/
    ├── logger.ts               # Phase 1 (new)
    ├── crypto.ts               # Phase 1 (new)
    ├── html.ts                 # Phase 1 (new)
    ├── concurrency.ts          # Phase 1 (new)
    └── date-parser.ts          # Phase 4 (new)
spec/
├── overview.md                 (this file)
├── phase-1-security-stability.md
├── phase-2-multi-workspace.md
├── phase-3-monetization.md
├── phase-4-pro-features.md
└── phase-5-business-features.md
```

## Success Metrics

| Metric | Phase | Target |
|--------|-------|--------|
| Security vulnerabilities | 1 | 0 open P0/P1 issues |
| Workspace installs | 2 | 50 workspaces in first month post-launch |
| Trial conversion rate | 3 | ≥10% free → paid |
| Paid workspaces | 3 | 100 within 3 months |
| Slash command usage | 4 | Used in ≥60% of Pro workspaces weekly |
| Digest open rate | 5 | ≥40% of digest recipients click through |

## Monitoring & Alerting Strategy

### Logging (Phase 1+)

All structured logs use pino and include a mandatory base context:
```typescript
// Every log line must include:
{ teamId: string, slackUserId?: string, requestId: string }
```

`requestId` is set per inbound event/action using a middleware that generates `crypto.randomUUID()` and attaches it to the request context. On Railway, logs are forwarded to the Railway log viewer; for production consider forwarding to Datadog or Logtail.

### Key log events to monitor

| Event | Level | Alert threshold |
|-------|-------|-----------------|
| `publishHomeView failed` | error | >5/min → PagerDuty |
| `Google API 429 rate limited` | warn | >10/min → Slack #alerts |
| `Stripe webhook signature failed` | error | Any → immediate alert |
| `Digest DM send failed` | warn | >20% failure rate |
| `DB query timeout` | error | Any → PagerDuty |
| `Token decryption failed` | error | Any → immediate alert |

### Health check

Expose `GET /health` (Phase 1) that returns `{ status: 'ok', uptime: number }` with HTTP 200. Railway health checks hit this endpoint; if it fails 3× consecutively, Railway restarts the container.

### Database monitoring

- Railway provides Postgres metrics (connections, query time) in the dashboard
- Add a `pg` event listener to log slow queries: `pool.on('error', ...)` and query duration threshold of 500ms
