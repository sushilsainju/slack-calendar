import express, { Router } from 'express';
import Stripe from 'stripe';
import { WebClient } from '@slack/web-api';
import { stripe } from '../services/stripe';
import { invalidateEntitlements } from '../services/entitlements';
import { pool } from '../services/token-store';
import { installationStore } from '../services/installation-store';
import { logger } from '../utils/logger';

export function createStripeWebhookRouter(): Router {
  const router = Router();

  router.post(
    '/stripe/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      const sig = req.headers['stripe-signature'] as string;
      let event: Stripe.Event;

      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET!,
        );
      } catch (err) {
        logger.warn({ err }, '[stripe] Webhook signature verification failed');
        return res.status(400).send('Webhook signature verification failed');
      }

      // All events we care about have teamId in metadata
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const teamId = (event.data.object as any).metadata?.teamId;
      if (!teamId) {
        logger.warn(
          { eventType: event.type, eventId: event.id },
          '[stripe] Webhook missing teamId in metadata — skipping',
        );
        return res.json({ received: true });
      }

      try {
        switch (event.type) {
          case 'checkout.session.completed': {
            const session = event.data.object as Stripe.Checkout.Session;

            // Deduplicate: skip if sub already recorded
            const { rows } = await pool!.query(
              `SELECT 1 FROM workspaces WHERE team_id = $1 AND stripe_sub_id = $2`,
              [teamId, session.subscription],
            );
            if (rows.length > 0) break;

            const tier =
              session.metadata?.priceId === process.env.STRIPE_BUSINESS_PRICE_ID
                ? 'business'
                : 'pro';

            await pool!.query(
              `UPDATE workspaces
               SET tier = $1, stripe_customer = $2, stripe_sub_id = $3, trial_ends_at = NULL
               WHERE team_id = $4`,
              [tier, session.customer, session.subscription, teamId],
            );
            invalidateEntitlements(teamId);

            const slackUserId = session.metadata?.slackUserId;
            if (slackUserId) {
              await sendUpgradeSuccessDm(slackUserId, teamId, tier);
            }
            logger.info({ teamId, tier, slackUserId }, '[stripe] Workspace upgraded');
            break;
          }

          case 'customer.subscription.deleted': {
            await pool!.query(
              `UPDATE workspaces SET tier = 'free', stripe_sub_id = NULL WHERE team_id = $1`,
              [teamId],
            );
            invalidateEntitlements(teamId);
            logger.info({ teamId }, '[stripe] Subscription deleted — reverted to free');
            break;
          }

          case 'invoice.payment_failed': {
            logger.warn({ teamId }, '[stripe] Invoice payment failed');
            break;
          }

          default:
            break;
        }
      } catch (err) {
        logger.error({ teamId, eventType: event.type, err }, '[stripe] Error processing webhook');
        return res.status(500).json({ error: 'Internal processing error' });
      }

      res.json({ received: true });
    },
  );

  return router;
}

async function sendUpgradeSuccessDm(
  slackUserId: string,
  teamId: string,
  tier: 'pro' | 'business',
): Promise<void> {
  try {
    const installation = await installationStore.fetchInstallation({
      teamId,
      enterpriseId: undefined,
      isEnterpriseInstall: false,
    });
    const client = new WebClient(installation.bot?.token);

    const tierLabel = tier === 'business' ? 'Business' : 'Pro';
    await client.chat.postMessage({
      channel: slackUserId,
      text: `You're now on Team Calendar ${tierLabel}!`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `:tada:  *You're on Team Calendar ${tierLabel}!*\n\n` +
              `Unlocked for your whole workspace:\n` +
              `:white_check_mark:  Navigate to any date\n` +
              `:white_check_mark:  Filter by OOO or In Meeting\n` +
              `:white_check_mark:  See your full team (no cap)\n` +
              `:white_check_mark:  /whosout slash command\n` +
              `:white_check_mark:  Auto-refresh every 60 seconds`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: ':receipt: Receipt sent to your billing email.',
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: ':calendar: Open Team Calendar', emoji: true },
              action_id: 'open_team_calendar_noop',
              url: `slack://app?team=${teamId}&tab=home`,
              style: 'primary',
            },
          ],
        },
      ],
    });
  } catch (err) {
    logger.error({ teamId, slackUserId, err }, '[stripe] Failed to send upgrade success DM');
  }
}
