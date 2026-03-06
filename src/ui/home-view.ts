import { MemberStatusInfo, StatusFilter, ViewState, WeekMemberStatus } from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = Record<string, any>;

const PAGE_SIZE = 50;

const STATUS_EMOJI: Record<string, string> = {
  available: ':large_green_circle:',
  out_of_office: ':red_circle:',
  in_meeting: ':large_yellow_circle:',
  not_connected: ':white_circle:',
  unknown: ':grey_question:',
};

const STATUS_LABEL: Record<string, string> = {
  available: 'Available',
  out_of_office: 'Out of Office',
  in_meeting: 'In a Meeting',
  not_connected: 'Calendar not connected',
  unknown: 'Status unavailable',
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
  const page = state.page ?? 0;

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
  const weekViewState: ViewState = { date: state.date, filter: 'all', view: 'week' };

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
      btn(':calendar: Week View', 'switch_view_week', weekViewState),
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

  // ── Member list (paginated) ──────────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(members.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const paged = members.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  if (paged.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No team members match this filter._' },
    });
  } else {
    for (const member of paged) {
      const emoji = STATUS_EMOJI[member.status] ?? ':grey_question:';
      const label = member.statusLabel || STATUS_LABEL[member.status] || member.status;
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

  // ── Pagination controls ──────────────────────────────────────────────────────
  if (totalPages > 1) {
    const prevState: ViewState = { ...state, page: clampedPage - 1 };
    const nextState: ViewState = { ...state, page: clampedPage + 1 };

    blocks.push({
      type: 'actions',
      block_id: 'pagination',
      elements: [
        ...(clampedPage > 0
          ? [{ type: 'button' as const, text: { type: 'plain_text' as const, text: '← Previous', emoji: true }, action_id: 'paginate_prev', value: JSON.stringify(prevState) }]
          : []),
        { type: 'button' as const, text: { type: 'plain_text' as const, text: `Page ${clampedPage + 1} of ${totalPages}`, emoji: false }, action_id: 'paginate_noop', value: JSON.stringify(state) },
        ...(clampedPage < totalPages - 1
          ? [{ type: 'button' as const, text: { type: 'plain_text' as const, text: 'Next →', emoji: true }, action_id: 'paginate_next', value: JSON.stringify(nextState) }]
          : []),
      ],
    });
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
      elements: [{ type: 'mrkdwn', text: ':white_check_mark: Google Calendar connected' }],
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
            text: { type: 'mrkdwn', text: 'Your calendar status will no longer be visible to your team.' },
            confirm: { type: 'plain_text', text: 'Disconnect' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      ],
    });
  }

  return { type: 'home', blocks };
}

// ── Week calendar view ────────────────────────────────────────────────────────

export function getWeekMonday(dateStr: string): Date {
  const d = parseLocalDate(dateStr);
  const dow = d.getDay(); // 0=Sun … 6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return d;
}

function formatWeekRange(monday: Date): string {
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    d.toLocaleDateString('en-US', opts);
  const monLabel = fmt(monday, { month: 'short', day: 'numeric' });
  if (monday.getMonth() === friday.getMonth()) {
    return `${monLabel}–${friday.getDate()}, ${monday.getFullYear()}`;
  }
  return `${monLabel} – ${fmt(friday, { month: 'short', day: 'numeric' })}, ${friday.getFullYear()}`;
}

/**
 * Builds the week calendar view.
 * Shows Mon–Fri with OOO members listed per day.
 * Members without calendars or who are available are summarised in counts only.
 */
