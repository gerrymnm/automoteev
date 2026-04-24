import type { MaintenanceItem, Vehicle } from "../types.js";
import { listMaintenanceCostKeys, getMaintenanceCost } from "../services/market.js";

/**
 * Maintenance schedule logic.
 *
 * Rule set (until OEM service-plan data is integrated):
 *   - Vehicles that require synthetic oil (roughly: model year >= 2014,
 *     most trims of most makes): oil change every 7,500 miles or 6 months
 *   - Older vehicles on conventional oil: every 5,000 miles or 4 months
 *   - Tire rotation every 7,500 miles
 *   - Air / cabin filter every 20,000 miles
 *   - Brake inspection every 15,000 miles
 */

export function baseIntervalsForVehicle(vehicle: Pick<Vehicle, "year">) {
  const synthetic = (vehicle.year ?? 0) >= 2014;
  return {
    oil_change_miles: synthetic ? 7500 : 5000,
    oil_change_months: synthetic ? 6 : 4,
    tire_rotation_miles: 7500,
    air_filter_miles: 20000,
    cabin_filter_miles: 20000,
    brake_inspection_miles: 15000
  };
}

/**
 * Derive a seed maintenance schedule for a newly-onboarded vehicle.
 * Returns rows ready for insert into `maintenance_items`.
 */
export function seedMaintenanceItems(params: {
  userId: string;
  vehicleId: string;
  currentMileage: number;
  year: number | null;
  state: string | null;
}) {
  const intervals = baseIntervalsForVehicle({ year: params.year });
  const synthetic = (params.year ?? 0) >= 2014;
  const items: Array<Partial<MaintenanceItem> & { user_id: string; vehicle_id: string; item_type: string }> = [];

  function next(interval: number) {
    return Math.ceil((params.currentMileage + 1) / interval) * interval;
  }

  const oilType = synthetic ? "oil_change_synthetic" : "oil_change_conventional";
  const oilCost = getMaintenanceCost(oilType, params.state);
  items.push({
    user_id: params.userId,
    vehicle_id: params.vehicleId,
    item_type: oilType,
    interval_miles: intervals.oil_change_miles,
    interval_months: intervals.oil_change_months,
    due_mileage: next(intervals.oil_change_miles),
    status: "upcoming",
    estimated_cost_cents: oilCost?.national_median_cents ?? null
  });

  const rotation = getMaintenanceCost("tire_rotation", params.state);
  items.push({
    user_id: params.userId,
    vehicle_id: params.vehicleId,
    item_type: "tire_rotation",
    interval_miles: intervals.tire_rotation_miles,
    due_mileage: next(intervals.tire_rotation_miles),
    status: "upcoming",
    estimated_cost_cents: rotation?.national_median_cents ?? null
  });

  const airFilter = getMaintenanceCost("air_filter", params.state);
  items.push({
    user_id: params.userId,
    vehicle_id: params.vehicleId,
    item_type: "air_filter",
    interval_miles: intervals.air_filter_miles,
    due_mileage: next(intervals.air_filter_miles),
    status: "upcoming",
    estimated_cost_cents: airFilter?.national_median_cents ?? null
  });

  const cabinFilter = getMaintenanceCost("cabin_filter", params.state);
  items.push({
    user_id: params.userId,
    vehicle_id: params.vehicleId,
    item_type: "cabin_filter",
    interval_miles: intervals.cabin_filter_miles,
    due_mileage: next(intervals.cabin_filter_miles),
    status: "upcoming",
    estimated_cost_cents: cabinFilter?.national_median_cents ?? null
  });

  return items;
}

/**
 * Lightweight in-memory "next due" summary for the dashboard.
 * Uses stored maintenance_items if any; otherwise falls back to the old
 * 5,000-mile heuristic so the dashboard never renders empty.
 */
export function maintenanceDue(
  vehicle: Pick<Vehicle, "mileage" | "next_service_due_miles"> & { obd_mileage?: number | null; year?: number | null },
  items?: MaintenanceItem[] | null
) {
  const mileage = vehicle.obd_mileage ?? vehicle.mileage;

  if (items && items.length > 0) {
    const withDue = items
      .filter((i) => i.status === "upcoming" || i.status === "due" || i.status === "overdue")
      .filter((i) => i.due_mileage != null);
    withDue.sort((a, b) => (a.due_mileage ?? 0) - (b.due_mileage ?? 0));
    const next = withDue[0];
    if (next) {
      const nextDue = next.due_mileage ?? mileage + 5000;
      const milesRemaining = nextDue - mileage;
      return {
        next_service_due_miles: nextDue,
        next_service_type: next.item_type,
        service_due_soon: milesRemaining <= 500,
        service_overdue: milesRemaining < 0,
        miles_remaining: milesRemaining,
        assumption: "Derived from maintenance_items schedule."
      };
    }
  }

  const { oil_change_miles } = baseIntervalsForVehicle({ year: vehicle.year ?? null });
  const heuristicNext =
    vehicle.next_service_due_miles ?? Math.ceil((mileage + 1) / oil_change_miles) * oil_change_miles;
  const milesRemaining = heuristicNext - mileage;

  return {
    next_service_due_miles: heuristicNext,
    next_service_type: null,
    service_due_soon: milesRemaining <= 500,
    service_overdue: milesRemaining < 0,
    miles_remaining: milesRemaining,
    assumption: "Heuristic schedule — seed maintenance_items for per-vehicle accuracy."
  };
}

export function refreshItemStatuses(currentMileage: number, items: MaintenanceItem[]) {
  return items.map((item) => {
    if (item.status === "completed" || item.status === "skipped") return item;
    const due = item.due_mileage ?? null;
    if (due == null) return item;
    const remaining = due - currentMileage;
    let status = item.status;
    if (remaining < 0) status = "overdue";
    else if (remaining <= 500) status = "due";
    else status = "upcoming";
    return { ...item, status };
  });
}

// Exported so routes can iterate fixed keys.
export { listMaintenanceCostKeys };
