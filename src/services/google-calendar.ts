import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config';
import { GoogleTokens, MemberStatus } from '../types';
import { createOAuthState } from './oauth-state';
import { logger } from '../utils/logger';

export interface CalendarStatus {
  status: MemberStatus;
  statusLabel?: string;
}

function createOAuth2Client(): OAuth2Client {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
}

export async function getAuthUrl(slackUserId: string, teamId: string): Promise<string> {
  const auth = createOAuth2Client();
  const state = await createOAuthState(slackUserId, teamId);
  return auth.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state,
    prompt: 'consent', // force refresh_token to be returned
  });
}

export async function exchangeCode(code: string): Promise<{ tokens: GoogleTokens; email: string }> {
  const auth = createOAuth2Client();
  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth });
  const { data } = await oauth2.userinfo.get();

  return { tokens, email: data.email || 'unknown' };
}

export async function revokeTokens(tokens: GoogleTokens): Promise<void> {
  if (!tokens.access_token) return;
  try {
    const auth = createOAuth2Client();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth.setCredentials(tokens as any);
    await auth.revokeToken(tokens.access_token);
  } catch (err) {
    // Non-fatal: token may have already expired; DB removal still proceeds
    logger.warn({ err }, '[google-calendar] Token revocation failed — token may have already expired');
  }
}

/**
 * Fetches the calendar status for a user on the given date.
 *
 * Priority order: Out of Office → In Meeting (today only) → Available
 *
 * Returns updated tokens if they were refreshed, so the caller can persist them.
 */
export async function getStatusForDate(
  tokens: GoogleTokens,
  targetDate: Date = new Date(),
): Promise<CalendarStatus & { newTokens?: GoogleTokens }> {
  const auth = createOAuth2Client();
  // Strip nulls — googleapis Credentials type only accepts string | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth.setCredentials(tokens as any);

  let newTokens: GoogleTokens | undefined;
  // googleapis auto-refreshes tokens when expired; capture the new tokens
  auth.on('tokens', (refreshed) => {
    newTokens = { ...tokens, ...refreshed };
  });

  const calendar = google.calendar({ version: 'v3', auth });

  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });

  const events = response.data.items || [];

  // 1. Check for Google-native Out of Office event type
  const oooEvent = events.find((e) => e.eventType === 'outOfOffice');
  if (oooEvent) {
    return { status: 'out_of_office', statusLabel: oooEvent.summary || 'Out of Office', newTokens };
  }

  // 2. Check for all-day events with common OOO keywords
  const OOO_KEYWORDS = ['out of office', 'ooo', 'vacation', 'holiday', 'leave', 'pto', 'off'];
  const allDayOoo = events.find((e) => {
    if (!e.start?.date || e.start?.dateTime) return false; // only all-day events
    const title = (e.summary || '').toLowerCase();
    return OOO_KEYWORDS.some((kw) => title.includes(kw));
  });
  if (allDayOoo) {
    return { status: 'out_of_office', statusLabel: allDayOoo.summary || 'Out of Office', newTokens };
  }

  // 3. Check for a meeting happening right now (only meaningful for today)
  const now = new Date();
  const isToday = targetDate.toDateString() === now.toDateString();
  if (isToday) {
    const activeMeeting = events.find((e) => {
      if (!e.start?.dateTime || !e.end?.dateTime) return false; // skip all-day
      if (e.status === 'cancelled') return false;
      if (e.transparency === 'transparent') return false; // marked as "free"
      const start = new Date(e.start.dateTime);
      const end = new Date(e.end.dateTime);
      return start <= now && now <= end;
    });
    if (activeMeeting) {
      const timeStr = formatTimeRange(
        new Date(activeMeeting.start!.dateTime!),
        new Date(activeMeeting.end!.dateTime!),
      );
      return {
        status: 'in_meeting',
        statusLabel: `${activeMeeting.summary || 'Meeting'} (${timeStr})`,
        newTokens,
      };
    }
  }

  return { status: 'available', newTokens };
}

function formatTimeRange(start: Date, end: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${fmt(start)} – ${fmt(end)}`;
}
