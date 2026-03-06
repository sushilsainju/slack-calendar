import { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { buildHomeView, buildLoadingView, buildErrorView, toDateString, parseLocalDate } from '../ui/home-view';
import { getTeamStatuses } from '../services/team-status';
import { isConnected } from '../services/token-store';
import { getEntitlements, getTrialState } from '../services/entitlements';
import { ViewState } from '../types';
import { logger } from '../utils/logger';

export function todayString(): string {
  return toDateString(new Date());
}

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
    const [members, connected, ent, trial] = await Promise.all([
      getTeamStatuses(client, teamId, targetDate, state.filter),
      isConnected(teamId, userId),
      getEntitlements(teamId),
      getTrialState(teamId),
    ]);

    const view = buildHomeView(members, state, connected, ent, trial);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.views.publish({ user_id: userId, view: view as any });
  } catch (err) {
    logger.error({ teamId, slackUserId: userId, err }, '[app-home] Failed to publish home view');
    await client.views
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .publish({ user_id: userId, view: buildErrorView(state) as any })
      .catch((innerErr) => {
        logger.error({ teamId, slackUserId: userId, err: innerErr }, '[app-home] Failed to publish error view');
      });
  }
}

export function registerAppHomeHandlers(app: App): void {
  app.event('app_home_opened', async ({ event, client, body }) => {
    if (event.tab !== 'home') return;
    const userId = event.user;
    const teamId = body.team_id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.views.publish({ user_id: userId, view: buildLoadingView() as any });
    await publishHomeView(client, teamId, userId, { date: todayString(), filter: 'all' });
  });
}
