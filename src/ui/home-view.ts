import { MemberStatusInfo, MemberOOOSpans, StatusFilter, ViewState, WeekMemberStatus } from '../types';

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

/**
 * Dashboard-style home view.
 * In "all" filter mode: groups members by status (OOO → Meeting → Available → Not Connected).
 * In filter mode: flat paginated list of matching members.
 */
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
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  // ── Header ──────────────────────────────────────────────────────────────────
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: ':calendar: Team Calendar', emoji: true },
  });

  // ── Date navigation ─────────────────────────────────────────────────────────
  const prevDate = shiftDate(state.date, -1);
  const nextDate = shiftDate(state.date, +1);
  const weekMonday = getWeekMonday(state.date);

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
      btn('Week', 'switch_view_week', { date: toDateString(weekMonday), filter: 'all', view: 'week' }),
      btn('Month', 'switch_view_month', { date: getMonthStart(state.date), filter: 'all', view: 'month' }),
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

  if (state.filter === 'all') {
    // ── Dashboard: grouped by status ─────────────────────────────────────────
    const oooMembers = members.filter((m) => m.status === 'out_of_office');
    const meetingMembers = members.filter((m) => m.status === 'in_meeting');
    const availableMembers = members.filter((m) => m.status === 'available');
    const notConnectedCount = members.filter((m) => m.status === 'not_connected').length;
    const connectedCount = members.length - notConnectedCount;

    // Stats row
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: [
          `:large_green_circle: *${availableMembers.length}* Available`,
          `:large_yellow_circle: *${meetingMembers.length}* In Meeting`,
          `:red_circle: *${oooMembers.length}* Out of Office`,
          `:white_circle: *${notConnectedCount}* Not Connected`,
        ].join('   '),
      }],
    });

    // Quick-filter shortcuts
    blocks.push({
      type: 'actions',
      block_id: 'status_filter',
      elements: [
        filterBtn(':red_circle: OOO', 'out_of_office', state),
        filterBtn(':large_yellow_circle: In Meeting', 'in_meeting', state),
      ],
    });

    blocks.push({ type: 'divider' });

    if (connectedCount === 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '_No team members have connected their Google Calendar yet._' },
      });
    } else {
      // Out of Office section
      if (oooMembers.length > 0) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: ':red_circle: *Out of Office*' },
        });
        for (const m of oooMembers) {
          const reason = m.statusLabel || 'Out of Office';
          const elems: Block[] = [];
          if (m.avatarUrl) elems.push({ type: 'image', image_url: m.avatarUrl, alt_text: m.displayName });
          elems.push({ type: 'mrkdwn', text: `*<@${m.slackUserId}>*  ·  _${reason}_` });
          blocks.push({ type: 'context', elements: elems });
        }
      }

      // In a Meeting section
      if (meetingMembers.length > 0) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: ':large_yellow_circle: *In a Meeting*' },
        });
        for (const m of meetingMembers) {
          const reason = m.statusLabel || 'In a Meeting';
          const elems: Block[] = [];
          if (m.avatarUrl) elems.push({ type: 'image', image_url: m.avatarUrl, alt_text: m.displayName });
          elems.push({ type: 'mrkdwn', text: `*<@${m.slackUserId}>*  ·  _${reason}_` });
          blocks.push({ type: 'context', elements: elems });
        }
      }

      // Available section — compact inline list
      if (availableMembers.length > 0) {
        const MAX_SHOWN = 20;
        const shown = availableMembers.slice(0, MAX_SHOWN);
        const overflow = availableMembers.length - shown.length;
        const nameList = shown.map((m) => `<@${m.slackUserId}>`).join('  ');
        const overflowText = overflow > 0 ? `  _+${overflow} more_` : '';
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `:large_green_circle: *Available*\n${nameList}${overflowText}` },
        });
      }

      // Not connected note
      if (notConnectedCount > 0) {
        blocks.push({
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `:white_circle: _${notConnectedCount} team member${notConnectedCount !== 1 ? 's have' : ' has'} not connected Google Calendar_`,
          }],
        });
      }
    }
  } else {
    // ── Filter view: flat paginated list ─────────────────────────────────────
    const filterLabel = state.filter === 'out_of_office'
      ? ':red_circle: Out of Office'
      : ':large_yellow_circle: In a Meeting';

    blocks.push({
      type: 'actions',
      block_id: 'status_filter',
      elements: [
        filterBtn('All Members', 'all', state),
        filterBtn(':red_circle: OOO', 'out_of_office', state),
        filterBtn(':large_yellow_circle: In Meeting', 'in_meeting', state),
      ],
    });

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Showing: ${filterLabel}  ·  ${members.length} members` }],
    });

    blocks.push({ type: 'divider' });

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
        const elems: Block[] = [];
        if (member.avatarUrl) elems.push({ type: 'image', image_url: member.avatarUrl, alt_text: member.displayName });
        elems.push({ type: 'mrkdwn', text: `${emoji}  *<@${member.slackUserId}>*    ${label}` });
        blocks.push({ type: 'context', elements: elems });
      }
    }

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
  }

  blocks.push({ type: 'divider' });
  buildConnectionSection(blocks, isViewerConnected, state);

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
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-US', opts);
  const monLabel = fmt(monday, { month: 'short', day: 'numeric' });
  if (monday.getMonth() === friday.getMonth()) {
    return `${monLabel}–${friday.getDate()}, ${monday.getFullYear()}`;
  }
  return `${monLabel} – ${fmt(friday, { month: 'short', day: 'numeric' })}, ${friday.getFullYear()}`;
}

/**
 * Builds the week calendar view.
 * Shows Mon–Fri with OOO members listed per day.
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
      btn('List', 'switch_view_list', { date: today, filter: 'all', view: 'list' }),
      btn('Month', 'switch_view_month', { date: getMonthStart(toDateString(weekMonday)), filter: 'all', view: 'month' }),
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
    const isCurrentDay = dayStr === today;
    const dayLabel = day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    const oooMembers = connectedMembers.filter((m) => m.dayStatuses[i].status === 'out_of_office');
    const availableCount = connectedMembers.filter((m) => m.dayStatuses[i].status === 'available').length;

    let summaryText = isCurrentDay ? `*${dayLabel}*  _(today)_` : `*${dayLabel}*`;
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

    if (oooMembers.length > 0) {
      const chunk: Block[] = [];
      for (const m of oooMembers) {
        if (m.avatarUrl) chunk.push({ type: 'image', image_url: m.avatarUrl, alt_text: m.displayName });
        const reason = m.dayStatuses[i].statusLabel || 'Out of Office';
        chunk.push({ type: 'mrkdwn', text: `*<@${m.slackUserId}>*  ·  _${reason}_` });
        if (chunk.length >= 10) {
          blocks.push({ type: 'context', elements: [...chunk] });
          chunk.length = 0;
        }
      }
      if (chunk.length > 0) blocks.push({ type: 'context', elements: chunk });
    }
  }

  blocks.push({ type: 'divider' });
  buildConnectionSection(blocks, isViewerConnected, state);

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: ':red_circle: Out of Office  ·  :large_green_circle: Available  ·  :white_circle: Calendar not connected',
    }],
  });

  return { type: 'home', blocks };
}

// ── Month calendar view ───────────────────────────────────────────────────────

/**
 * Builds the month view.
 * Shows OOO spans per connected member, plus a weekly overview with "View Week" buttons.
 */
export function buildMonthView(
  memberOOO: MemberOOOSpans[],
  monthStart: Date,
  state: ViewState,
  isViewerConnected: boolean,
): { type: 'home'; blocks: Block[] } {
  const blocks: Block[] = [];
  const today = toDateString(new Date());
  const monthLabel = monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const thisMonthStart = toDateString(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const isCurrentMonth = toDateString(monthStart) === thisMonthStart;

  // ── Header ──────────────────────────────────────────────────────────────────
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: ':calendar: Team Calendar', emoji: true },
  });

  // ── Month navigation ─────────────────────────────────────────────────────────
  const prevMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1);
  const nextMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);

  blocks.push({
    type: 'actions',
    block_id: 'month_nav',
    elements: [
      btn('← Prev', 'navigate_prev_month', { date: toDateString(prevMonth), filter: 'all', view: 'month' }),
      {
        type: 'button',
        text: { type: 'plain_text', text: isCurrentMonth ? '• Today' : 'Today', emoji: true },
        action_id: 'navigate_today_month',
        value: JSON.stringify({ date: thisMonthStart, filter: 'all', view: 'month' }),
        style: isCurrentMonth ? 'primary' : undefined,
      },
      btn('Next →', 'navigate_next_month', { date: toDateString(nextMonth), filter: 'all', view: 'month' }),
      btn('List', 'switch_view_list', { date: today, filter: 'all', view: 'list' }),
      btn('Week', 'switch_view_week', { date: getWeekMonday(today) ? toDateString(getWeekMonday(today)) : today, filter: 'all', view: 'week' }),
    ],
  });

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*${monthLabel}*` },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: ':arrows_counterclockwise: Refresh', emoji: true },
      action_id: 'refresh_view',
      value: JSON.stringify(state),
    },
  });

  blocks.push({ type: 'divider' });

  // ── OOO spans this month ─────────────────────────────────────────────────────
  const membersWithOOO = memberOOO.filter((m) => m.spans.length > 0);

  if (membersWithOOO.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: ':large_green_circle: *No one is out of office this month.*' },
    });
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:red_circle: *Out of Office This Month*  ·  ${membersWithOOO.length} member${membersWithOOO.length !== 1 ? 's' : ''}` },
    });

    for (const member of membersWithOOO) {
      const spanTexts = member.spans.map((s) => {
        const start = formatMonthDay(s.startDate);
        const end = formatMonthDay(s.endDate);
        const range = s.startDate === s.endDate ? start : `${start} – ${end}`;
        return `_${range}_ — ${s.label}`;
      }).join('\n');

      const elems: Block[] = [];
      if (member.avatarUrl) elems.push({ type: 'image', image_url: member.avatarUrl, alt_text: member.displayName });
      elems.push({ type: 'mrkdwn', text: `*<@${member.slackUserId}>*\n${spanTexts}` });
      blocks.push({ type: 'context', elements: elems });
    }
  }

  blocks.push({ type: 'divider' });

  // ── Weekly overview ──────────────────────────────────────────────────────────
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*Weekly Overview*' },
  });

  const weekMondays = getMonthWeekMondays(monthStart);

  for (const monday of weekMondays) {
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    const mondayStr = toDateString(monday);
    const fridayStr = toDateString(friday);

    const monLabel = monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const friLabel = friday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const weekLabel = `${monLabel} – ${friLabel}`;

    const oooThisWeek = memberOOO.filter((m) =>
      m.spans.some((s) => s.startDate <= fridayStr && s.endDate >= mondayStr),
    );

    let weekText: string;
    if (oooThisWeek.length === 0) {
      weekText = `*${weekLabel}*  ·  :large_green_circle: No one OOO`;
    } else {
      const shown = oooThisWeek.slice(0, 5).map((m) => `<@${m.slackUserId}>`).join(', ');
      const overflow = oooThisWeek.length > 5 ? `  _+${oooThisWeek.length - 5} more_` : '';
      weekText = `*${weekLabel}*  ·  :red_circle: ${shown}${overflow}`;
    }

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: weekText },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'View Week →', emoji: true },
        action_id: 'navigate_to_week',
        value: JSON.stringify({ date: mondayStr, filter: 'all', view: 'week' }),
      },
    });
  }

  blocks.push({ type: 'divider' });
  buildConnectionSection(blocks, isViewerConnected, state);

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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function buildConnectionSection(blocks: Block[], isViewerConnected: boolean, state: ViewState): void {
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
    // Suppress unused-state warning — kept for future use
    void state;
  }
}

/** Returns Mon–Sun week mondays that overlap the given calendar month. */
export function getMonthWeekMondays(monthStart: Date): Date[] {
  const mondays: Date[] = [];
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  const monthEnd = new Date(year, month + 1, 0); // last day of month

  // Start from the Monday of the week that contains day 1
  const firstDay = new Date(year, month, 1);
  const dow = firstDay.getDay(); // 0=Sun
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(firstDay);
  monday.setDate(1 + diffToMonday);

  while (monday <= monthEnd) {
    mondays.push(new Date(monday));
    monday.setDate(monday.getDate() + 7);
  }
  return mondays;
}

/** Returns 'YYYY-MM-DD' for the first day of the month containing dateStr. */
export function getMonthStart(dateStr: string): string {
  const d = parseLocalDate(dateStr);
  return toDateString(new Date(d.getFullYear(), d.getMonth(), 1));
}

function formatMonthDay(dateStr: string): string {
  const d = parseLocalDate(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
