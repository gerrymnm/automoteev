import Stripe from "stripe";
import { env } from "../config.js";

export const stripe = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-04-10" })
  : null;

export async function createProCheckoutSession(params: {
  userId: string;
  email?: string;
}) {
  if (!stripe || !env.STRIPE_PRO_PRICE_ID) {
    return { url: null, configured: false };
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: env.STRIPE_PRO_PRICE_ID, quantity: 1 }],
    success_url: `${env.APP_URL}/?checkout=success`,
    cancel_url: `${env.APP_URL}/?checkout=cancelled`,
    customer_email: params.email,
    metadata: {
      user_id: params.userId,
      plan: "pro"
    }
  });

  return { url: session.url, configured: true };
}
