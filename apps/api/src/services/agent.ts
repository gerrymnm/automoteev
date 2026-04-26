import { env } from "../config.js";
import { supabaseAdmin } from "../supabase.js";
import type { Profile } from "../types.js";

/**
 * Per-category autonomy.
 *
 * Categories: 'service' | 'insurance' | 'lending' | 'sale' | 'fuel' | 'general'
 *
 * Levels:
 *   1 - Assisted     : asks before every outbound action
 *   2 - Trusted      : repeats allowed for tasks already approved within this category
 *   3 - Autonomous   : handles approved task categories without asking each time
 *
 * v1 surfaces a single global level (rolled up across categories), but the
 * data layer is per-category from day one so per-category UI is a flip later.
 */

export type AutonomyCategory =
  | "service"
  | "insurance"
  | "lending"
  | "sale"
  | "fuel"
  | "general";

export interface CategoryAutonomy {
  category: AutonomyCategory;
  level: 1 | 2 | 3;
  level_label: "Assisted" | "Trusted" | "Autonomous";
  level_description: string;
  approved_count: number;
  threshold: number;
  unlocked_at: string | null;
  requires_approval_for_next_send: boolean;
}

export interface AutonomyState {
  // Global rollup (the lowest category level)
  level: 1 | 2 | 3;
  level_label: "Assisted" | "Trusted" | "Autonomous";
  level_description: string;
  approved_email_count: number;
  threshold: number;
  autonomy_unlocked: boolean;
  autonomy_unlocked_at: string | null;
  requires_approval_for_next_send: boolean;
  // Per-category breakdown
  categories: CategoryAutonomy[];
}

const LEVEL_LABELS: Record<1 | 2 | 3, "Assisted" | "Trusted" | "Autonomous"> = {
  1: "Assisted",
  2: "Trusted",
  3: "Autonomous"
};

const LEVEL_DESCRIPTIONS: Record<1 | 2 | 3, string> = {
  1: "Asks before every outbound action.",
  2: "Repeats allowed for tasks you've already approved.",
  3: "Handles approved task categories without asking each time."
};

const ALL_CATEGORIES: AutonomyCategory[] = [
  "service",
  "insurance",
  "lending",
  "sale",
  "fuel",
  "general"
];

function levelFromCount(count: number, threshold: number): 1 | 2 | 3 {
  if (count >= threshold) return 3;
  if (count >= 1) return 2;
  return 1;
}

function buildCategoryRecord(
  category: AutonomyCategory,
  approved: number,
  unlockedAt: string | null,
  threshold: number
): CategoryAutonomy {
  const level = levelFromCount(approved, threshold);
  return {
    category,
    level,
    level_label: LEVEL_LABELS[level],
    level_description: LEVEL_DESCRIPTIONS[level],
    approved_count: approved,
    threshold,
    unlocked_at: unlockedAt,
    requires_approval_for_next_send: level < 2
  };
}

export async function getAutonomyState(userId: string): Promise<AutonomyState> {
  const threshold = env.AUTONOMY_APPROVAL_THRESHOLD;

  // Read all category rows; categories without a row are implicitly Level 1.
  const { data: rows } = await supabaseAdmin
    .from("category_autonomy")
    .select("category, approved_count, level, unlocked_at")
    .eq("user_id", userId);

  const byCategory = new Map<string, { approved_count: number; unlocked_at: string | null }>();
  for (const row of rows ?? []) {
    byCategory.set(row.category, {
      approved_count: row.approved_count,
      unlocked_at: row.unlocked_at
    });
  }

  const categories: CategoryAutonomy[] = ALL_CATEGORIES.map((c) => {
    const row = byCategory.get(c);
    return buildCategoryRecord(c, row?.approved_count ?? 0, row?.unlocked_at ?? null, threshold);
  });

  // Global = the LOWEST category level (most conservative interpretation)
  const globalLevel = categories.reduce<1 | 2 | 3>(
    (min, c) => (c.level < min ? c.level : min),
    3 as 1 | 2 | 3
  );
  const globalApproved = Math.max(...categories.map((c) => c.approved_count));
  const globalUnlockedAt = categories
    .map((c) => c.unlocked_at)
    .filter((d): d is string => Boolean(d))
    .sort()[0] ?? null;

  return {
    level: globalLevel,
    level_label: LEVEL_LABELS[globalLevel],
    level_description: LEVEL_DESCRIPTIONS[globalLevel],
    approved_email_count: globalApproved,
    threshold,
    autonomy_unlocked: globalLevel === 3,
    autonomy_unlocked_at: globalUnlockedAt,
    requires_approval_for_next_send: globalLevel < 2,
    categories
  };
}

/**
 * Increment approval counter for a specific category. Auto-unlocks when threshold met.
 * If category isn't provided, defaults to 'general' (legacy behavior).
 */
export async function recordApprovedSend(
  userId: string,
  category: AutonomyCategory = "general"
): Promise<AutonomyState> {
  const threshold = env.AUTONOMY_APPROVAL_THRESHOLD;

  const { data: existing } = await supabaseAdmin
    .from("category_autonomy")
    .select("approved_count, unlocked_at")
    .eq("user_id", userId)
    .eq("category", category)
    .maybeSingle();

  const previous = existing?.approved_count ?? 0;
  const next = previous + 1;
  const wasUnlocked = !!existing?.unlocked_at;
  const shouldUnlock = next >= threshold && !wasUnlocked;
  const newLevel = levelFromCount(next, threshold);

  await supabaseAdmin.from("category_autonomy").upsert(
    {
      user_id: userId,
      category,
      approved_count: next,
      level: newLevel,
      unlocked_at: shouldUnlock ? new Date().toISOString() : existing?.unlocked_at ?? null
    },
    { onConflict: "user_id,category" }
  );

  // Mirror to legacy profiles.approved_email_count for any code that still reads it.
  // (Kept until we remove all references.)
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
 *
 * Pro is granted by ANY of:
 *   1. Active or trialing Stripe subscription (real customers)
 *   2. profiles.plan = 'pro'                       (legacy / manual override)
 *   3. profiles.is_test_pro = TRUE                  (internal test users)
 *
 * To grant test-pro to a user, run:
 *   UPDATE profiles SET is_test_pro = TRUE WHERE id = '<user_id>';
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
    .select("plan, is_test_pro")
    .eq("id", userId)
    .maybeSingle();
  if (!profile) return false;
  if ((profile as any).is_test_pro === true) return true;
  return (profile as any).plan === "pro";
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  return (data as Profile | null) ?? null;
}
