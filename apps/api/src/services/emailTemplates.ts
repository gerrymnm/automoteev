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
  return subjects[type] ?? `Request regarding ${vehicleName}`;
}

export function taskEmailBody(params: {
  type: TaskType;
  userName: string;
  vehicleName: string;
  vin: string;
  mileage: number;
  notes?: string | null;
  // By product rule, phone is NEVER included in outbound email.
  // It is disclosed only after the owner confirms a specific vendor.
}): string {
  return [
    `Hi,`,
    ``,
    `I'm following up regarding my ${params.vehicleName}.`,
    `VIN: ${params.vin}`,
    `Current mileage: ${params.mileage.toLocaleString()}`,
    ``,
    describeRequest(params.type),
    ``,
    params.notes?.trim()
      ? params.notes.trim()
      : `Please reply with availability, expected pricing, and anything you'll need from me to move forward. I'll confirm before scheduling or committing.`,
    ``,
    `Thanks,`,
    params.userName
  ].join("\n");
}

function describeRequest(type: TaskType): string {
  switch (type) {
    case "service_appointment":
      return "I'd like to schedule a service appointment.";
    case "maintenance_quote":
      return "I'd like a written quote for upcoming maintenance.";
    case "recall_appointment":
      return "I'd like to schedule open recall work.";
    case "insurance_quote":
      return "I'd like a quote on auto insurance for this vehicle.";
    case "payoff_request":
      return "I'd like the 10-day payoff figure for my loan/lease on this vehicle.";
    case "lease_end_review":
      return "I'd like to discuss lease-end options before my maturity date.";
    case "sell_vehicle":
      return "I'd like an offer on this vehicle.";
    default:
      return "I'd like your help with a vehicle-related request.";
  }
}
