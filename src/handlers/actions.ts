import { App, BlockAction, ButtonAction } from '@slack/bolt';
import { publishHomeView, todayString } from './app-home';
import { removeTokens } from '../services/token-store';
import { getAuthUrl } from '../services/google-calendar';
import { ViewState } from '../types';

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
    await publishHomeView(app, body.user.id, state);
  });

  // ── Status filter ────────────────────────────────────────────────────────────
  app.action<BlockAction>(/^filter_/, async ({ action, body, ack }) => {
    await ack();
    const state = parseState(getButtonValue(action));
    await publishHomeView(app, body.user.id, state);
  });

  // ── Refresh ──────────────────────────────────────────────────────────────────
  app.action<BlockAction>('refresh_view', async ({ action, body, ack }) => {
    await ack();
    const state = parseState(getButtonValue(action));
    await publishHomeView(app, body.user.id, state);
  });

  // ── Connect Google Calendar ──────────────────────────────────────────────────
  app.action<BlockAction>('connect_google_calendar', async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    const authUrl = getAuthUrl(userId);

    // Open a modal with the OAuth link (trigger_id is available for button clicks)
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
              text: 'Allow Team Calendar to read your Google Calendar events so your teammates can see when you\'re out of office or in a meeting.',
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
    await removeTokens(userId);
    await publishHomeView(app, userId, { date: todayString(), filter: 'all' });
  });
}
