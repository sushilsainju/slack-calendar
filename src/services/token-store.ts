/**
 * Token store with two backends:
 *   - Postgres  (when DATABASE_URL is set — production on Railway)
 *   - JSON file (fallback — local development)
 *
 * All functions are async so callers work identically with either backend.
 * Postgres backend encrypts tokens at rest with AES-256-GCM.
 * All queries are scoped by team_id for multi-workspace support.
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
    validateEncryptionKey();

    // Phase 1: Migrate tokens column from JSONB to TEXT if needed
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

    // Create tables (idempotent)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        team_id       TEXT NOT NULL DEFAULT '',
        slack_user_id TEXT NOT NULL,
        google_email  TEXT NOT NULL,
        tokens        TEXT NOT NULL,
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (team_id, slack_user_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_oauth_states (
        nonce         TEXT PRIMARY KEY,
        slack_user_id TEXT NOT NULL,
        team_id       TEXT NOT NULL DEFAULT '',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS pending_oauth_states_created_at_idx
        ON pending_oauth_states (created_at)
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS installations (
        team_id        TEXT PRIMARY KEY,
        team_name      TEXT,
        bot_token      TEXT NOT NULL,
        bot_user_id    TEXT NOT NULL,
        installed_by   TEXT,
        installed_at   TIMESTAMPTZ DEFAULT NOW(),
        uninstalled_at TIMESTAMPTZ
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        team_id               TEXT PRIMARY KEY REFERENCES installations(team_id),
        tier                  TEXT NOT NULL DEFAULT 'free',
        stripe_customer       TEXT,
        stripe_sub_id         TEXT,
        trial_ends_at         TIMESTAMPTZ,
        digest_enabled        BOOLEAN DEFAULT false,
        digest_time           TEXT    DEFAULT '08:30',
        timezone              TEXT    DEFAULT 'UTC',
        notify_channel_id     TEXT,
        custom_ooo_keywords   TEXT[]  DEFAULT '{}',
        created_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Phase 2 schema migrations (idempotent)
    await pool.query(`
      ALTER TABLE user_tokens ADD COLUMN IF NOT EXISTS team_id TEXT NOT NULL DEFAULT ''
    `);
    await pool.query(`
      ALTER TABLE pending_oauth_states ADD COLUMN IF NOT EXISTS team_id TEXT NOT NULL DEFAULT ''
    `);

    // Migrate PRIMARY KEY from (slack_user_id) to (team_id, slack_user_id) if needed
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.key_column_usage kcu
          JOIN information_schema.table_constraints tc
            ON kcu.constraint_name = tc.constraint_name
          WHERE tc.table_name = 'user_tokens'
            AND tc.constraint_type = 'PRIMARY KEY'
            AND kcu.column_name = 'team_id'
        ) THEN
          ALTER TABLE user_tokens DROP CONSTRAINT IF EXISTS user_tokens_pkey;
          ALTER TABLE user_tokens ADD PRIMARY KEY (team_id, slack_user_id);
        END IF;
      END $$
    `);

    await migrateV1Tokens();
    await migrateV1ToV2();

    logger.info('[token-store] Using Postgres backend');
  } else {
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
 * Re-encrypt plain-text token rows (Phase 1 migration).
 * Plain JSON starts with '{'; encrypted blobs contain ':'.
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

/**
 * Backfill team_id on existing rows for the Phase 1→2 migration.
 * Reads SLACK_TEAM_ID env var — set this during the migration then remove it.
 */
async function migrateV1ToV2(): Promise<void> {
  const knownTeamId = process.env.SLACK_TEAM_ID;
  if (!knownTeamId) return;

  const { rows } = await pool!.query(
    `SELECT COUNT(*) FROM user_tokens WHERE team_id = ''`,
  );
  const count = parseInt(rows[0].count, 10);
  if (count === 0) return;

  logger.info({ knownTeamId, count }, '[token-store] Migrating v1 tokens to multi-workspace schema');
  await pool!.query(
    `UPDATE user_tokens SET team_id = $1 WHERE team_id = ''`,
    [knownTeamId],
  );
  logger.info({ knownTeamId, count }, '[token-store] v1→v2 migration complete');
}

// ── JSON file backend ────────────────────────────────────────────────────────

// Key: `${teamId}:${slackUserId}` for multi-workspace support
type FileStore = Record<string, UserTokenRecord>;
const fileStore: FileStore = {};

function fileKey(teamId: string, slackUserId: string): string {
  return `${teamId}:${slackUserId}`;
}

function persistFile(): void {
  try {
    fs.writeFileSync(config.tokenStorePath, JSON.stringify(fileStore, null, 2));
  } catch (err) {
    logger.error({ err }, '[token-store] Failed to persist file');
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function saveTokens(
  teamId: string,
  slackUserId: string,
  googleEmail: string,
  tokens: GoogleTokens,
): Promise<void> {
  if (pool) {
    await pool.query(
      `INSERT INTO user_tokens (team_id, slack_user_id, google_email, tokens, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (team_id, slack_user_id) DO UPDATE
         SET google_email = EXCLUDED.google_email,
             tokens       = EXCLUDED.tokens,
             updated_at   = NOW()`,
      [teamId, slackUserId, googleEmail, encryptJson(tokens)],
    );
  } else {
    fileStore[fileKey(teamId, slackUserId)] = { slackUserId, googleEmail, tokens };
    persistFile();
  }
}

export async function getTokenRecord(
  teamId: string,
  slackUserId: string,
): Promise<UserTokenRecord | undefined> {
  if (pool) {
    const { rows } = await pool.query(
      'SELECT slack_user_id, google_email, tokens FROM user_tokens WHERE team_id = $1 AND slack_user_id = $2',
      [teamId, slackUserId],
    );
    if (!rows[0]) return undefined;
    return {
      slackUserId: rows[0].slack_user_id,
      googleEmail: rows[0].google_email,
      tokens: decryptJson<GoogleTokens>(rows[0].tokens),
    };
  }
  return fileStore[fileKey(teamId, slackUserId)];
}

export async function removeTokens(teamId: string, slackUserId: string): Promise<void> {
  if (pool) {
    await pool.query(
      'DELETE FROM user_tokens WHERE team_id = $1 AND slack_user_id = $2',
      [teamId, slackUserId],
    );
  } else {
    delete fileStore[fileKey(teamId, slackUserId)];
    persistFile();
  }
}

export async function isConnected(teamId: string, slackUserId: string): Promise<boolean> {
  if (pool) {
    const { rows } = await pool.query(
      'SELECT 1 FROM user_tokens WHERE team_id = $1 AND slack_user_id = $2',
      [teamId, slackUserId],
    );
    return rows.length > 0;
  }
  return !!fileStore[fileKey(teamId, slackUserId)];
}

export async function getAllConnectedUsers(teamId: string): Promise<UserTokenRecord[]> {
  if (pool) {
    const { rows } = await pool.query(
      'SELECT slack_user_id, google_email, tokens FROM user_tokens WHERE team_id = $1',
      [teamId],
    );
    return rows.map((r) => ({
      slackUserId: r.slack_user_id,
      googleEmail: r.google_email,
      tokens: decryptJson<GoogleTokens>(r.tokens),
    }));
  }
  // File store: return all records that belong to this teamId
  return Object.entries(fileStore)
    .filter(([key]) => key.startsWith(`${teamId}:`))
    .map(([, record]) => record);
}
