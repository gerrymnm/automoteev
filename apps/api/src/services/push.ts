import webpush, { type PushSubscription as WebPushSubscription } from "web-push";
import { env } from "../config.js";
import { supabaseAdmin } from "../supabase.js";

/**
 * Web Push (VAPID) — ambient agent updates that land on the user's lock
 * screen / notification tray when something happens, without requiring
 * them to keep the app open.
 *
 * Used for:
 *   - Dealer reply landed on an outbound task ("Land Rover Marin replied")
 *   - Recall task moved to completed
 *   - Insurance quote came back
 *
 * Per-device: a user might have subscriptions for laptop + phone simultaneously.
 * We send to all of them in parallel and prune any that come back with
 * 410 Gone (subscription cancelled by browser) or 404.
 *
 * Configured lazily — if VAPID keys are not present, every send is a no-op.
 * That way the app continues to work in development without keys.
 */

let vapidConfigured = false;

function ensureVapid(): boolean {
  if (vapidConfigured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return false;
  }
  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );
  vapidConfigured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  /** App-relative path to open when the user taps the notification. */
  url?: string;
  /** Group key — newer notifications with the same tag replace older ones. */
  tag?: string;
}

/**
 * Save (upsert) a browser push subscription for a user. Endpoint is unique
 * per device, so re-subscribing on the same device updates the existing row
 * instead of creating duplicates.
 */
export async function subscribePush(params: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}) {
  const { error } = await supabaseAdmin
    .from("push_subscriptions")
    .upsert(
      {
        user_id: params.userId,
        endpoint: params.endpoint,
        p256dh_key: params.p256dh,
        auth_key: params.auth,
        user_agent: params.userAgent,
        // Re-subscribing clears any prior failure state.
        failed_at: null,
        failure_reason: null
      },
      { onConflict: "endpoint" }
    );
  if (error) throw new Error(`push subscribe failed: ${error.message}`);
}

export async function unsubscribePush(params: { userId: string; endpoint: string }) {
  await supabaseAdmin
    .from("push_subscriptions")
    .delete()
    .eq("user_id", params.userId)
    .eq("endpoint", params.endpoint);
}

/**
 * Send a push notification to all of a user's active subscriptions.
 * Failures on individual subscriptions don't block the others.
 *
 * Returns the number of pushes that landed successfully so callers can
 * fall back to email if zero subscriptions delivered.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<number> {
  if (!ensureVapid()) {
    console.warn("[push] VAPID keys missing — skipping push send");
    return 0;
  }

  const { data: subs } = await supabaseAdmin
    .from("push_subscriptions")
    .select("*")
    .eq("user_id", userId)
    .is("failed_at", null);

  if (!subs?.length) return 0;

  const json = JSON.stringify(payload);
  let delivered = 0;

  await Promise.all(
    subs.map(async (sub) => {
      const subscription: WebPushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh_key, auth: sub.auth_key }
      };
      try {
        await webpush.sendNotification(subscription, json, { TTL: 60 * 60 * 24 });
        delivered++;
        await supabaseAdmin
          .from("push_subscriptions")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", sub.id);
      } catch (err: any) {
        const status = err?.statusCode;
        // 404/410 = subscription is dead (user revoked, browser cleared, etc).
        // Mark as failed so we stop wasting calls on it. Other failures (5xx,
        // network) might be transient — log and leave the row alone.
        if (status === 404 || status === 410) {
          await supabaseAdmin
            .from("push_subscriptions")
            .update({
              failed_at: new Date().toISOString(),
              failure_reason: `${status} ${err?.body ?? "expired"}`
            })
            .eq("id", sub.id);
          console.log(`[push] pruned stale subscription ${sub.id} (${status})`);
        } else {
          console.warn(`[push] send failed for ${sub.id}:`, status, err?.body ?? err);
        }
      }
    })
  );

  return delivered;
}
