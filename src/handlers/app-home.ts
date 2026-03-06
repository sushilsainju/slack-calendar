import { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import {
  buildHomeView,
  buildWeekView,
  buildMonthView,
  buildLoadingView,
  buildErrorView,
  toDateString,
  parseLocalDate,
  getWeekMonday,
  getMonthStart,
} from '../ui/home-view';
import { getTeamStatuses, getTeamWeekStatuses, getTeamMonthOOO } from '../services/team-status';
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
export async function publishHomeView(
  client: WebClient,
  teamId: string,
  userId: string,
  state: ViewState,
): Promise<void> {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let view: any;

    if (state.view === 'month') {
      const monthStart = parseLocalDate(getMonthStart(state.date));
      const [memberOOO, connected] = await Promise.all([
        getTeamMonthOOO(client, teamId, monthStart),
        isConnected(teamId, userId),
      ]);
      view = buildMonthView(memberOOO, monthStart, state, connected);
    } else if (state.view === 'week') {
      const weekMonday = getWeekMonday(state.date);
      const [weekMembers, connected] = await Promise.all([
        getTeamWeekStatuses(client, teamId, weekMonday),
        isConnected(teamId, userId),
      ]);
      view = buildWeekView(weekMembers, weekMonday, state, connected);
    } else {
      const [members, connected] = await Promise.all([
        getTeamStatuses(client, teamId, targetDate, state.filter),
        isConnected(teamId, userId),
      ]);
      view = buildHomeView(members, state, connected);
    }

    await client.views.publish({ user_id: userId, view });
  } catch (err) {
    logger.error({ teamId, slackUserId: userId, err }, '[app-home] Failed to publish home view');
    await client.views
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .publish({ user_id: userId, view: buildErrorView(state) as any })
      .catch((innerErr) => {
        logger.error(
          { teamId, slackUserId: userId, err: innerErr },
          '[app-home] Failed to publish error view',
        );
      });
  }
}

export function registerAppHomeHandlers(app: App): void {
  app.event('app_home_opened', async ({ event, client, body }) => {
    if (event.tab !== 'home') return;

    const userId = event.user;
    const teamId = body.team_id;

    // Show a loading skeleton immediately
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.views.publish({ user_id: userId, view: buildLoadingView() as any });

    await publishHomeView(client, teamId, userId, { date: todayString(), filter: 'all' });
  });
}
