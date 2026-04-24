import Stripe from "stripe";
import { env } from "../config.js";

export const stripe = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-04-10" })
  : null;

export async function createProCheckoutSession(params: {
  userId: string;
  email?: string;
  plan: "monthly" | "annual";
}) {
  if (!stripe) return { url: null, configured: false, reason: "stripe_not_configured" };

  const priceId =
    params.plan === "annual" ? env.STRIPE_PRICE_ANNUAL : env.STRIPE_PRICE_MONTHLY;
  if (!priceId) return { url: null, configured: false, reason: "price_not_configured" };

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${env.APP_URL}/?checkout=success`,
    cancel_url: `${env.APP_URL}/?checkout=cancelled`,
    customer_email: params.email,
    metadata: {
      user_id: params.userId,
      plan: params.plan === "annual" ? "pro_annual" : "pro_monthly"
    }
  });

  return { url: session.url, configured: true };
}

export function verifyStripeWebhook(payload: string | Buffer, signature: string): Stripe.Event {
  if (!stripe) throw new Error("Stripe not configured");
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET not set");
  return stripe.webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
}
