import { Router } from 'express';
import { App } from '@slack/bolt';
import { exchangeCode } from '../services/google-calendar';
import { saveTokens } from '../services/token-store';
import { publishHomeView, todayString } from './app-home';

export function createOAuthRouter(app: App): Router {
  const router = Router();

  router.get('/oauth/google/callback', async (req, res) => {
    const { code, state: slackUserId, error } = req.query;

    if (error || !code || !slackUserId || typeof code !== 'string' || typeof slackUserId !== 'string') {
      return res.send(html(
        '❌ Authorization Failed',
        `<p>${error || 'Missing required parameters.'}</p><p>Close this window and try again from Slack.</p>`,
      ));
    }

    try {
      const { tokens, email } = await exchangeCode(code);
      saveTokens(slackUserId, email, tokens);

      // Refresh the App Home so the user sees their connected status immediately
      publishHomeView(app, slackUserId, { date: todayString(), filter: 'all' }).catch((err) =>
        console.error('[oauth] Failed to refresh home view after connect:', err),
      );

      return res.send(html(
        '✅ Google Calendar Connected!',
        `<p>Your calendar is now connected as <strong>${email}</strong>.</p>
         <p>You can close this window and return to Slack.</p>
         <script>setTimeout(() => window.close(), 2000);</script>`,
      ));
    } catch (err) {
      console.error('[oauth] Callback error:', err);
      return res.send(html(
        '❌ Authorization Failed',
        '<p>An unexpected error occurred. Close this window and try again.</p>',
      ));
    }
  });

  // Health check
  router.get('/health', (_req, res) => res.json({ status: 'ok' }));

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
