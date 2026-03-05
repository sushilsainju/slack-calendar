import { WebClient } from '@slack/web-api';
import { MemberStatusInfo, StatusFilter } from '../types';
import { getTokenRecord, saveTokens } from './token-store';
import { getStatusForDate } from './google-calendar';
import { rosterCache, statusCache } from './cache';
import { mapWithConcurrency } from '../utils/concurrency';
import { logger } from '../utils/logger';
import { toDateString } from '../ui/home-view';

const ROSTER_TTL_MS = 5 * 60 * 1000;   // 5 minutes
const STATUS_TTL_MS = 90 * 1000;        // 90 seconds
const ROSTER_KEY = 'roster:main';

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
  // ── Roster (cached) ──────────────────────────────────────────────────────
  let eligible = rosterCache.get(ROSTER_KEY);
  if (!eligible) {
    const allUsers: NonNullable<Awaited<ReturnType<typeof slackClient.users.list>>['members']> = [];
    let cursor: string | undefined;
    do {
      const response = await slackClient.users.list({ limit: 200, cursor });
      allUsers.push(...(response.members || []));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);

    eligible = allUsers.filter(
      (u) => u.id && !u.deleted && !u.is_bot && u.id !== 'USLACKBOT',
    );
    rosterCache.set(ROSTER_KEY, eligible, ROSTER_TTL_MS);
    logger.debug({ count: eligible.length }, '[team-status] Fetched roster from Slack');
  } else {
    logger.debug({ count: eligible.length }, '[team-status] Roster cache hit');
  }

  const dateStr = toDateString(targetDate);

  // ── Per-user status (cached, concurrency-limited) ────────────────────────
  const statuses = await mapWithConcurrency(eligible, 15, async (user): Promise<MemberStatusInfo> => {
    const base: MemberStatusInfo = {
      slackUserId: user.id!,
      displayName: user.profile?.display_name || user.real_name || user.name || user.id!,
      avatarUrl: user.profile?.image_48 || undefined,
      status: 'not_connected',
    };

    const record = await getTokenRecord(user.id!);
    if (!record) return base;

    const statusKey = `status:${user.id}:${dateStr}`;
    const cached = statusCache.get(statusKey);
    if (cached) {
      logger.debug({ slackUserId: user.id, dateStr }, '[team-status] Status cache hit');
      return { ...base, status: cached.status, statusLabel: cached.statusLabel };
    }

    try {
      const result = await getStatusForDate(record.tokens, targetDate);

      // Persist refreshed tokens if the Google client refreshed them
      if (result.newTokens) {
        await saveTokens(user.id!, record.googleEmail, result.newTokens);
      }

      statusCache.set(statusKey, { status: result.status, statusLabel: result.statusLabel }, STATUS_TTL_MS);
      return { ...base, status: result.status, statusLabel: result.statusLabel };
    } catch (err: unknown) {
      const e = err as { code?: number; response?: { status?: number } };
      if (e?.code === 429 || e?.response?.status === 429) {
        logger.warn({ slackUserId: user.id }, '[team-status] Google API rate limited — returning unknown status');
        return { ...base, status: 'unknown' };
      }
      logger.error({ slackUserId: user.id, err }, '[team-status] Failed to fetch calendar status');
      return { ...base, status: 'unknown' };
    }
  });

  if (filter === 'all') return statuses;
  return statuses.filter((s) => s.status === filter);
}

/** Invalidate cached status for a specific user (call on connect/disconnect). */
export function invalidateUserStatus(slackUserId: string): void {
  statusCache.invalidatePrefix(`status:${slackUserId}:`);
}

/** Invalidate the roster cache (call on team membership changes). */
export function invalidateRoster(): void {
  rosterCache.invalidate(ROSTER_KEY);
}
