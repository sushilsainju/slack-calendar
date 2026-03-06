export interface GoogleTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  token_type?: string | null;
  scope?: string | null;
}

export interface UserTokenRecord {
  slackUserId: string;
  googleEmail: string;
  tokens: GoogleTokens;
}

/** Status for a team member on a given date */
export type MemberStatus = 'available' | 'out_of_office' | 'in_meeting' | 'not_connected' | 'unknown';

export interface MemberStatusInfo {
  slackUserId: string;
  displayName: string;
  avatarUrl?: string;
  status: MemberStatus;
  /** Human-readable detail, e.g. "Vacation" or "Team Standup (10:00 AM – 10:30 AM)" */
  statusLabel?: string;
}

export type StatusFilter = 'all' | 'out_of_office' | 'in_meeting';
export type ViewMode = 'list' | 'week' | 'month';

/** A single OOO span for a team member (inclusive dates) */
export interface OOOSpan {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD (inclusive)
  label: string;
}

export interface MemberOOOSpans {
  slackUserId: string;
  displayName: string;
  avatarUrl?: string;
  spans: OOOSpan[];
}

export interface DayStatus {
  status: MemberStatus;
  statusLabel?: string;
}

export interface WeekMemberStatus {
  slackUserId: string;
  displayName: string;
  avatarUrl?: string;
  /** Mon–Fri statuses (5 entries) */
  dayStatuses: DayStatus[];
}

export interface ViewState {
  /** ISO date string "YYYY-MM-DD" */
  date: string;
  filter: StatusFilter;
  /** 0-indexed page for member list pagination; defaults to 0 */
  page?: number;
  /** 'list' (default), 'week', or 'month' */
  view?: ViewMode;
}
