import { App, BlockAction, ButtonAction } from '@slack/bolt';
import { publishHomeView, todayString } from './app-home';
import { removeTokens, getTokenRecord } from '../services/token-store';
import { getAuthUrl, revokeTokens } from '../services/google-calendar';
import { invalidateUserStatus } from '../services/team-status';
import { getEntitlements, invalidateEntitlements } from '../services/entitlements';
import { getConnectedCount } from '../services/workspace-store';
import { createCheckoutSession } from '../services/stripe';
import { buildUpgradeModal } from '../ui/home-view';
import { ViewState } from '../types';
import { logger } from '../utils/logger';

function parseState(value: string): ViewState {
  try {
    return JSON.parse(value) as ViewState;
  } catch {
    return { date: todayString(), filter: 'all' };
  }
}

function getButtonValue(action: unknown): string {
  return (action as ButtonAction).value ?? '{}';
}

/** Open upgrade modal, handling Stripe errors gracefully. */
async function openUpgradeModal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  triggerId: string,
  teamId: string,
  userId: string,
  featureKey: string,
): Promise<void> {
  let checkoutUrl: string;
  try {
    checkoutUrl = await createCheckoutSession(
      teamId,
      userId,
      process.env.STRIPE_PRO_PRICE_ID!,
    );
  } catch (err) {
    logger.error({ teamId, slackUserId: userId, err }, '[actions] Failed to create Stripe checkout session');
    await client.chat.postEphemeral({
      channel: userId,
      user: userId,
      text: ':warning: Unable to open the upgrade page right now. Please try again in a moment.',
    });
    return;
  }
  await client.views.open({
    trigger_id: triggerId,
    view: buildUpgradeModal(featureKey, checkoutUrl),
  });
}

export function registerActionHandlers(app: App): void {
  // ── Date navigation ──────────────────────────────────────────────────────────
  app.action<BlockAction>(/^navigate_/, async ({ action, body, ack, client }) => {
    await ack();
    const state = parseState(getButtonValue(action));
    await publishHomeView(client, body.team?.id ?? '', body.user.id, { ...state, page: 0 });
  });

  // ── Status filter ────────────────────────────────────────────────────────────
  app.action<BlockAction>(/^filter_/, async ({ action, body, ack, client }) => {
    await ack();
    const state = parseState(getButtonValue(action));
    await publishHomeView(client, body.team?.id ?? '', body.user.id, { ...state, page: 0 });
  });

  // ── Refresh ──────────────────────────────────────────────────────────────────
  app.action<BlockAction>('refresh_view', async ({ action, body, ack, client }) => {
    await ack();
    const state = parseState(getButtonValue(action));
    await publishHomeView(client, body.team?.id ?? '', body.user.id, state);
  });

  // ── Pagination ───────────────────────────────────────────────────────────────
  app.action<BlockAction>('paginate_next', async ({ action, body, ack, client }) => {
    await ack();
    await publishHomeView(client, body.team?.id ?? '', body.user.id, parseState(getButtonValue(action)));
  });

  app.action<BlockAction>('paginate_prev', async ({ action, body, ack, client }) => {
    await ack();
    await publishHomeView(client, body.team?.id ?? '', body.user.id, parseState(getButtonValue(action)));
  });

  app.action<BlockAction>('paginate_noop', async ({ ack }) => { await ack(); });

  // ── Upgrade prompts (locked feature clicks) ──────────────────────────────────
  app.action<BlockAction>(/^upgrade_prompt_/, async ({ action, body, ack, client }) => {
    await ack();
    const featureKey = (action as ButtonAction).value ?? '';
    const teamId = body.team?.id ?? '';
    await openUpgradeModal(client, body.trigger_id ?? '', teamId, body.user.id, featureKey);
  });

  app.action<BlockAction>('upgrade_from_trial_banner', async ({ action, body, ack, client }) => {
    await ack();
    const featureKey = (action as ButtonAction).value ?? '';
    await openUpgradeModal(client, body.trigger_id ?? '', body.team?.id ?? '', body.user.id, featureKey);
  });

  // No-op for upgrade modal submission
  app.action<BlockAction>('open_stripe_checkout', async ({ ack }) => { await ack(); });
  app.action<BlockAction>('open_team_calendar_noop', async ({ ack }) => { await ack(); });
  app.action<BlockAction>('upgrade_modal_noop', async ({ ack }) => { await ack(); });

  // ── Connect Google Calendar ──────────────────────────────────────────────────
  app.action<BlockAction>('connect_google_calendar', async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    const teamId = body.team?.id ?? '';

    // Enforce calendar connect limit for free tier
    const ent = await getEntitlements(teamId);
    const connectedCount = await getConnectedCount(teamId);
    if (connectedCount >= ent.maxConnectedCalendars) {
      await openUpgradeModal(client, body.trigger_id, teamId, userId, 'member_limit');
      return;
    }

    const authUrl = await getAuthUrl(userId, teamId);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Connect Google Calendar' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "Allow Team Calendar to read your Google Calendar events so your teammates can see when you're out of office or in a meeting.",
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*<${authUrl}|:link: Authorize Google Calendar access>*\n\n_This link expires shortly. Only read-only access is requested._`,
            },
          },
        ],
      },
    });
  });

  // ── Disconnect Google Calendar ───────────────────────────────────────────────
  app.action<BlockAction>('disconnect_google_calendar', async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    const teamId = body.team?.id ?? '';

    const record = await getTokenRecord(teamId, userId);
    if (record) await revokeTokens(record.tokens);

    await removeTokens(teamId, userId);
    invalidateUserStatus(teamId, userId);
    logger.info({ teamId, slackUserId: userId }, '[actions] User disconnected Google Calendar');

    await publishHomeView(client, teamId, userId, { date: todayString(), filter: 'all' });
  });
}
