import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import type Stripe from "stripe";
import { env } from "./config.js";
import { supabaseAdmin } from "./supabase.js";
import { stripe, verifyStripeWebhook } from "./services/stripe.js";

export const webhooks = Router();

/**
 * Stripe subscription webhook.
 * Register in Stripe Dashboard → Webhooks → Add endpoint:
 *   https://<api-host>/webhooks/stripe
 * Subscribe to:
 *   checkout.session.completed
 *   customer.subscription.created
 *   customer.subscription.updated
 *   customer.subscription.deleted
 *   invoice.paid
 *   invoice.payment_failed
 */
webhooks.post("/webhooks/stripe", async (req: Request, res: Response) => {
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: "stripe_not_configured" });
  }
  const sig = req.header("stripe-signature");
  if (!sig) return res.status(400).json({ error: "missing_signature" });

  let event: Stripe.Event;
  try {
    event = verifyStripeWebhook(req.body as Buffer, sig);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "invalid_signature" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.user_id;
        const plan = (session.metadata?.plan as "pro_monthly" | "pro_annual") ?? "pro_monthly";
        if (userId) {
          await upsertSubscription({
            userId,
            externalSubscriptionId: (session.subscription as string) ?? null,
            externalCustomerId: (session.customer as string) ?? null,
            plan,
            status: "active"
          });
          await supabaseAdmin.from("profiles").update({ plan: "pro" }).eq("id", userId);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.user_id;
        if (userId) {
          await upsertSubscription({
            userId,
            externalSubscriptionId: sub.id,
            externalCustomerId: (sub.customer as string) ?? null,
            plan:
              sub.items.data[0]?.price?.id === env.STRIPE_PRICE_ANNUAL
                ? "pro_annual"
                : "pro_monthly",
            status: mapStripeStatus(sub.status),
            currentPeriodEnd: sub.current_period_end
          });
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.user_id;
        if (userId) {
          await supabaseAdmin
            .from("subscriptions")
            .update({ status: "canceled" })
            .eq("user_id", userId);
          await supabaseAdmin.from("profiles").update({ plan: "free" }).eq("id", userId);
        }
        break;
      }
      default:
        // no-op
        break;
    }
  } catch (err) {
    console.error("stripe webhook processing error", err);
    return res.status(500).json({ error: "webhook_processing_error" });
  }

  return res.json({ received: true });
});

/**
 * Resend inbound webhook — dealer reply lands here.
 * Configure in Resend Dashboard → Receiving → add endpoint
 *   URL: https://<api-host>/webhooks/email/inbound
 *   Event: email.received
 */
webhooks.post("/webhooks/email/inbound", async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;
  if (!verifyResendSignature(req, rawBody, env.RESEND_INBOUND_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "invalid_json" });
  }

  const toAddress = firstAddress(payload?.to);
  const fromAddress = firstAddress(payload?.from);
  if (!toAddress) return res.status(202).json({ ignored: true, reason: "no_to" });

  // Route by local-part: gerry.m@mail.automoteev.com → find profile by agent_email_local
  const localPart = toAddress.split("@")[0];
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("agent_email_local", localPart)
    .maybeSingle();
  if (!profile) return res.status(202).json({ ignored: true, reason: "unknown_local" });

  const inReplyTo = payload?.headers?.["in-reply-to"] ?? payload?.inReplyTo ?? null;
  const threadId = payload?.threadId ?? inReplyTo ?? null;

  // Try to find the originating outbound email to link the thread.
  let taskId: string | null = null;
  if (inReplyTo) {
    const { data: original } = await supabaseAdmin
      .from("task_emails")
      .select("task_id")
      .eq("provider_message_id", inReplyTo)
      .maybeSingle();
    taskId = original?.task_id ?? null;
  }

  await supabaseAdmin.from("task_emails").insert({
    user_id: profile.id,
    task_id: taskId,
    provider_id: null,
    to_email: toAddress,
    from_email: fromAddress ?? "unknown@unknown",
    subject: payload?.subject ?? "(no subject)",
    body_text: payload?.text ?? payload?.html ?? "",
    status: "received",
    provider_message_id: payload?.messageId ?? null,
    direction: "inbound",
    thread_id: threadId,
    in_reply_to: inReplyTo,
    received_at: new Date().toISOString()
  });

  return res.json({ received: true });
});

/**
 * Resend events webhook (delivered, bounced, spam, opened, etc).
 * Configure in Resend Dashboard → Webhooks
 *   URL: https://<api-host>/webhooks/email/events
 */
webhooks.post("/webhooks/email/events", async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;
  if (!verifyResendSignature(req, rawBody, env.RESEND_EVENTS_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  let event: { type?: string; data?: { email_id?: string } };
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "invalid_json" });
  }

  const messageId = event.data?.email_id;
  if (!messageId) return res.status(202).json({ ignored: true });

  const { data: emailRow } = await supabaseAdmin
    .from("task_emails")
    .select("id")
    .eq("provider_message_id", messageId)
    .maybeSingle();
  if (!emailRow) return res.status(202).json({ ignored: true, reason: "unknown_message" });

  await supabaseAdmin.from("email_events").insert({
    task_email_id: emailRow.id,
    event_type: event.type ?? "unknown",
    occurred_at: new Date().toISOString(),
    metadata: event as any
  });

  return res.json({ received: true });
});

// ---------- helpers ----------
async function upsertSubscription(params: {
  userId: string;
  externalSubscriptionId: string | null;
  externalCustomerId: string | null;
  plan: "pro_monthly" | "pro_annual";
  status: "active" | "trialing" | "past_due" | "canceled" | "expired";
  currentPeriodEnd?: number | null;
}) {
  await supabaseAdmin.from("subscriptions").upsert(
    {
      user_id: params.userId,
      source: "stripe",
      status: params.status,
      plan: params.plan,
      external_subscription_id: params.externalSubscriptionId,
      external_customer_id: params.externalCustomerId,
      current_period_end: params.currentPeriodEnd
        ? new Date(params.currentPeriodEnd * 1000).toISOString()
        : null
    },
    { onConflict: "user_id" }
  );
}

function mapStripeStatus(status: Stripe.Subscription["status"]) {
  switch (status) {
    case "trialing":
      return "trialing" as const;
    case "active":
      return "active" as const;
    case "past_due":
    case "unpaid":
      return "past_due" as const;
    case "canceled":
      return "canceled" as const;
    case "incomplete":
    case "incomplete_expired":
    case "paused":
    default:
      return "expired" as const;
  }
}

function firstAddress(input: unknown): string | null {
  if (!input) return null;
  if (Array.isArray(input)) return typeof input[0] === "string" ? input[0] : (input[0] as any)?.address ?? null;
  if (typeof input === "string") return input;
  if (typeof input === "object") return (input as any).address ?? null;
  return null;
}

function verifyResendSignature(req: Request, rawBody: Buffer, secret: string | undefined): boolean {
  if (!secret) return true; // dev-mode fallback
  const sig = req.header("resend-signature") ?? req.header("svix-signature");
  if (!sig) return false;
  try {
    const payload = rawBody.toString("utf8");
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const clean = sig.replace(/^sha256=/, "").trim();
    return crypto.timingSafeEqual(
      Buffer.from(clean.slice(0, expected.length).padEnd(expected.length, "0")),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}
