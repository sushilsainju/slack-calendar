import { pool } from './token-store';
import { logger } from '../utils/logger';

export interface Entitlements {
  maxConnectedCalendars: number;   // 10 (free) | Infinity (pro/business)
  dateNavigation: boolean;
  statusFilters: boolean;
  keywordOooDetection: boolean;
  slashCommand: boolean;
  autoRefresh: boolean;
  showBranding: boolean;
  dailyDigest: boolean;
  channelNotifications: boolean;
  weekView: boolean;
  customOooKeywords: boolean;
  adminSettings: boolean;
}

export type Tier = 'free' | 'pro' | 'business';
export type TrialState = 'active' | 'expired' | 'none';

const TIER_ENTITLEMENTS: Record<Tier, Entitlements> = {
  free: {
    maxConnectedCalendars: 10,
    dateNavigation: false,
    statusFilters: false,
    keywordOooDetection: false,
    slashCommand: false,
    autoRefresh: false,
    showBranding: true,
    dailyDigest: false,
    channelNotifications: false,
    weekView: false,
    customOooKeywords: false,
    adminSettings: false,
  },
  pro: {
    maxConnectedCalendars: Infinity,
    dateNavigation: true,
    statusFilters: true,
    keywordOooDetection: true,
    slashCommand: true,
    autoRefresh: true,
    showBranding: false,
    dailyDigest: false,
    channelNotifications: false,
    weekView: false,
    customOooKeywords: false,
    adminSettings: false,
  },
  business: {
    maxConnectedCalendars: Infinity,
    dateNavigation: true,
    statusFilters: true,
    keywordOooDetection: true,
    slashCommand: true,
    autoRefresh: true,
    showBranding: false,
    dailyDigest: true,
    channelNotifications: true,
    weekView: true,
    customOooKeywords: true,
    adminSettings: true,
  },
};

// In-memory cache — avoids a DB hit on every home tab render
const cache = new Map<string, { ent: Entitlements; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// Fallback for local dev (no DB)
const FREE_ENT = TIER_ENTITLEMENTS.free;

export async function getEntitlements(teamId: string): Promise<Entitlements> {
  const cached = cache.get(teamId);
  if (cached && Date.now() < cached.expiresAt) return cached.ent;

  if (!pool) return FREE_ENT;

  const { rows } = await pool.query(
    `SELECT tier, trial_ends_at FROM workspaces WHERE team_id = $1`,
    [teamId],
  );

  const row = rows[0];
  if (!row) {
    logger.warn({ teamId }, '[entitlements] No workspace record — defaulting to free');
    return FREE_ENT;
  }

  let effectiveTier: Tier = row.tier as Tier;

  // Trial: treat as pro while trial is active and tier is still free
  if (effectiveTier === 'free' && row.trial_ends_at && new Date(row.trial_ends_at) > new Date()) {
    effectiveTier = 'pro';
  }

  const ent = TIER_ENTITLEMENTS[effectiveTier] ?? FREE_ENT;
  cache.set(teamId, { ent, expiresAt: Date.now() + CACHE_TTL_MS });
  return ent;
}

export async function getTrialState(
  teamId: string,
): Promise<{ state: TrialState; daysLeft?: number }> {
  if (!pool) return { state: 'none' };

  const { rows } = await pool.query(
    `SELECT tier, trial_ends_at FROM workspaces WHERE team_id = $1`,
    [teamId],
  );
  const row = rows[0];

  if (!row?.trial_ends_at || row.tier !== 'free') return { state: 'none' };

  const trialEnd = new Date(row.trial_ends_at);
  if (trialEnd > new Date()) {
    const daysLeft = Math.ceil((trialEnd.getTime() - Date.now()) / 86_400_000);
    return { state: 'active', daysLeft };
  }
  return { state: 'expired' };
}

/** Force-invalidate a workspace's entitlements cache. Call after any tier change. */
export function invalidateEntitlements(teamId: string): void {
  cache.delete(teamId);
  logger.debug({ teamId }, '[entitlements] Cache invalidated');
}
