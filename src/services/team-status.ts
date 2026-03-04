import { WebClient } from '@slack/web-api';
import { MemberStatusInfo, StatusFilter } from '../types';
import { getTokenRecord, saveTokens, isConnected } from './token-store';
import { getStatusForDate } from './google-calendar';

/**
 * Fetches the full workspace member list and their calendar status for a given date.
 * Members who haven't connected Google Calendar appear as 'not_connected'.
 * The filter parameter narrows the returned list to matching statuses.
 */
export async function getTeamStatuses(
  slackClient: WebClient,
  targetDate: Date = new Date(),
  filter: StatusFilter = 'all',
): Promise<MemberStatusInfo[]> {
  // Paginate through all workspace members
  const allUsers: NonNullable<Awaited<ReturnType<typeof slackClient.users.list>>['members']> = [];
  let cursor: string | undefined;
  do {
    const response = await slackClient.users.list({ limit: 200, cursor });
    allUsers.push(...(response.members || []));
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const eligible = allUsers.filter(
    (u) => u.id && !u.deleted && !u.is_bot && u.id !== 'USLACKBOT',
  );

  const statusPromises = eligible.map(async (user): Promise<MemberStatusInfo> => {
    const base: MemberStatusInfo = {
      slackUserId: user.id!,
      displayName: user.profile?.display_name || user.real_name || user.name || user.id!,
      avatarUrl: user.profile?.image_48 || undefined,
      status: 'not_connected',
    };

    if (!(await isConnected(user.id!))) return base;

    const record = await getTokenRecord(user.id!);
    if (!record) return base;

    try {
      const result = await getStatusForDate(record.tokens, targetDate);

      // Persist refreshed tokens if the Google client refreshed them
      if (result.newTokens) {
        await saveTokens(user.id!, record.googleEmail, result.newTokens);
      }

      return { ...base, status: result.status, statusLabel: result.statusLabel };
    } catch (err) {
      console.error(`[team-status] Failed to fetch calendar for ${user.id}:`, err);
      return base;
    }
  });

  const statuses = await Promise.all(statusPromises);

  if (filter === 'all') return statuses;
  return statuses.filter((s) => s.status === filter);
}
