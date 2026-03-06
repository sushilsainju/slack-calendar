import { WebClient } from '@slack/web-api';
import { MemberStatusInfo, StatusFilter, WeekMemberStatus, DayStatus } from '../types';
import { getTokenRecord, saveTokens } from './token-store';
import { getStatusForDate, getWeekStatuses } from './google-calendar';
import { rosterCache, statusCache } from './cache';
import { mapWithConcurrency } from '../utils/concurrency';
import { logger } from '../utils/logger';
import { toDateString } from '../ui/home-view';

const ROSTER_TTL_MS = 5 * 60 * 1000;  // 5 minutes
const STATUS_TTL_MS = 90 * 1000;       // 90 seconds

/**
 * Fetches the full workspace member list and their calendar status for a given date.
 * Members who haven't connected Google Calendar appear as 'not_connected'.
 * The filter parameter narrows the returned list to matching statuses.
 */
export async function getTeamStatuses(
  slackClient: WebClient,
  teamId: string,
  targetDate: Date = new Date(),
  filter: StatusFilter = 'all',
): Promise<MemberStatusInfo[]> {
  // ── Roster (cached per workspace) ────────────────────────────────────────
  const rosterKey = `roster:${teamId}`;
  let eligible = rosterCache.get(rosterKey);
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
    rosterCache.set(rosterKey, eligible, ROSTER_TTL_MS);
    logger.debug({ teamId, count: eligible.length }, '[team-status] Fetched roster from Slack');
  } else {
    logger.debug({ teamId, count: eligible.length }, '[team-status] Roster cache hit');
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

    const record = await getTokenRecord(teamId, user.id!);
    if (!record) return base;

    const statusKey = `status:${teamId}:${user.id}:${dateStr}`;
    const cached = statusCache.get(statusKey);
    if (cached) {
      logger.debug({ teamId, slackUserId: user.id, dateStr }, '[team-status] Status cache hit');
      return { ...base, status: cached.status, statusLabel: cached.statusLabel };
    }

    try {
      const result = await getStatusForDate(record.tokens, targetDate);

      if (result.newTokens) {
        await saveTokens(teamId, user.id!, record.googleEmail, result.newTokens);
      }

      statusCache.set(statusKey, { status: result.status, statusLabel: result.statusLabel }, STATUS_TTL_MS);
      return { ...base, status: result.status, statusLabel: result.statusLabel };
    } catch (err: unknown) {
      const e = err as { code?: number; response?: { status?: number } };
      if (e?.code === 429 || e?.response?.status === 429) {
        logger.warn({ teamId, slackUserId: user.id }, '[team-status] Google API rate limited');
        return { ...base, status: 'unknown' };
      }
      logger.error({ teamId, slackUserId: user.id, err }, '[team-status] Failed to fetch calendar status');
      return { ...base, status: 'unknown' };
    }
  });

  if (filter === 'all') return statuses;
  return statuses.filter((s) => s.status === filter);
}

/**
 * Fetches team member OOO status for an entire Mon–Fri week.
 * Makes one Google Calendar API call per connected user (covering the full week).
 */
export async function getTeamWeekStatuses(
  slackClient: WebClient,
  teamId: string,
  weekMonday: Date,
): Promise<WeekMemberStatus[]> {
  const rosterKey = `roster:${teamId}`;
  let eligible = rosterCache.get(rosterKey);
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
    rosterCache.set(rosterKey, eligible, ROSTER_TTL_MS);
  }

  const weekStr = toDateString(weekMonday);
  const NOT_CONNECTED: DayStatus[] = Array.from({ length: 5 }, () => ({ status: 'not_connected' as const }));
  const UNKNOWN: DayStatus[] = Array.from({ length: 5 }, () => ({ status: 'unknown' as const }));

  return mapWithConcurrency(eligible, 15, async (user): Promise<WeekMemberStatus> => {
    const base: WeekMemberStatus = {
      slackUserId: user.id!,
      displayName: user.profile?.display_name || user.real_name || user.name || user.id!,
      avatarUrl: user.profile?.image_48 || undefined,
      dayStatuses: NOT_CONNECTED,
    };

    const record = await getTokenRecord(teamId, user.id!);
    if (!record) return base;

    const cacheKey = `week:${teamId}:${user.id}:${weekStr}`;
    const cached = statusCache.get(cacheKey) as DayStatus[] | undefined;
    if (cached) return { ...base, dayStatuses: cached };

    try {
      const result = await getWeekStatuses(record.tokens, weekMonday);

      if (result.newTokens) {
        await saveTokens(teamId, user.id!, record.googleEmail, result.newTokens);
      }

      statusCache.set(cacheKey, result.dayStatuses, STATUS_TTL_MS);
      return { ...base, dayStatuses: result.dayStatuses };
    } catch (err: unknown) {
      const e = err as { code?: number; response?: { status?: number } };
      if (e?.code === 429 || e?.response?.status === 429) {
        logger.warn({ teamId, slackUserId: user.id }, '[team-status] Google API rate limited (week)');
        return { ...base, dayStatuses: UNKNOWN };
      }
      logger.error({ teamId, slackUserId: user.id, err }, '[team-status] Failed to fetch week statuses');
      return { ...base, dayStatuses: UNKNOWN };
    }
  });
}

/** Invalidate cached status for a user (call on connect/disconnect). */
export function invalidateUserStatus(teamId: string, slackUserId: string): void {
  statusCache.invalidatePrefix(`status:${teamId}:${slackUserId}:`);
}

/** Invalidate the roster cache for a workspace (call on team membership changes). */
export function invalidateRoster(teamId: string): void {
  rosterCache.invalidate(`roster:${teamId}`);
}
