import { InstallationStore, Installation } from '@slack/bolt';
import { encryptJson, decryptJson } from '../utils/crypto';
import { pool } from './token-store';
import { logger } from '../utils/logger';

// In-memory fallback for local development (no DATABASE_URL)
const memInstallations = new Map<string, { botToken: string; botUserId: string; teamName?: string }>();

export const installationStore: InstallationStore = {
  async storeInstallation(installation) {
    const teamId = installation.team?.id;
    if (!teamId) throw new Error('No team ID in installation');

    if (pool) {
      const encryptedBotToken = encryptJson(installation.bot?.token);
      await pool.query(
        `INSERT INTO installations (team_id, team_name, bot_token, bot_user_id, installed_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (team_id) DO UPDATE
           SET bot_token      = EXCLUDED.bot_token,
               bot_user_id    = EXCLUDED.bot_user_id,
               installed_by   = EXCLUDED.installed_by,
               uninstalled_at = NULL`,
        [teamId, installation.team?.name, encryptedBotToken, installation.bot?.userId, installation.user.id],
      );
      // Create workspace record with 14-day trial (idempotent)
      await pool.query(
        `INSERT INTO workspaces (team_id, tier, trial_ends_at)
         VALUES ($1, 'free', NOW() + INTERVAL '14 days')
         ON CONFLICT (team_id) DO NOTHING`,
        [teamId],
      );
    } else {
      memInstallations.set(teamId, {
        botToken: installation.bot?.token ?? '',
        botUserId: installation.bot?.userId ?? '',
        teamName: installation.team?.name,
      });
    }

    logger.info({ teamId, installedBy: installation.user.id }, 'App installed');
  },

  async fetchInstallation(query) {
    const teamId = query.teamId;
    if (!teamId) throw new Error('fetchInstallation called without teamId');

    if (pool) {
      const { rows } = await pool.query(
        `SELECT bot_token, bot_user_id FROM installations
         WHERE team_id = $1 AND uninstalled_at IS NULL`,
        [teamId],
      );
      if (!rows[0]) throw new Error(`No active installation found for team ${teamId}`);

      let botToken: string;
      try {
        botToken = decryptJson<string>(rows[0].bot_token);
      } catch (err) {
        logger.error({ teamId, err }, 'Failed to decrypt bot token');
        throw new Error(`Bot token decryption failed for team ${teamId}`);
      }

      return {
        team: { id: teamId },
        bot: { token: botToken, userId: rows[0].bot_user_id },
      } as Installation;
    } else {
      const inst = memInstallations.get(teamId);
      if (!inst) throw new Error(`No active installation found for team ${teamId}`);
      return {
        team: { id: teamId },
        bot: { token: inst.botToken, userId: inst.botUserId },
      } as Installation;
    }
  },

  async deleteInstallation(query) {
    const teamId = query.teamId;
    if (pool) {
      await pool.query(
        `UPDATE installations SET uninstalled_at = NOW() WHERE team_id = $1`,
        [teamId],
      );
    } else {
      memInstallations.delete(teamId!);
    }
    logger.info({ teamId }, 'Installation marked uninstalled');
  },
};

/**
 * Seed an installation row from a legacy SLACK_BOT_TOKEN during the Phase 1→2 migration.
 * Safe to call multiple times — no-ops if the installation already exists.
 * Remove SLACK_BOT_TOKEN from env after migration is confirmed.
 */
export async function seedLegacyInstallation(teamId: string, botToken: string): Promise<void> {
  if (pool) {
    const { rows } = await pool.query(
      'SELECT 1 FROM installations WHERE team_id = $1 AND uninstalled_at IS NULL',
      [teamId],
    );
    if (rows.length > 0) return;

    const encryptedToken = encryptJson(botToken);
    await pool.query(
      `INSERT INTO installations (team_id, bot_token, bot_user_id)
       VALUES ($1, $2, '')
       ON CONFLICT (team_id) DO NOTHING`,
      [teamId, encryptedToken],
    );
    // Create workspace record
    await pool.query(
      `INSERT INTO workspaces (team_id) VALUES ($1) ON CONFLICT (team_id) DO NOTHING`,
      [teamId],
    );
    logger.info({ teamId }, 'Seeded installation from SLACK_BOT_TOKEN');
  } else {
    if (!memInstallations.has(teamId)) {
      memInstallations.set(teamId, { botToken, botUserId: '' });
      logger.info({ teamId }, 'Seeded in-memory installation from SLACK_BOT_TOKEN');
    }
  }
}

/** Returns all active installations. Used by scheduled jobs (Phase 4/5). */
export async function getAllInstallations(): Promise<Array<{ teamId: string; botToken: string }>> {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT team_id, bot_token FROM installations WHERE uninstalled_at IS NULL`,
    );
    return rows.map((row) => ({
      teamId: row.team_id,
      botToken: decryptJson<string>(row.bot_token),
    }));
  }
  return Array.from(memInstallations.entries()).map(([teamId, inst]) => ({
    teamId,
    botToken: inst.botToken,
  }));
}
