import { App } from '@slack/bolt';
import { buildHomeView, buildLoadingView, buildErrorView, toDateString, parseLocalDate } from '../ui/home-view';
import { getTeamStatuses } from '../services/team-status';
import { isConnected } from '../services/token-store';
import { ViewState } from '../types';
import { logger } from '../utils/logger';

export function todayString(): string {
  return toDateString(new Date());
}

/**
 * Fetches team statuses and publishes the App Home view for the given user and state.
 * Call this whenever the state changes (date navigation, filter, connect/disconnect).
 */
export async function publishHomeView(app: App, userId: string, state: ViewState): Promise<void> {
  const localDate = parseLocalDate(state.date);
  const now = new Date();
  const targetDate = new Date(
    localDate.getFullYear(),
    localDate.getMonth(),
    localDate.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  );

  try {
    const [members, connected] = await Promise.all([
      getTeamStatuses(app.client, targetDate, state.filter),
      isConnected(userId),
    ]);

    const view = buildHomeView(members, state, connected);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await app.client.views.publish({ user_id: userId, view: view as any });
  } catch (err) {
    logger.error({ slackUserId: userId, err }, '[app-home] Failed to publish home view');
    await app.client.views
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .publish({ user_id: userId, view: buildErrorView(state) as any })
      .catch((innerErr) => {
        logger.error(
          { slackUserId: userId, err: innerErr },
          '[app-home] Failed to publish error view',
        );
      });
  }
}

export function registerAppHomeHandlers(app: App): void {
  app.event('app_home_opened', async ({ event, client }) => {
    if (event.tab !== 'home') return;

    const userId = event.user;

    // Show a loading skeleton immediately so the tab doesn't appear stuck
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.views.publish({ user_id: userId, view: buildLoadingView() as any });

    await publishHomeView(app, userId, { date: todayString(), filter: 'all' });
  });
}
