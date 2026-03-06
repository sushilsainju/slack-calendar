import { MemberStatusInfo, StatusFilter, ViewState } from '../types';
import { Entitlements, TrialState } from '../services/entitlements';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = Record<string, any>;

const PAGE_SIZE = 50;
const FREE_MEMBER_CAP = 10;

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

const FEATURE_DESCRIPTIONS: Record<string, string> = {
  date_navigation:
    '*Date Navigation* lets you browse to any past or future date — handy for planning ahead or reviewing last week.',
  status_filter_ooo:
    '*The Out of Office filter* shows only who\'s away, without scrolling through your whole team list.',
  status_filter_meeting:
    '*The In Meeting filter* shows who\'s currently in a call, in real time.',
  member_limit:
    '*Full Team View* removes the 10-member cap so your whole workspace is always visible.',
  trial_expired:
    'Your trial has ended. Upgrade to restore date navigation, filters, unlimited calendars, and /whosout.',
  trial_banner: 'Upgrade to keep date navigation, filters, unlimited calendars, and /whosout.',
};

export function buildUpgradeModal(featureKey: string, checkoutUrl: string): Block {
  const description = FEATURE_DESCRIPTIONS[featureKey] ?? 'Upgrade to unlock this feature.';
  return {
    type: 'modal',
    callback_id: 'upgrade_modal_noop',
    title: { type: 'plain_text', text: 'Upgrade to Pro', emoji: true },
    close: { type: 'plain_text', text: 'Maybe Later', emoji: false },
    blocks: [
      {
        type: 'section',
        block_id: 'feature_description',
        text: { type: 'mrkdwn', text: `:lock: *This is a Pro feature*\n\n${description}` },
      },
      { type: 'divider' },
      {
        type: 'section',
        block_id: 'feature_list',
        text: {
          type: 'mrkdwn',
          text:
            ':sparkles:  *What you get with Pro*\n' +
            ':white_check_mark:  Navigate to any date\n' +
            ':white_check_mark:  Filter by OOO or In Meeting\n' +
            ':white_check_mark:  See your full team (no cap)\n' +
            ':white_check_mark:  /whosout slash command\n' +
            ':white_check_mark:  Auto-refresh every 60 seconds',
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        block_id: 'pricing',
        text: {
          type: 'mrkdwn',
          text: ':receipt:  *$3.99 / month per workspace*\nCancel anytime. 14-day trial included.',
        },
      },
      {
        type: 'actions',
        block_id: 'upgrade_cta',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: ':rocket: Start 14-Day Free Trial', emoji: true },
            action_id: 'open_stripe_checkout',
            url: checkoutUrl,
            style: 'primary',
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '_Payment applies to your whole workspace. Anyone on your team can complete the upgrade._',
          },
        ],
      },
    ],
  };
}

