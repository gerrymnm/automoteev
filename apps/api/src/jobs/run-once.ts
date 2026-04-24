import { supabaseAdmin } from "../supabase.js";
import { lookupRecallsByVehicle } from "../services/recalls.js";
import { maintenanceDue, refreshItemStatuses } from "../engines/maintenance.js";
import type { MaintenanceItem } from "../types.js";

/**
 * Daily sweep. Runs via `npm run jobs:run-once --workspace @automoteev/api`.
 * Schedule this in Railway as a daily cron.
 */
async function run() {
  const { data: vehicles, error } = await supabaseAdmin.from("vehicles").select("*");
  if (error) throw error;

  let recallsAdded = 0;
  let statusUpdates = 0;
  let alertInserts = 0;

  for (const vehicle of vehicles ?? []) {
    // 1. NHTSA recall check (requires decoded make/model/year)
    if (vehicle.make && vehicle.model && vehicle.year) {
      const result = await lookupRecallsByVehicle({
        make: vehicle.make,
        model: vehicle.model,
        modelYear: vehicle.year
      });

      if (result.campaigns.length) {
        const { data: inserted } = await supabaseAdmin
          .from("recalls")
          .upsert(
            result.campaigns.map((c) => ({
              user_id: vehicle.user_id,
              vehicle_id: vehicle.id,
              nhtsa_campaign_id: c.nhtsa_campaign_id,
              summary: c.summary,
              component: c.component,
              consequence: c.consequence,
              remedy: c.remedy,
              reported_at: c.reported_at
            })),
            { onConflict: "vehicle_id,nhtsa_campaign_id", ignoreDuplicates: true }
          )
          .select("id");
        recallsAdded += inserted?.length ?? 0;
      }

      await supabaseAdmin
        .from("vehicles")
        .update({ recall_status: result.hasOpenRecall ? "open" : "clear" })
        .eq("id", vehicle.id);

      if (result.hasOpenRecall) {
        // Surface an alert if none exists yet
        const { data: existing } = await supabaseAdmin
          .from("vehicle_alerts")
          .select("id")
          .eq("vehicle_id", vehicle.id)
          .eq("alert_type", "open_recall")
          .eq("is_resolved", false)
          .maybeSingle();
        if (!existing) {
          await supabaseAdmin.from("vehicle_alerts").insert({
            user_id: vehicle.user_id,
            vehicle_id: vehicle.id,
            alert_type: "open_recall",
            severity: "urgent",
            title: "Open recall needs attention",
            body: "Automoteev can schedule recall work with a dealership service center after your approval."
          });
          alertInserts++;
        }
      }
    }

    // 2. Refresh maintenance_items statuses based on current mileage
    const { data: items } = await supabaseAdmin
      .from("maintenance_items")
      .select("*")
      .eq("vehicle_id", vehicle.id);

    if (items && items.length) {
      const refreshed = refreshItemStatuses(
        vehicle.obd_mileage ?? vehicle.mileage,
        items as MaintenanceItem[]
      );
      for (let i = 0; i < refreshed.length; i++) {
        if (refreshed[i].status !== items[i].status) {
          await supabaseAdmin
            .from("maintenance_items")
            .update({ status: refreshed[i].status })
            .eq("id", refreshed[i].id);
          statusUpdates++;
        }
      }

      // Surface service-due alert
      const summary = maintenanceDue(
        { mileage: vehicle.mileage, next_service_due_miles: vehicle.next_service_due_miles, year: vehicle.year },
        refreshed
      );
      if (summary.service_due_soon || summary.service_overdue) {
        const { data: existing } = await supabaseAdmin
          .from("vehicle_alerts")
          .select("id")
          .eq("vehicle_id", vehicle.id)
          .eq("alert_type", "service_due_soon")
          .eq("is_resolved", false)
          .maybeSingle();
        if (!existing) {
          await supabaseAdmin.from("vehicle_alerts").insert({
            user_id: vehicle.user_id,
            vehicle_id: vehicle.id,
            alert_type: "service_due_soon",
            severity: summary.service_overdue ? "urgent" : "recommended",
            title: "Service due soon",
            body: `Next service is due around ${summary.next_service_due_miles.toLocaleString()} miles.`
          });
          alertInserts++;
        }
      }
    }
  }

  console.log(
    `Daily sweep complete. Vehicles processed: ${vehicles?.length ?? 0}. ` +
      `Recall campaigns added: ${recallsAdded}. Maintenance status updates: ${statusUpdates}. ` +
      `Alerts inserted: ${alertInserts}.`
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
