import type { TaskType } from "../types.js";

export function taskEmailSubject(type: TaskType, vehicleName: string): string {
  const subjects: Partial<Record<TaskType, string>> = {
    service_appointment: `Service request for ${vehicleName}`,
    maintenance_quote: `Maintenance quote request for ${vehicleName}`,
    recall_appointment: `Recall appointment request for ${vehicleName}`,
    insurance_quote: `Insurance quote request for ${vehicleName}`,
    payoff_request: `Payoff request for ${vehicleName}`,
    lease_end_review: `Lease-end inquiry for ${vehicleName}`,
    sell_vehicle: `Vehicle sale inquiry for ${vehicleName}`
  };
  return subjects[type] ?? `Automoteev request for ${vehicleName}`;
}

export function taskEmailBody(params: {
  type: TaskType;
  userName: string;
  vehicleName: string;
  vin: string;
  mileage: number;
  notes?: string | null;
}): string {
  return [
    `Automoteev on behalf of ${params.userName}`,
    "",
    `Request type: ${params.type.replaceAll("_", " ")}`,
    `Vehicle: ${params.vehicleName}`,
    `VIN: ${params.vin}`,
    `Mileage: ${params.mileage}`,
    "",
    params.notes ?? "Please respond with availability, pricing, and any information needed from the owner.",
    "",
    "Automoteev shares owner data only with explicit approval for this task."
  ].join("\n");
}
