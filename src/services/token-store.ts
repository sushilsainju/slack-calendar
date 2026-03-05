/**
 * Token store with two backends:
 *   - Postgres  (when DATABASE_URL is set — production on Railway)
 *   - JSON file (fallback — local development)
 *
 * All functions are async so callers work identically with either backend.
 * Postgres backend encrypts tokens at rest with AES-256-GCM.
 */
import * as fs from 'fs';
import { Pool } from 'pg';
import { GoogleTokens, UserTokenRecord } from '../types';
import { config } from '../config';
import { encryptJson, decryptJson, validateEncryptionKey } from '../utils/crypto';
import { logger } from '../utils/logger';

// ── Backend selection ────────────────────────────────────────────────────────

export const pool: Pool | null = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

export async function closePgPool(): Promise<void> {
  if (pool) await pool.end();
}

/** Call once at startup before any other store operations. */
export async function initTokenStore(): Promise<void> {
  if (pool) {
    // Validate encryption key before any DB operations
    validateEncryptionKey();

    // Migrate tokens column from JSONB to TEXT if needed (idempotent)
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'user_tokens'
            AND column_name = 'tokens'
            AND data_type = 'jsonb'
        ) THEN
          ALTER TABLE user_tokens ALTER COLUMN tokens TYPE TEXT USING tokens::TEXT;
        END IF;
      END $$
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        slack_user_id TEXT PRIMARY KEY,
        google_email  TEXT NOT NULL,
        tokens        TEXT NOT NULL,
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_oauth_states (
        nonce         TEXT PRIMARY KEY,
        slack_user_id TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS pending_oauth_states_created_at_idx
        ON pending_oauth_states (created_at)
    `);

    await migrateV1Tokens();

    logger.info('[token-store] Using Postgres backend');
  } else {
    // Load JSON file into memory
    try {
      if (fs.existsSync(config.tokenStorePath)) {
        const raw = fs.readFileSync(config.tokenStorePath, 'utf-8');
        Object.assign(fileStore, JSON.parse(raw));
        logger.info(`[token-store] Loaded ${Object.keys(fileStore).length} token(s) from file`);
      }
    } catch (err) {
      logger.warn({ err }, '[token-store] Could not load token file, starting fresh');
    }
    logger.info('[token-store] Using JSON file backend');
  }
}

/**
 * Re-encrypt any plain-text token rows left over from before encryption was added.
 * Plain JSON starts with '{'; encrypted blobs contain ':' separators.
 */
async function migrateV1Tokens(): Promise<void> {
  const { rows } = await pool!.query('SELECT slack_user_id, tokens FROM user_tokens');
  let migrated = 0;
  for (const row of rows) {
    if (!row.tokens.includes(':')) {
      try {
        const parsed = JSON.parse(row.tokens);
        const encrypted = encryptJson(parsed);
        await pool!.query(
          'UPDATE user_tokens SET tokens = $1 WHERE slack_user_id = $2',
          [encrypted, row.slack_user_id],
        );
        migrated++;
      } catch (err) {
        logger.error(
          { slackUserId: row.slack_user_id, err },
          '[token-store] Failed to migrate token — skipping row',
        );
      }
    }
  }
  if (migrated > 0) {
    logger.info({ migrated }, '[token-store] Migrated plain-text tokens to encrypted format');
  }
}

// ── JSON file backend ────────────────────────────────────────────────────────

type FileStore = Record<string, UserTokenRecord>;
const fileStore: FileStore = {};

function persistFile(): void {
  try {
    fs.writeFileSync(config.tokenStorePath, JSON.stringify(fileStore, null, 2));
  } catch (err) {
    logger.error({ err }, '[token-store] Failed to persist file');
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
      [slackUserId, googleEmail, encryptJson(tokens)],
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
      tokens: decryptJson<GoogleTokens>(rows[0].tokens),
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
      tokens: decryptJson<GoogleTokens>(r.tokens),
    }));
  }
  return Object.values(fileStore);
}
