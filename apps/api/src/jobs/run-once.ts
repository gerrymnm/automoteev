import { supabaseAdmin } from "../supabase.js";
import { lookupRecallsByVin } from "../services/recalls.js";
import { maintenanceDue } from "../engines/maintenance.js";

async function run() {
  const { data: vehicles, error } = await supabaseAdmin.from("vehicles").select("*");
  if (error) throw error;

  for (const vehicle of vehicles ?? []) {
    const recall = await lookupRecallsByVin(vehicle.vin);
    await supabaseAdmin.from("vehicles").update({ recall_status: recall.hasOpenRecall ? "open" : "clear" }).eq("id", vehicle.id);

    const maintenance = maintenanceDue(vehicle);
    if (maintenance.service_due_soon) {
      await supabaseAdmin.from("vehicle_alerts").insert({
        user_id: vehicle.user_id,
        vehicle_id: vehicle.id,
        alert_type: "service_due_soon",
        severity: maintenance.service_overdue ? "urgent" : "recommended",
        title: "Service due soon",
        body: `Next service is due around ${maintenance.next_service_due_miles.toLocaleString()} miles.`
      });
    }
  }

  console.log(`Placeholder jobs processed ${vehicles?.length ?? 0} vehicle(s).`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
