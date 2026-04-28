/**
 * Daily VIN recall recheck.
 *
 * Runs once a day in-process (no external scheduler needed for a small
 * single-instance deployment). For each active vehicle:
 *   1. Hits NHTSA recallsByVin for the current VIN
 *   2. Upserts new campaigns; marks resolved campaigns as resolved
 *   3. Updates vehicles.recall_status + last_recall_check_at
 *   4. Writes a thread_event to the vehicle's most recent recall task (if any)
 *      so the timeline shows the daily check happened
 *
 * Why setInterval not node-cron: zero deps, fine for a single Railway
 * instance. If we ever scale horizontally, swap to a real scheduler so the
 * job doesn't run N times.
 */

import { supabaseAdmin } from "../supabase.js";
import { lookupRecallsByVin } from "../services/recalls.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000; // 60s after boot, so health checks pass first

export function startDailyRecallsJob() {
  console.log("[cron] daily-recalls scheduled — first run in 60s, then every 24h");
  setTimeout(() => {
    void runDailyRecallCheck().catch((err) =>
      console.error("[cron] daily-recalls first run failed", err)
    );
    setInterval(() => {
      void runDailyRecallCheck().catch((err) =>
        console.error("[cron] daily-recalls run failed", err)
      );
    }, ONE_DAY_MS);
  }, FIRST_RUN_DELAY_MS);
}

/**
 * Single pass: iterate all vehicles whose last recall check is null or older
 * than 20 hours, hit NHTSA, persist deltas. Idempotent — safe to retry.
 */
export async function runDailyRecallCheck(): Promise<{
  checked: number;
  newRecalls: number;
  resolved: number;
  errors: number;
}> {
  const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
  const { data: vehicles, error } = await supabaseAdmin
    .from("vehicles")
    .select("id, user_id, vin, recall_status, last_recall_check_at")
    .or(`last_recall_check_at.is.null,last_recall_check_at.lt.${cutoff}`)
    .limit(500);

  if (error) {
    console.error("[cron] daily-recalls vehicle query failed", error);
    return { checked: 0, newRecalls: 0, resolved: 0, errors: 1 };
  }

  let newRecalls = 0;
  let resolved = 0;
  let errors = 0;
  const checked = vehicles?.length ?? 0;
  console.log(`[cron] daily-recalls: ${checked} vehicle(s) due for re-check`);

  for (const v of vehicles ?? []) {
    try {
      const result = await lookupRecallsByVin((v as any).vin);

      // Pull the existing open recalls for diff
      const { data: existingOpen } = await supabaseAdmin
        .from("recalls")
        .select("id, nhtsa_campaign_id")
        .eq("vehicle_id", (v as any).id)
        .is("resolved_at", null);

      const existingIds = new Set(
        (existingOpen ?? []).map((r: any) => r.nhtsa_campaign_id as string)
      );
      const incomingIds = new Set(
        result.campaigns.map((c) => c.nhtsa_campaign_id)
      );

      // Insert any new campaigns NHTSA reports
      const newCampaigns = result.campaigns.filter(
        (c) => !existingIds.has(c.nhtsa_campaign_id)
      );
      if (newCampaigns.length) {
        await supabaseAdmin.from("recalls").upsert(
          newCampaigns.map((c) => ({
            user_id: (v as any).user_id,
            vehicle_id: (v as any).id,
            nhtsa_campaign_id: c.nhtsa_campaign_id,
            summary: c.summary,
            component: c.component,
            consequence: c.consequence,
            remedy: c.remedy,
            reported_at: c.reported_at
          })),
          { onConflict: "vehicle_id,nhtsa_campaign_id", ignoreDuplicates: true }
        );
        newRecalls += newCampaigns.length;
      }

      // Mark any campaigns that NHTSA no longer lists as resolved
      const goneIds = (existingOpen ?? [])
        .filter((r: any) => !incomingIds.has(r.nhtsa_campaign_id))
        .map((r: any) => r.id);
      if (goneIds.length) {
        await supabaseAdmin
          .from("recalls")
          .update({ resolved_at: new Date().toISOString() })
          .in("id", goneIds);
        resolved += goneIds.length;
      }

      await supabaseAdmin
        .from("vehicles")
        .update({
          recall_status: result.hasOpenRecall ? "open" : "clear",
          last_recall_check_at: new Date().toISOString()
        })
        .eq("id", (v as any).id);

      // If the user has an active recall_repair task, log this check on its
      // timeline so the user can see the agent kept watching.
      if (newCampaigns.length || goneIds.length) {
        const { data: activeRecallTask } = await supabaseAdmin
          .from("vehicle_tasks")
          .select("id")
          .eq("vehicle_id", (v as any).id)
          .eq("task_type", "recall_repair")
          .in("status", ["needs_user_approval", "approved", "in_progress", "waiting_on_provider"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (activeRecallTask) {
          await supabaseAdmin.from("thread_events").insert({
            user_id: (v as any).user_id,
            task_id: (activeRecallTask as any).id,
            kind: "system",
            summary: `Daily recall check: ${newCampaigns.length} new, ${goneIds.length} resolved`,
            detail: null,
            metadata: {
              new_campaigns: newCampaigns.map((c) => c.nhtsa_campaign_id),
              resolved_campaigns: goneIds.length
            }
          });
        }
      }
    } catch (err) {
      errors++;
      console.error(
        `[cron] daily-recalls failed for vehicle ${(v as any).id}`,
        err
      );
    }
  }

  console.log(
    `[cron] daily-recalls done: checked=${checked} new=${newRecalls} resolved=${resolved} errors=${errors}`
  );
  return { checked, newRecalls, resolved, errors };
}
