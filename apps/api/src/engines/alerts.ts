import type { AlertType, OverallStatus } from "../types.js";
import { maintenanceDue } from "./maintenance.js";

interface AlertInput {
  vehicle: {
    id: string;
    mileage: number;
    ownership_type: string;
    next_service_due_miles: number | null;
    obd_mileage?: number | null;
    recall_status: string | null;
    year?: number | null;
  };
  costProfile?: {
    total_monthly_cost_cents: number | null;
    missing_fields: string[] | null;
  } | null;
  loanLease?: {
    balance_cents: number | null;
    lease_maturity_date: string | null;
    principal_cents?: number | null;
    term_months?: number | null;
    start_date?: string | null;
  } | null;
  insurance?: {
    carrier_name: string | null;
    renewal_date: string | null;
    coverage_type?: string | null;
  } | null;
  maintenanceItems?: Array<{
    due_mileage: number | null;
    status: string;
    item_type: string;
  }> | null;
  autonomyUnlocked?: boolean;
}

export function generateAlerts(input: AlertInput) {
  const alerts: Array<{
    alert_type: AlertType;
    severity: "info" | "recommended" | "urgent";
    title: string;
    body: string;
  }> = [];

  if (input.vehicle.recall_status === "open") {
    alerts.push({
      alert_type: "open_recall",
      severity: "urgent",
      title: "Open recall needs attention",
      body: "Automoteev can contact a dealership service center to schedule recall work after you approve."
    });
  }

  if (!input.insurance?.carrier_name) {
    alerts.push({
      alert_type: "insurance_info_missing",
      severity: "recommended",
      title: "Insurance details missing",
      body: "Add your carrier, premium, and renewal date so Automoteev can alert you only when savings are available."
    });
  } else if (input.insurance.renewal_date && daysUntil(input.insurance.renewal_date) <= 30) {
    alerts.push({
      alert_type: "insurance_renewal_approaching",
      severity: "recommended",
      title: "Insurance renewal approaching",
      body: "Automoteev can request competing quotes before your renewal date."
    });
  }

  if (input.vehicle.ownership_type !== "owned" && !input.loanLease?.balance_cents) {
    alerts.push({
      alert_type: "loan_lease_info_missing",
      severity: "recommended",
      title: "Loan or lease details missing",
      body: "Add balance, APR, and term so Automoteev can surface refinance savings and payoff options."
    });
  }

  if (input.loanLease?.lease_maturity_date && daysUntil(input.loanLease.lease_maturity_date) <= 90) {
    alerts.push({
      alert_type: "lease_maturity_approaching",
      severity: "urgent",
      title: "Lease maturity approaching",
      body: "Automoteev can prepare a lease-end review and contact your leasing company after approval."
    });
  }

  const maintenance = maintenanceDue(
    { mileage: input.vehicle.mileage, next_service_due_miles: input.vehicle.next_service_due_miles, year: input.vehicle.year },
    (input.maintenanceItems ?? null) as any
  );
  if (maintenance.service_due_soon || maintenance.service_overdue) {
    alerts.push({
      alert_type: "service_due_soon",
      severity: maintenance.service_overdue ? "urgent" : "recommended",
      title: "Service due soon",
      body: `Next service is due around ${maintenance.next_service_due_miles.toLocaleString()} miles.`
    });
  }

  if ((input.costProfile?.total_monthly_cost_cents ?? 0) > 90000) {
    alerts.push({
      alert_type: "high_monthly_cost_opportunity",
      severity: "info",
      title: "High monthly cost opportunity",
      body: "Automoteev can review insurance or refinance options with your approval."
    });
  }

  alerts.push({
    alert_type: "vehicle_value_update_available",
    severity: "info",
    title: "Vehicle value estimate available",
    body: "Refresh your vehicle value estimate before selling, refinancing, or lease-end decisions."
  });

  return alerts;
}

export function statusFromAlerts(alerts: ReturnType<typeof generateAlerts>): OverallStatus {
  if (alerts.some((alert) => alert.severity === "urgent")) return "action_needed";
  if (alerts.some((alert) => alert.severity === "recommended")) return "action_recommended";
  return "all_good";
}

function daysUntil(date: string) {
  const target = new Date(`${date}T00:00:00.000Z`).getTime();
  const now = Date.now();
  return Math.ceil((target - now) / 86_400_000);
}
