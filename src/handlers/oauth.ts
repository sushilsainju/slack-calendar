import { Router } from 'express';
import { WebClient } from '@slack/web-api';
import { exchangeCode } from '../services/google-calendar';
import { saveTokens } from '../services/token-store';
import { consumeOAuthState } from '../services/oauth-state';
import { installationStore } from '../services/installation-store';
import { invalidateUserStatus } from '../services/team-status';
import { publishHomeView, todayString } from './app-home';
import { escapeHtml } from '../utils/html';
import { logger } from '../utils/logger';

export function createOAuthRouter(): Router {
  const router = Router();

  router.get('/oauth/google/callback', async (req, res) => {
    const { code, state: nonce, error } = req.query;

    if (error || !code || !nonce || typeof code !== 'string' || typeof nonce !== 'string') {
      return res.status(400).send(
        html(
          '❌ Authorization Failed',
          `<p>${escapeHtml(String(error || 'Missing required parameters.'))}</p>
           <p>Close this window and try again from Slack.</p>`,
        ),
      );
    }

    let oauthState: { slackUserId: string; teamId: string } | null;
    try {
      oauthState = await consumeOAuthState(nonce);
    } catch (err) {
      logger.error({ err }, '[oauth] Failed to consume OAuth state');
      return res.status(500).send(
        html('❌ Something Went Wrong', '<p>An unexpected error occurred. Please try again.</p>'),
      );
    }

    if (!oauthState) {
      return res.status(400).send(
        html(
          '❌ Link Expired',
          '<p>This authorization link has expired or was already used. Please try again from Slack.</p>',
        ),
      );
    }

    const { slackUserId, teamId } = oauthState;

    try {
      const { tokens, email } = await exchangeCode(code);
      await saveTokens(teamId, slackUserId, email, tokens);
      invalidateUserStatus(teamId, slackUserId);

      // Refresh the App Home using the workspace's bot token
      installationStore
        .fetchInstallation({ teamId, enterpriseId: undefined, isEnterpriseInstall: false })
        .then((installation) => {
          const client = new WebClient(installation.bot?.token);
          return publishHomeView(client, teamId, slackUserId, {
            date: todayString(),
            filter: 'all',
          });
        })
        .catch((err) =>
          logger.error({ teamId, slackUserId, err }, '[oauth] Failed to refresh home view after connect'),
        );

      return res.send(
        html(
          '✅ Google Calendar Connected!',
          `<p>Your calendar is now connected as <strong>${escapeHtml(email)}</strong>.</p>
           <p>You can close this window and return to Slack.</p>
           <script>setTimeout(() => window.close(), 2000);</script>`,
        ),
      );
    } catch (err) {
      logger.error({ teamId, slackUserId, err }, '[oauth] Callback error');
      return res.send(
        html(
          '❌ Authorization Failed',
          '<p>An unexpected error occurred. Close this window and try again.</p>',
        ),
      );
    }
  });

  return router;
}

function html(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; color: #1d1c1d; }
    h1 { font-size: 1.5rem; }
    p { color: #616061; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${body}
</body>
</html>`;
}
