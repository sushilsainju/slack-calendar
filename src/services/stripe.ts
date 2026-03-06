import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
});

/**
 * Create a Stripe Checkout session for a workspace upgrade.
 * Throws if the Stripe API call fails — caller must handle and show an error to the user.
 */
export async function createCheckoutSession(
  teamId: string,
  slackUserId: string,
  priceId: string,
): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { teamId, slackUserId, priceId },
    success_url: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}&slack_user=${encodeURIComponent(slackUserId)}&team=${encodeURIComponent(teamId)}`,
    cancel_url: `${process.env.APP_URL}/billing/cancel`,
  });
  if (!session.url) throw new Error('Stripe returned a session without a URL');
  return session.url;
}

/**
 * Create a Stripe Customer Portal link for billing management.
 * Throws if the Stripe API call fails.
 */
export async function createPortalSession(stripeCustomerId: string): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: process.env.STRIPE_PORTAL_RETURN_URL!,
  });
  return session.url;
}
