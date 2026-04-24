import type { Vehicle } from "../types.js";

const intervalMiles = 5000;

export function maintenanceDue(vehicle: Pick<Vehicle, "mileage" | "next_service_due_miles"> & { obd_mileage?: number | null }) {
  const mileage = vehicle.obd_mileage ?? vehicle.mileage;
  const nextDue = vehicle.next_service_due_miles ?? Math.ceil((mileage + 1) / intervalMiles) * intervalMiles;
  const milesRemaining = nextDue - mileage;

  return {
    next_service_due_miles: nextDue,
    service_due_soon: milesRemaining <= 500,
    service_overdue: milesRemaining < 0,
    miles_remaining: milesRemaining,
    assumption: "Every 5,000 miles until OBD/service-plan integrations are connected."
  };
}
