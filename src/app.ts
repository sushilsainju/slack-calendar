import { App, ExpressReceiver } from '@slack/bolt';
import { config } from './config';
import { initTokenStore, closePgPool } from './services/token-store';
import { createOAuthRouter } from './handlers/oauth';
import { registerAppHomeHandlers } from './handlers/app-home';
import { registerActionHandlers } from './handlers/actions';
import { logger } from './utils/logger';

const receiver = new ExpressReceiver({
  signingSecret: config.slack.signingSecret,
});

const app = new App({
  token: config.slack.botToken,
  receiver,
});

// Health check
receiver.router.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Custom HTTP routes (Google OAuth callback)
receiver.router.use(createOAuthRouter(app));

// Slack event & action handlers
registerAppHomeHandlers(app);
registerActionHandlers(app);

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down...');
  await app.stop();
  await closePgPool();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => {
  await initTokenStore();
  await app.start(config.port);
  logger.info({ port: config.port }, 'Team Calendar running');
  logger.info({ redirectUri: config.google.redirectUri }, 'Google OAuth redirect');
})();
