import { supabaseAdmin } from "../supabase.js";
import type { OnboardingField } from "../types.js";
import { TRACKED_ONBOARDING_FIELDS } from "../types.js";

const NUDGE_INTERVAL_HOURS_BY_COUNT: number[] = [24, 24, 72, 168, 336]; // daily for 2d, then 3d, 7d, 14d

export async function recordSkippedFields(userId: string, skipped: OnboardingField[]) {
  if (skipped.length === 0) return;
  const rows = skipped.map((field) => ({
    user_id: userId,
    field_name: field,
    last_prompted_at: null,
    prompt_count: 0,
    dismissed: false,
    completed: false
  }));
  await supabaseAdmin.from("onboarding_prompts").upsert(rows, { onConflict: "user_id,field_name" });
}

export async function markFieldCompleted(userId: string, field: OnboardingField) {
  await supabaseAdmin
    .from("onboarding_prompts")
    .upsert(
      { user_id: userId, field_name: field, completed: true, dismissed: false, last_prompted_at: null, prompt_count: 0 },
      { onConflict: "user_id,field_name" }
    );
}

export async function pendingPromptsForUser(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("onboarding_prompts")
    .select("*")
    .eq("user_id", userId)
    .eq("completed", false)
    .eq("dismissed", false);
  if (error) throw error;
  return (data ?? []).filter((row) => isDue(row));
}

function isDue(row: { last_prompted_at: string | null; prompt_count: number }): boolean {
  if (!row.last_prompted_at) return true;
  const idx = Math.min(row.prompt_count, NUDGE_INTERVAL_HOURS_BY_COUNT.length - 1);
  const interval = NUDGE_INTERVAL_HOURS_BY_COUNT[idx] ?? 24;
  const next = new Date(row.last_prompted_at).getTime() + interval * 60 * 60 * 1000;
  return next <= Date.now();
}

export async function touchPrompted(userId: string, field: string) {
  const { data: existing } = await supabaseAdmin
    .from("onboarding_prompts")
    .select("prompt_count")
    .eq("user_id", userId)
    .eq("field_name", field)
    .maybeSingle();
  await supabaseAdmin
    .from("onboarding_prompts")
    .upsert(
      {
        user_id: userId,
        field_name: field,
        last_prompted_at: new Date().toISOString(),
        prompt_count: (existing?.prompt_count ?? 0) + 1
      },
      { onConflict: "user_id,field_name" }
    );
}

export async function dismissPrompt(userId: string, field: string) {
  await supabaseAdmin
    .from("onboarding_prompts")
    .upsert({ user_id: userId, field_name: field, dismissed: true }, { onConflict: "user_id,field_name" });
}

export const ONBOARDING_FIELDS = TRACKED_ONBOARDING_FIELDS;
