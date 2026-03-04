import { App, ExpressReceiver } from '@slack/bolt';
import { config } from './config';
import { createOAuthRouter } from './handlers/oauth';
import { registerAppHomeHandlers } from './handlers/app-home';
import { registerActionHandlers } from './handlers/actions';

const receiver = new ExpressReceiver({
  signingSecret: config.slack.signingSecret,
});

const app = new App({
  token: config.slack.botToken,
  receiver,
});

// Custom HTTP routes (Google OAuth callback, health check)
receiver.router.use(createOAuthRouter(app));

// Slack event & action handlers
registerAppHomeHandlers(app);
registerActionHandlers(app);

(async () => {
  await app.start(config.port);
  console.log(`⚡ Team Calendar running on port ${config.port}`);
  console.log(`   Google OAuth redirect: ${config.google.redirectUri}`);
})();
