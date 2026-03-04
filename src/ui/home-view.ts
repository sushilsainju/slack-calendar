import { MemberStatusInfo, StatusFilter, ViewState } from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = Record<string, any>;

const STATUS_EMOJI: Record<string, string> = {
  available: ':large_green_circle:',
  out_of_office: ':red_circle:',
  in_meeting: ':large_yellow_circle:',
  not_connected: ':white_circle:',
};

const STATUS_LABEL: Record<string, string> = {
  available: 'Available',
  out_of_office: 'Out of Office',
  in_meeting: 'In a Meeting',
  not_connected: 'Calendar not connected',
};

export function buildHomeView(
  members: MemberStatusInfo[],
  state: ViewState,
  isViewerConnected: boolean,
): { type: 'home'; blocks: Block[] } {
  const blocks: Block[] = [];
  const displayDate = parseLocalDate(state.date);
  const today = toDateString(new Date());
  const isToday = state.date === today;

  const dateLabel = displayDate.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  // ── Header ──────────────────────────────────────────────────────────────────
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: ':calendar: Team Calendar', emoji: true },
  });

  // ── Date navigation ─────────────────────────────────────────────────────────
  const prevDate = shiftDate(state.date, -1);
  const nextDate = shiftDate(state.date, +1);

  blocks.push({
    type: 'actions',
    block_id: 'date_nav',
    elements: [
      btn('← Prev', 'navigate_prev', { date: prevDate, filter: state.filter }),
      {
        type: 'button',
        text: { type: 'plain_text', text: isToday ? '• Today' : 'Today', emoji: true },
        action_id: 'navigate_today',
        value: JSON.stringify({ date: today, filter: state.filter }),
        style: isToday ? 'primary' : undefined,
      },
      btn('Next →', 'navigate_next', { date: nextDate, filter: state.filter }),
    ],
  });

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*${dateLabel}*` },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: ':arrows_counterclockwise: Refresh', emoji: true },
      action_id: 'refresh_view',
      value: JSON.stringify(state),
    },
  });

  blocks.push({ type: 'divider' });

  // ── Status filter ────────────────────────────────────────────────────────────
  blocks.push({
    type: 'actions',
    block_id: 'status_filter',
    elements: [
      filterBtn('All Members', 'all', state),
      filterBtn(':red_circle: Out of Office', 'out_of_office', state),
      filterBtn(':large_yellow_circle: In Meeting', 'in_meeting', state),
    ],
  });

  blocks.push({ type: 'divider' });

  // ── Summary counts ───────────────────────────────────────────────────────────
  if (state.filter === 'all') {
    const ooo = members.filter((m) => m.status === 'out_of_office').length;
    const meeting = members.filter((m) => m.status === 'in_meeting').length;
    const available = members.filter((m) => m.status === 'available').length;
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${members.length} members  ·  :red_circle: ${ooo} OOO  ·  :large_yellow_circle: ${meeting} in meetings  ·  :large_green_circle: ${available} available`,
        },
      ],
    });
    blocks.push({ type: 'divider' });
  }

  // ── Member list ──────────────────────────────────────────────────────────────
  if (members.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No team members match this filter._' },
    });
  } else {
    for (const member of members) {
      const emoji = STATUS_EMOJI[member.status];
      const label = member.statusLabel || STATUS_LABEL[member.status];
      const contextElements: Block[] = [];

      if (member.avatarUrl) {
        contextElements.push({
          type: 'image',
          image_url: member.avatarUrl,
          alt_text: member.displayName,
        });
      }

      contextElements.push({
        type: 'mrkdwn',
        text: `${emoji}  *<@${member.slackUserId}>*    ${label}`,
      });

      blocks.push({ type: 'context', elements: contextElements });
    }
  }

  blocks.push({ type: 'divider' });

  // ── Google Calendar connection ───────────────────────────────────────────────
  if (!isViewerConnected) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':link: *Connect your Google Calendar* to show your status to teammates.',
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Connect Google Calendar', emoji: true },
        action_id: 'connect_google_calendar',
        style: 'primary',
      },
    });
  } else {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: ':white_check_mark: Google Calendar connected  ·  <slack://app?action=disconnect_google_calendar|Disconnect>',
        },
      ],
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Disconnect Google Calendar', emoji: true },
          action_id: 'disconnect_google_calendar',
          style: 'danger',
          confirm: {
            title: { type: 'plain_text', text: 'Disconnect Google Calendar?' },
            text: {
              type: 'mrkdwn',
              text: 'Your calendar status will no longer be visible to your team.',
            },
            confirm: { type: 'plain_text', text: 'Disconnect' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      ],
    });
  }

  return { type: 'home', blocks };
}

export function buildLoadingView(): { type: 'home'; blocks: Block[] } {
  return {
    type: 'home',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: ':calendar: Team Calendar', emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '_Loading team calendar…_' },
      },
    ],
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function btn(label: string, actionId: string, newState: ViewState): Block {
  return {
    type: 'button',
    text: { type: 'plain_text', text: label, emoji: true },
    action_id: actionId,
    value: JSON.stringify(newState),
  };
}

function filterBtn(label: string, filter: StatusFilter, currentState: ViewState): Block {
  const isActive = currentState.filter === filter;
  return {
    type: 'button',
    text: { type: 'plain_text', text: label, emoji: true },
    action_id: `filter_${filter}`,
    value: JSON.stringify({ date: currentState.date, filter }),
    style: isActive ? 'primary' : undefined,
  };
}

export function toDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parse "YYYY-MM-DD" as a local date (avoids UTC offset shifting the day). */
export function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function shiftDate(dateStr: string, days: number): string {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  return toDateString(d);
}
