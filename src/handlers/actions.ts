import { App, BlockAction, ButtonAction } from '@slack/bolt';
import { publishHomeView, todayString } from './app-home';
import { removeTokens } from '../services/token-store';
import { getAuthUrl, revokeTokens } from '../services/google-calendar';
import { getTokenRecord } from '../services/token-store';
import { invalidateUserStatus } from '../services/team-status';
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

export function registerActionHandlers(app: App): void {
  // ── Date navigation ──────────────────────────────────────────────────────────
  app.action<BlockAction>(/^navigate_/, async ({ action, body, ack }) => {
    await ack();
    const state = parseState(getButtonValue(action));
    await publishHomeView(app, body.user.id, { ...state, page: 0 });
  });

  // ── Status filter ────────────────────────────────────────────────────────────
  app.action<BlockAction>(/^filter_/, async ({ action, body, ack }) => {
    await ack();
    const state = parseState(getButtonValue(action));
    await publishHomeView(app, body.user.id, { ...state, page: 0 });
  });

  // ── Refresh ──────────────────────────────────────────────────────────────────
  app.action<BlockAction>('refresh_view', async ({ action, body, ack }) => {
    await ack();
    const state = parseState(getButtonValue(action));
    await publishHomeView(app, body.user.id, state);
  });

  // ── Pagination ───────────────────────────────────────────────────────────────
  app.action<BlockAction>('paginate_next', async ({ action, body, ack }) => {
    await ack();
    const state = parseState(getButtonValue(action));
    await publishHomeView(app, body.user.id, state);
  });

  app.action<BlockAction>('paginate_prev', async ({ action, body, ack }) => {
    await ack();
    const state = parseState(getButtonValue(action));
    await publishHomeView(app, body.user.id, state);
  });

  // No-op for the "Page X of Y" label button
  app.action<BlockAction>('paginate_noop', async ({ ack }) => {
    await ack();
  });

  // ── Connect Google Calendar ──────────────────────────────────────────────────
  app.action<BlockAction>('connect_google_calendar', async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    const authUrl = await getAuthUrl(userId);

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
  app.action<BlockAction>('disconnect_google_calendar', async ({ body, ack }) => {
    await ack();
    const userId = body.user.id;

    // Revoke tokens with Google before removing from DB
    const record = await getTokenRecord(userId);
    if (record) {
      await revokeTokens(record.tokens);
    }

    await removeTokens(userId);
    invalidateUserStatus(userId);
    logger.info({ slackUserId: userId }, '[actions] User disconnected Google Calendar');

    await publishHomeView(app, userId, { date: todayString(), filter: 'all' });
  });
}
