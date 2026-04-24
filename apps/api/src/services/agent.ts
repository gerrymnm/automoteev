import { env } from "../config.js";
import { supabaseAdmin } from "../supabase.js";
import type { Profile } from "../types.js";

/**
 * Agent autonomy & subscription gating.
 *
 * Rule: the first AUTONOMY_APPROVAL_THRESHOLD (default 3) outbound emails for
 * a user require explicit approval. Once that count is reached, the agent is
 * allowed to send autonomously for subsequent tasks.
 */

export interface AutonomyState {
  approved_email_count: number;
  threshold: number;
  autonomy_unlocked: boolean;
  autonomy_unlocked_at: string | null;
  requires_approval_for_next_send: boolean;
}

export async function getAutonomyState(userId: string): Promise<AutonomyState> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("approved_email_count, autonomy_unlocked_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;

  const approved = data?.approved_email_count ?? 0;
  const threshold = env.AUTONOMY_APPROVAL_THRESHOLD;
  const unlocked = approved >= threshold || data?.autonomy_unlocked_at != null;

  return {
    approved_email_count: approved,
    threshold,
    autonomy_unlocked: unlocked,
    autonomy_unlocked_at: data?.autonomy_unlocked_at ?? null,
    requires_approval_for_next_send: !unlocked
  };
}

/**
 * Increment approval counter after an outbound email is actually sent with the
 * owner's explicit per-email approval. Auto-unlocks autonomy when the
 * threshold is reached.
 */
export async function recordApprovedSend(userId: string): Promise<AutonomyState> {
  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("approved_email_count, autonomy_unlocked_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;

  const previous = profile?.approved_email_count ?? 0;
  const next = previous + 1;
  const threshold = env.AUTONOMY_APPROVAL_THRESHOLD;
  const shouldUnlock = next >= threshold && !profile?.autonomy_unlocked_at;

  await supabaseAdmin
    .from("profiles")
    .update({
      approved_email_count: next,
      ...(shouldUnlock ? { autonomy_unlocked_at: new Date().toISOString() } : {})
    })
    .eq("id", userId);

  return getAutonomyState(userId);
}

/**
 * Subscription gate for Pro-only features.
 * Reads from subscriptions table first (source of truth for Stripe + IAP),
 * falls back to legacy profiles.plan for backward compatibility.
 */
export async function isPro(userId: string): Promise<boolean> {
  const { data: sub } = await supabaseAdmin
    .from("subscriptions")
    .select("status")
    .eq("user_id", userId)
    .maybeSingle();
  if (sub && ["active", "trialing"].includes(sub.status)) return true;

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("plan")
    .eq("id", userId)
    .maybeSingle();
  return profile?.plan === "pro";
}

/**
 * Helper for routes that want the full profile context.
 */
export async function getProfile(userId: string): Promise<Profile | null> {
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  return (data as Profile | null) ?? null;
}
