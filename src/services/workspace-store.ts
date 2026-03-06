import { pool } from './token-store';
import { Tier } from './entitlements';

export async function getConnectedCount(teamId: string): Promise<number> {
  if (!pool) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*) FROM user_tokens WHERE team_id = $1`,
    [teamId],
  );
  return parseInt(rows[0].count, 10);
}

export async function getWorkspaceTier(teamId: string): Promise<Tier> {
  if (!pool) return 'free';
  const { rows } = await pool.query(
    `SELECT tier FROM workspaces WHERE team_id = $1`,
    [teamId],
  );
  return (rows[0]?.tier ?? 'free') as Tier;
}
