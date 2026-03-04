/**
 * Token store with two backends:
 *   - Postgres  (when DATABASE_URL is set — production on Railway)
 *   - JSON file (fallback — local development)
 *
 * All functions are async so callers work identically with either backend.
 */
import * as fs from 'fs';
import { Pool } from 'pg';
import { GoogleTokens, UserTokenRecord } from '../types';
import { config } from '../config';

// ── Backend selection ────────────────────────────────────────────────────────

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

/** Call once at startup before any other store operations. */
export async function initTokenStore(): Promise<void> {
  if (pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        slack_user_id TEXT PRIMARY KEY,
        google_email  TEXT NOT NULL,
        tokens        JSONB NOT NULL,
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('[token-store] Using Postgres backend');
  } else {
    // Load JSON file into memory
    try {
      if (fs.existsSync(config.tokenStorePath)) {
        const raw = fs.readFileSync(config.tokenStorePath, 'utf-8');
        Object.assign(fileStore, JSON.parse(raw));
        console.log(`[token-store] Loaded ${Object.keys(fileStore).length} token(s) from file`);
      }
    } catch (err) {
      console.warn('[token-store] Could not load token file, starting fresh:', err);
    }
    console.log('[token-store] Using JSON file backend');
  }
}

// ── JSON file backend ────────────────────────────────────────────────────────

type FileStore = Record<string, UserTokenRecord>;
const fileStore: FileStore = {};

function persistFile(): void {
  try {
    fs.writeFileSync(config.tokenStorePath, JSON.stringify(fileStore, null, 2));
  } catch (err) {
    console.error('[token-store] Failed to persist file:', err);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function saveTokens(
  slackUserId: string,
  googleEmail: string,
  tokens: GoogleTokens,
): Promise<void> {
  if (pool) {
    await pool.query(
      `INSERT INTO user_tokens (slack_user_id, google_email, tokens, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (slack_user_id) DO UPDATE
         SET google_email = EXCLUDED.google_email,
             tokens       = EXCLUDED.tokens,
             updated_at   = NOW()`,
      [slackUserId, googleEmail, JSON.stringify(tokens)],
    );
  } else {
    fileStore[slackUserId] = { slackUserId, googleEmail, tokens };
    persistFile();
  }
}

export async function getTokenRecord(slackUserId: string): Promise<UserTokenRecord | undefined> {
  if (pool) {
    const { rows } = await pool.query(
      'SELECT slack_user_id, google_email, tokens FROM user_tokens WHERE slack_user_id = $1',
      [slackUserId],
    );
    if (!rows[0]) return undefined;
    return {
      slackUserId: rows[0].slack_user_id,
      googleEmail: rows[0].google_email,
      tokens: rows[0].tokens as GoogleTokens,
    };
  }
  return fileStore[slackUserId];
}

export async function removeTokens(slackUserId: string): Promise<void> {
  if (pool) {
    await pool.query('DELETE FROM user_tokens WHERE slack_user_id = $1', [slackUserId]);
  } else {
    delete fileStore[slackUserId];
    persistFile();
  }
}

export async function isConnected(slackUserId: string): Promise<boolean> {
  if (pool) {
    const { rows } = await pool.query(
      'SELECT 1 FROM user_tokens WHERE slack_user_id = $1',
      [slackUserId],
    );
    return rows.length > 0;
  }
  return !!fileStore[slackUserId];
}

export async function getAllConnectedUsers(): Promise<UserTokenRecord[]> {
  if (pool) {
    const { rows } = await pool.query(
      'SELECT slack_user_id, google_email, tokens FROM user_tokens',
    );
    return rows.map((r) => ({
      slackUserId: r.slack_user_id,
      googleEmail: r.google_email,
      tokens: r.tokens as GoogleTokens,
    }));
  }
  return Object.values(fileStore);
}