export function buildHomeView(
  members: MemberStatusInfo[],
  state: ViewState,
  isViewerConnected: boolean,
  ent: Entitlements,
  trial: { state: TrialState; daysLeft?: number },
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

  // ── Trial banner ─────────────────────────────────────────────────────────────
  if (trial.state === 'active' && trial.daysLeft !== undefined) {
    blocks.push(buildTrialBanner(trial.daysLeft));
  } else if (trial.state === 'expired') {
    blocks.push(buildTrialExpiredBanner());
  }

  // ── Date navigation ─────────────────────────────────────────────────────────
  if (ent.dateNavigation) {
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
  } else {
    // Locked date navigation — merged into a single section
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:lock: *Date Navigation*  ·  *${dateLabel}*`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: ':lock: Browse Dates (Pro)', emoji: true },
        action_id: 'upgrade_prompt_date_navigation',
        value: 'date_navigation',
      },
    });
    blocks.push({
      type: 'actions',
      block_id: 'refresh_only',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: ':arrows_counterclockwise: Refresh', emoji: true },
          action_id: 'refresh_view',
          value: JSON.stringify(state),
        },
      ],
    });
  }

  blocks.push({ type: 'divider' });

  // ── Status filter ────────────────────────────────────────────────────────────
  if (ent.statusFilters) {
    blocks.push({
      type: 'actions',
      block_id: 'status_filter',
      elements: [
        filterBtn('All Members', 'all', state),
        filterBtn(':red_circle: Out of Office', 'out_of_office', state),
        filterBtn(':large_yellow_circle: In Meeting', 'in_meeting', state),
      ],
    });
  } else {
    blocks.push({
      type: 'actions',
      block_id: 'status_filter',
      elements: [
        filterBtn('All Members', 'all', state),
        {
          type: 'button',
          text: { type: 'plain_text', text: ':lock: Out of Office', emoji: true },
          action_id: 'upgrade_prompt_filter_ooo',
          value: 'status_filter_ooo',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: ':lock: In Meeting', emoji: true },
          action_id: 'upgrade_prompt_filter_meeting',
          value: 'status_filter_meeting',
        },
      ],
    });
  }

  blocks.push({ type: 'divider' });

  // ── Summary counts ───────────────────────────────────────────────────────────
  const visibleMembers = ent.maxConnectedCalendars === Infinity
    ? members
    : members.slice(0, ent.maxConnectedCalendars);

  if (state.filter === 'all') {
    const ooo = visibleMembers.filter((m) => m.status === 'out_of_office').length;
    const meeting = visibleMembers.filter((m) => m.status === 'in_meeting').length;
    const available = visibleMembers.filter((m) => m.status === 'available').length;
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${visibleMembers.length} members  ·  :red_circle: ${ooo} OOO  ·  :large_yellow_circle: ${meeting} in meetings  ·  :large_green_circle: ${available} available`,
        },
      ],
    });
    blocks.push({ type: 'divider' });
  }

  // ── Member list (paginated) ──────────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(visibleMembers.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const paged = visibleMembers.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

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

  // ── Member cap CTA (only shown when cap is actually hit) ─────────────────────
  if (
    ent.maxConnectedCalendars !== Infinity &&
    members.length > FREE_MEMBER_CAP
  ) {
    blocks.push({
      type: 'section',
      block_id: 'upgrade_member_limit',
      text: {
        type: 'mrkdwn',
        text: `_Showing ${FREE_MEMBER_CAP} of ${members.length} members · ${FREE_MEMBER_CAP}/${FREE_MEMBER_CAP} calendars connected_`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: ':arrow_up: Upgrade to Pro', emoji: true },
        action_id: 'upgrade_prompt_member_limit',
        value: 'member_limit',
        style: 'primary',
      },
    });
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

  // ── Branding footer (Free only) ──────────────────────────────────────────────
  if (ent.showBranding) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Powered by Team Calendar · Free Plan_' }],
    });
  }

  return { type: 'home', blocks };
}

function buildTrialBanner(daysLeft: number): Block {
  let emoji = ':hourglass_flowing_sand:';
  let text: string;

  if (daysLeft <= 0) {
    emoji = ':red_circle:';
    text = '*Your Pro trial ends tonight* · Subscribe now to keep access.';
  } else if (daysLeft === 1) {
    emoji = ':red_circle:';
    text = '*Last day of your Pro trial* · Subscribe today to avoid losing access.';
  } else if (daysLeft <= 3) {
    emoji = ':hourglass:';
    text = `*${daysLeft} days left in your Pro trial* · Subscribe now to keep date navigation, filters, and unlimited calendars.`;
  } else {
    text = `*Pro Trial — ${daysLeft} days remaining* · Full access to all Pro features.`;
  }

  return {
    type: 'section',
    block_id: 'trial_banner',
    text: { type: 'mrkdwn', text: `${emoji}  ${text}` },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: ':arrow_up: Subscribe Now', emoji: true },
      action_id: 'upgrade_from_trial_banner',
      value: 'trial_banner',
      style: 'primary',
    },
  };
}

function buildTrialExpiredBanner(): Block {
  return {
    type: 'section',
    block_id: 'trial_expired_banner',
    text: {
      type: 'mrkdwn',
      text:
        ':lock:  *Your Pro trial has ended*\n\n' +
        'Your data is safe — all connected calendars are still stored.\n' +
        '_You can still see today\'s availability for up to 10 team members._\n\n' +
        'Features now locked:  Date navigation  ·  Status filters  ·  Full team view  ·  /whosout',
    },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: ':sparkles: Upgrade to Pro — $3.99/mo', emoji: true },
      action_id: 'upgrade_prompt_trial_expired',
      value: 'trial_expired',
      style: 'primary',
    },
  };
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
