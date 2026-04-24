import type { TaskType } from "../types.js";

/**
 * Map free-form owner commands into structured task intents.
 * Phone is NEVER added to shared_fields here — phone is withheld from
 * outbound email and only disclosed after the owner confirms the chosen vendor.
 */

const commandMap: Array<{ phrases: string[]; type: TaskType; title: string; requiresApproval: boolean }> = [
  { phrases: ["cheaper insurance", "insurance quote", "insurance"], type: "insurance_quote", title: "Find cheaper insurance", requiresApproval: true },
  { phrases: ["book service", "service appointment", "service"], type: "service_appointment", title: "Book service", requiresApproval: true },
  { phrases: ["recall appointment", "schedule recall"], type: "recall_appointment", title: "Schedule recall work", requiresApproval: true },
  { phrases: ["check recalls", "recall"], type: "recall_check", title: "Check recalls", requiresApproval: false },
  { phrases: ["sell my car", "trade in", "sell"], type: "sell_vehicle", title: "Prepare to sell vehicle", requiresApproval: true },
  { phrases: ["refinance", "lower my rate"], type: "refinance_review", title: "Review refinance options", requiresApproval: true },
  { phrases: ["review my loan", "loan"], type: "refinance_review", title: "Review loan", requiresApproval: true },
  { phrases: ["lease end", "lease turn in", "lease"], type: "lease_end_review", title: "Review lease-end options", requiresApproval: true },
  { phrases: ["get my payoff", "payoff"], type: "payoff_request", title: "Request payoff", requiresApproval: true },
  { phrases: ["maintenance quote"], type: "maintenance_quote", title: "Get maintenance quote", requiresApproval: true }
];

export function taskFromCommand(command: string): {
  task_type: TaskType;
  title: string;
  status: "created" | "needs_user_approval";
  approval_summary: string | null;
  external_contacts: string[];
  shared_fields: string[];
} {
  const normalized = command.toLowerCase();
  const match = commandMap.find((item) => item.phrases.some((phrase) => normalized.includes(phrase)));
  const type = match?.type ?? "general_owner_request";
  const requiresApproval = match?.requiresApproval ?? false;

  return {
    task_type: type,
    title: match?.title ?? (command.trim().slice(0, 80) || "Owner request"),
    status: requiresApproval ? "needs_user_approval" : "created",
    approval_summary: requiresApproval ? approvalCopy(type) : null,
    external_contacts: requiresApproval ? suggestedContacts(type) : [],
    shared_fields: requiresApproval ? ["name", "email", "vehicle", "VIN", "mileage"] : []
    // NOTE: phone is intentionally omitted. It's shared only after vendor confirmation.
  };
}

export function approvalCopy(type: TaskType) {
  const reason: Partial<Record<TaskType, string>> = {
    insurance_quote: "to compare pricing and coverage options",
    service_appointment: "to ask about availability and service requirements",
    recall_appointment: "to confirm recall service eligibility and scheduling",
    maintenance_quote: "to get written pricing from shops",
    payoff_request: "to obtain your current payoff amount",
    lease_end_review: "to clarify lease-end options and deadlines",
    refinance_review: "to compare refinance offers from lenders",
    sell_vehicle: "to prepare valuation and sale outreach"
  };

  return `Automoteev will contact relevant providers only for this ${type.replaceAll(
    "_",
    " "
  )} task ${reason[type] ?? "to complete your approved owner request"}.`;
}

function suggestedContacts(type: TaskType) {
  if (type.includes("insurance")) return ["insurance providers"];
  if (type.includes("payoff") || type.includes("lease") || type.includes("refinance")) return ["lender or lease provider"];
  if (type.includes("sell")) return ["vehicle buying providers"];
  return ["service providers"];
}