export function buildWeekView(
  weekMembers: WeekMemberStatus[],
  weekMonday: Date,
  state: ViewState,
  isViewerConnected: boolean,
): { type: 'home'; blocks: Block[] } {
  const blocks: Block[] = [];
  const today = toDateString(new Date());
  const weekRange = formatWeekRange(weekMonday);

  // ── Header ──────────────────────────────────────────────────────────────────
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: ':calendar: Team Calendar', emoji: true },
  });

  // ── Week navigation ──────────────────────────────────────────────────────────
  const prevMonday = new Date(weekMonday);
  prevMonday.setDate(weekMonday.getDate() - 7);
  const nextMonday = new Date(weekMonday);
  nextMonday.setDate(weekMonday.getDate() + 7);
  const listViewState: ViewState = { date: state.date, filter: 'all', view: 'list' };

  blocks.push({
    type: 'actions',
    block_id: 'week_nav',
    elements: [
      btn('← Prev Week', 'navigate_prev_week', { date: toDateString(prevMonday), filter: 'all', view: 'week' }),
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Today', emoji: true },
        action_id: 'navigate_today_week',
        value: JSON.stringify({ date: today, filter: 'all', view: 'week' }),
      },
      btn('Next Week →', 'navigate_next_week', { date: toDateString(nextMonday), filter: 'all', view: 'week' }),
      btn(':bust_in_silhouette: List View', 'switch_view_list', listViewState),
    ],
  });

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Week of ${weekRange}*` },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: ':arrows_counterclockwise: Refresh', emoji: true },
      action_id: 'refresh_view',
      value: JSON.stringify(state),
    },
  });

  blocks.push({ type: 'divider' });

  // ── Day-by-day breakdown ─────────────────────────────────────────────────────
  const connectedMembers = weekMembers.filter((m) => m.dayStatuses[0].status !== 'not_connected');
  const totalConnected = connectedMembers.length;

  for (let i = 0; i < 5; i++) {
    const day = new Date(weekMonday);
    day.setDate(weekMonday.getDate() + i);
    const dayStr = toDateString(day);
    const isToday = dayStr === today;
    const dayLabel = day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    const oooMembers = connectedMembers.filter((m) => m.dayStatuses[i].status === 'out_of_office');
    const availableCount = connectedMembers.filter((m) => m.dayStatuses[i].status === 'available').length;

    let summaryText = isToday ? `*${dayLabel}*  _(today)_` : `*${dayLabel}*`;
    if (totalConnected === 0) {
      summaryText += '  ·  _No calendars connected_';
    } else if (oooMembers.length === 0) {
      summaryText += `  ·  :large_green_circle: All ${availableCount} available`;
    } else {
      summaryText += `  ·  :red_circle: ${oooMembers.length} OOO  ·  :large_green_circle: ${availableCount} available`;
    }

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: summaryText },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Day View →', emoji: true },
        action_id: 'navigate_to_day',
        value: JSON.stringify({ date: dayStr, filter: 'all', view: 'list' }),
      },
    });

    // OOO members listed below the day header (up to 10 context elements per block)
    if (oooMembers.length > 0) {
      const chunk: Block[] = [];
      for (const m of oooMembers) {
        if (m.avatarUrl) {
          chunk.push({ type: 'image', image_url: m.avatarUrl, alt_text: m.displayName });
        }
        const reason = m.dayStatuses[i].statusLabel || 'Out of Office';
        chunk.push({ type: 'mrkdwn', text: `*<@${m.slackUserId}>*  ·  _${reason}_` });
        if (chunk.length >= 10) {
          blocks.push({ type: 'context', elements: [...chunk] });
          chunk.length = 0;
        }
      }
      if (chunk.length > 0) {
        blocks.push({ type: 'context', elements: chunk });
      }
    }
  }

  blocks.push({ type: 'divider' });

  // ── Google Calendar connection ────────────────────────────────────────────────
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
      elements: [{ type: 'mrkdwn', text: ':white_check_mark: Google Calendar connected' }],
    });
  }

  // ── Legend ───────────────────────────────────────────────────────────────────
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: ':red_circle: Out of Office  ·  :large_green_circle: Available  ·  :white_circle: Calendar not connected',
    }],
  });

  return { type: 'home', blocks };
}

export function buildErrorView(state: ViewState): { type: 'home'; blocks: Block[] } {
  return {
    type: 'home',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: ':calendar: Team Calendar', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':warning: *Something went wrong loading your team calendar.*\n_This is usually a temporary issue. Try refreshing._',
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: ':arrows_counterclockwise: Refresh', emoji: true },
          action_id: 'refresh_view',
          value: JSON.stringify(state),
        },
      },
    ],
  };
}

export function buildLoadingView(): { type: 'home'; blocks: Block[] } {
  return {
    type: 'home',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: ':calendar: Team Calendar', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: '_Loading team calendar…_' } },
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

export function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function shiftDate(dateStr: string, days: number): string {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  return toDateString(d);
}
