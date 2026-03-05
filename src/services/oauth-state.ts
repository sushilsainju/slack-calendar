import crypto from 'node:crypto';
import { pool } from './token-store';
import { logger } from '../utils/logger';

// In-memory fallback for local development (no DATABASE_URL)
const memStore = new Map<string, { slackUserId: string; expiresAt: number }>();

export async function createOAuthState(slackUserId: string): Promise<string> {
  const nonce = crypto.randomBytes(32).toString('hex');
  if (pool) {
    await pool.query(
      `INSERT INTO pending_oauth_states (nonce, slack_user_id) VALUES ($1, $2)`,
      [nonce, slackUserId],
    );
    // Cheap cleanup on each insert
    await pool.query(
      `DELETE FROM pending_oauth_states WHERE created_at < NOW() - INTERVAL '10 minutes'`,
    );
  } else {
    const now = Date.now();
    for (const [key, val] of memStore) {
      if (val.expiresAt < now) memStore.delete(key);
    }
    memStore.set(nonce, { slackUserId, expiresAt: now + 10 * 60 * 1000 });
  }
  logger.debug({ slackUserId }, '[oauth-state] Created nonce');
  return nonce;
}

export async function consumeOAuthState(nonce: string): Promise<string | null> {
  if (pool) {
    const { rows } = await pool.query(
      `DELETE FROM pending_oauth_states
       WHERE nonce = $1 AND created_at > NOW() - INTERVAL '10 minutes'
       RETURNING slack_user_id`,
      [nonce],
    );
    return rows[0]?.slack_user_id ?? null;
  } else {
    const entry = memStore.get(nonce);
    if (!entry || entry.expiresAt < Date.now()) {
      memStore.delete(nonce);
      return null;
    }
    memStore.delete(nonce);
    return entry.slackUserId;
  }
}
