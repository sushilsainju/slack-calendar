import dotenv from 'dotenv';
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  slack: {
    /** Optional during Phase 1→2 migration — used only to seed the installations table */
    botToken: process.env.SLACK_BOT_TOKEN,
    signingSecret: requireEnv('SLACK_SIGNING_SECRET'),
    clientId: requireEnv('SLACK_CLIENT_ID'),
    clientSecret: requireEnv('SLACK_CLIENT_SECRET'),
    stateSecret: requireEnv('SLACK_STATE_SECRET'),
  },
  google: {
    clientId: requireEnv('GOOGLE_CLIENT_ID'),
    clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
    redirectUri: requireEnv('GOOGLE_REDIRECT_URI'),
  },
  port: parseInt(process.env.PORT || '3000', 10),
  tokenStorePath: process.env.TOKEN_STORE_PATH || './tokens.json',
};
