import type { TaskType } from "../types.js";

/**
 * Outbound email subject lines.
 * Rule: subject must say WHY the dealer is being contacted, briefly.
 * "Request regarding ..." is too vague to earn a reply.
 */
export function taskEmailSubject(
  type: TaskType,
  vehicleName: string,
  context?: { recallCount?: number }
): string {
  switch (type) {
    case "recall_repair":
    case "recall_appointment": {
      const n = context?.recallCount ?? 0;
      if (n > 0) {
        return `Recall repair request — ${vehicleName} (${n} open campaign${n === 1 ? "" : "s"})`;
      }
      return `Recall repair request — ${vehicleName}`;
    }
    case "service_quote":
    case "service_appointment":
      return `Service quote request — ${vehicleName}`;
    case "maintenance_quote":
      return `Maintenance quote request — ${vehicleName}`;
    case "insurance_quote":
      return `Auto insurance quote request — ${vehicleName}`;
    case "refinance":
    case "refinance_review":
      return `Auto loan refinance quote — ${vehicleName}`;
    case "payoff_request":
      return `10-day payoff request — ${vehicleName}`;
    case "lease_end_review":
      return `Lease-end options inquiry — ${vehicleName}`;
    case "sell_vehicle":
      return `Cash offer request — ${vehicleName}`;
    default:
      return `Request regarding ${vehicleName}`;
  }
}

export interface RecallSummary {
  nhtsa_campaign_id: string;
  component: string | null;
}

/**
 * Outbound email body.
 * Rules:
 *   - Brevity. Owner gets a reply faster when the dealer can scan the email in 5 seconds.
 *   - Specific: state exactly what's being requested with concrete details.
 *   - For recall_repair, list the actual NHTSA campaigns so the dealer can verify
 *     parts availability before responding.
 *   - VIN + mileage always included (dealers ask for them on every reply otherwise).
 *   - Phone is NEVER disclosed in outbound email — only after the owner picks a vendor.
 */
export function taskEmailBody(params: {
  type: TaskType;
  userName: string;
  vehicleName: string;
  vin: string;
  mileage: number;
  notes?: string | null;
  recalls?: RecallSummary[];
}): string {
  const { type, userName, vehicleName, vin, mileage, notes, recalls } = params;
  const mileageStr = mileage.toLocaleString();

  if (type === "recall_repair" || type === "recall_appointment") {
    const list = (recalls ?? []).filter((r) => r.nhtsa_campaign_id);
    const lines = [
      `Hi,`,
      ``,
      `I'd like to schedule recall repair work on my ${vehicleName}.`,
      `VIN: ${vin}`,
      `Mileage: ${mileageStr}`,
      ``
    ];
    if (list.length > 0) {
      lines.push(`Open NHTSA campaigns on this VIN:`);
      for (const r of list) {
        const label = r.component?.trim()
          ? r.component.replace(/\s+/g, " ")
          : "Recall campaign";
        lines.push(`  • ${r.nhtsa_campaign_id} — ${label}`);
      }
      lines.push(``);
    }
    lines.push(
      `Please confirm parts availability and the earliest service appointment you can offer.`
    );
    if (notes?.trim()) {
      lines.push(``, notes.trim());
    }
    lines.push(``, `Thanks,`, userName);
    return lines.join("\n");
  }

  if (type === "service_quote" || type === "service_appointment" || type === "maintenance_quote") {
    return [
      `Hi,`,
      ``,
      `I'd like a written quote for service on my ${vehicleName}.`,
      `VIN: ${vin}`,
      `Mileage: ${mileageStr}`,
      ``,
      notes?.trim()
        ? notes.trim()
        : `Please reply with your hourly rate, a list of services you'd recommend at this mileage, and the earliest appointment you can offer.`,
      ``,
      `Thanks,`,
      userName
    ].join("\n");
  }

  if (type === "insurance_quote") {
    return [
      `Hi,`,
      ``,
      `I'm shopping auto insurance for my ${vehicleName} and would like a written quote.`,
      `VIN: ${vin}`,
      `Mileage: ${mileageStr}`,
      ``,
      notes?.trim()
        ? notes.trim()
        : `Please reply with your best 6-month and 12-month premiums for full coverage, plus the deductible options. I'll provide additional driver/coverage details on request.`,
      ``,
      `Thanks,`,
      userName
    ].join("\n");
  }

  if (type === "refinance" || type === "refinance_review") {
    return [
      `Hi,`,
      ``,
      `I'm considering refinancing my auto loan on my ${vehicleName}.`,
      `VIN: ${vin}`,
      `Mileage: ${mileageStr}`,
      ``,
      notes?.trim()
        ? notes.trim()
        : `Please reply with your current auto refinance rates and terms, plus what you'll need from me to issue a soft-pull pre-qualification.`,
      ``,
      `Thanks,`,
      userName
    ].join("\n");
  }

  if (type === "payoff_request") {
    return [
      `Hi,`,
      ``,
      `Please send the 10-day payoff figure for my loan/lease on my ${vehicleName}.`,
      `VIN: ${vin}`,
      `Mileage: ${mileageStr}`,
      ``,
      notes?.trim() ?? `I'll provide my account information separately on request.`,
      ``,
      `Thanks,`,
      userName
    ].join("\n");
  }

  if (type === "lease_end_review") {
    return [
      `Hi,`,
      ``,
      `I'd like to review lease-end options for my ${vehicleName} before maturity.`,
      `VIN: ${vin}`,
      `Mileage: ${mileageStr}`,
      ``,
      notes?.trim()
        ? notes.trim()
        : `Please reply with my current buyout figure, lease maturity date, and what's required to either purchase, return, or roll into a new lease.`,
      ``,
      `Thanks,`,
      userName
    ].join("\n");
  }

  if (type === "sell_vehicle") {
    return [
      `Hi,`,
      ``,
      `I'd like a cash offer for my ${vehicleName}.`,
      `VIN: ${vin}`,
      `Mileage: ${mileageStr}`,
      ``,
      notes?.trim()
        ? notes.trim()
        : `The vehicle is in clean condition with no accidents or open finance. Please reply with your best offer and how long it stays valid.`,
      ``,
      `Thanks,`,
      userName
    ].join("\n");
  }

  // Generic fallback — kept short.
  return [
    `Hi,`,
    ``,
    `I'd like your help with my ${vehicleName}.`,
    `VIN: ${vin}`,
    `Mileage: ${mileageStr}`,
    ``,
    notes?.trim()
      ? notes.trim()
      : `Please reply with what you'll need from me to move forward.`,
    ``,
    `Thanks,`,
    userName
  ].join("\n");
}
