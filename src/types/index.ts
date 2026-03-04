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
export type MemberStatus = 'available' | 'out_of_office' | 'in_meeting' | 'not_connected';

export interface MemberStatusInfo {
  slackUserId: string;
  displayName: string;
  avatarUrl?: string;
  status: MemberStatus;
  /** Human-readable detail, e.g. "Vacation" or "Team Standup (10:00 AM – 10:30 AM)" */
  statusLabel?: string;
}

export type StatusFilter = 'all' | 'out_of_office' | 'in_meeting';

export interface ViewState {
  /** ISO date string "YYYY-MM-DD" */
  date: string;
  filter: StatusFilter;
}
