import { App, ExpressReceiver } from '@slack/bolt';
import { config } from './config';
import { initTokenStore, closePgPool, pool } from './services/token-store';
import { installationStore, seedLegacyInstallation } from './services/installation-store';
import { invalidateRoster } from './services/team-status';
import { createOAuthRouter } from './handlers/oauth';
import { registerAppHomeHandlers } from './handlers/app-home';
import { registerActionHandlers } from './handlers/actions';
import { createStripeWebhookRouter } from './handlers/stripe-webhooks';
import { logger } from './utils/logger';

const receiver = new ExpressReceiver({
  signingSecret: config.slack.signingSecret,
  clientId: config.slack.clientId,
  clientSecret: config.slack.clientSecret,
  stateSecret: config.slack.stateSecret,
  scopes: ['users:read', 'users:read.email', 'chat:write', 'im:write'],
  installationStore,
  installerOptions: {
    directInstall: true,
    redirectUriPath: '/slack/oauth_redirect',
  },
});

const app = new App({
  receiver,
  installationStore,
});

// Health check
receiver.router.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Install landing page
receiver.router.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Team Calendar</title>
  <style>body{font-family:-apple-system,sans-serif;text-align:center;padding:80px;color:#1d1c1d}</style>
</head>
<body>
  <h1>Team Calendar</h1>
  <p>See who's out of office or in a meeting — right in Slack.</p>
  <a href="/slack/install">
    <img alt="Add to Slack" height="40"
      src="https://platform.slack-edge.com/img/add_to_slack.png"
      srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x,
              https://platform.slack-edge.com/img/add_to_slack@2x.png 2x" />
  </a>
</body>
</html>`);
});

// Stripe webhook — must come before JSON body-parser middleware
receiver.router.use(createStripeWebhookRouter());

// Google OAuth callback
receiver.router.use(createOAuthRouter());

// Billing redirect pages
receiver.router.get('/billing/success', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Upgrade successful — Team Calendar</title>
  <style>body{font-family:-apple-system,sans-serif;text-align:center;padding:80px;color:#1d1c1d}</style>
</head>
<body>
  <h1>🎉 You're upgraded!</h1>
  <p>Your workspace now has access to all Pro features.<br>Head back to Slack to try it out.</p>
  <p><a href="slack://open">Open Slack</a></p>
</body>
</html>`);
});

receiver.router.get('/billing/cancel', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Upgrade cancelled — Team Calendar</title>
  <style>body{font-family:-apple-system,sans-serif;text-align:center;padding:80px;color:#1d1c1d}</style>
</head>
<body>
  <h1>No worries</h1>
  <p>Your plan hasn't changed. You can upgrade any time from the Team Calendar home tab.</p>
  <p><a href="slack://open">Back to Slack</a></p>
</body>
</html>`);
});

receiver.router.get('/billing/return', (_req, res) => {
  res.redirect('/billing/success');
});

// Slack event & action handlers
registerAppHomeHandlers(app);
registerActionHandlers(app);

// ── Lifecycle events ─────────────────────────────────────────────────────────

app.event('app_uninstalled', async ({ body }) => {
  const teamId = body.team_id;
  try {
    await installationStore.deleteInstallation?.({ teamId, enterpriseId: undefined, isEnterpriseInstall: false });
    if (pool) {
      await pool.query('DELETE FROM user_tokens WHERE team_id = $1', [teamId]);
    }
    invalidateRoster(teamId);
    logger.info({ teamId }, 'App uninstalled — installation and tokens removed');
  } catch (err) {
    // app_uninstalled fires async — Slack does not retry; best-effort only
    logger.error({ teamId, err }, 'Cleanup failed after app_uninstalled');
  }
});

app.event('team_join', async ({ body }) => {
  invalidateRoster(body.team_id);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down...');
  await app.stop();
  await closePgPool();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Startup ──────────────────────────────────────────────────────────────────

(async () => {
  await initTokenStore();

  // Phase 1→2 migration: seed existing workspace installation from legacy bot token
  if (config.slack.botToken && process.env.SLACK_TEAM_ID) {
    await seedLegacyInstallation(process.env.SLACK_TEAM_ID, config.slack.botToken);
  }

  await app.start(config.port);
  logger.info({ port: config.port }, 'Team Calendar running');
  logger.info({ redirectUri: config.google.redirectUri }, 'Google OAuth redirect');
})();
