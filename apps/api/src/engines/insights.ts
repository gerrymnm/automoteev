// Insight engine: always returns a prioritized list of things Automoteev can do
// for the user — gaps to close, savings to capture, action to take. The dashboard
// uses the top item as the hero "Recommended action" and the rest as the
// "Things to improve" panel. This is what makes Automoteev feel alive.

import type { OverallStatus } from "../types.js";
import { maintenanceDue } from "./maintenance.js";

export type InsightSeverity = "info" | "recommended" | "urgent";
export type InsightCategory =
  | "savings"
  | "safety"
  | "completeness"
  | "maintenance"
  | "action_ready"
  | "info";

export interface Insight {
  key: string;
  category: InsightCategory;
  severity: InsightSeverity;
  title: string;
  body: string;
  cta_label: string;
  cta_route: string;
  estimated_savings_usd_per_year?: number;
}

export interface InsightInput {
  vehicle: {
    id: string;
    mileage: number;
    ownership_type: "owned" | "financed" | "leased" | string;
    next_service_due_miles: number | null;
    recall_status: string | null;
    year?: number | null;
    make?: string | null;
    model?: string | null;
  };
  costProfile?: {
    total_monthly_cost_cents: number | null;
    annual_cost_cents: number | null;
  } | null;
  loanLease?: {
    balance_cents: number | null;
    monthly_payment_cents: number | null;
    apr_bps: number | null;
    term_months: number | null;
    lease_maturity_date: string | null;
  } | null;
  insurance?: {
    carrier_name: string | null;
    premium_cents: number | null;
    renewal_date: string | null;
    coverage_type?: string | null;
  } | null;
  maintenanceItems?: Array<{
    due_mileage: number | null;
    due_date: string | null;
    status: string;
    item_type: string;
  }> | null;
  openRecallCount: number;
  preferredServiceShopExists: boolean;
  monthsSinceLastFuelEntry: number | null;
  daysSinceLastInsuranceShop: number | null;
}

export function generateInsights(input: InsightInput): Insight[] {
  const list: Insight[] = [];

  // ---- SAFETY ----
  if (input.openRecallCount > 0) {
    list.push({
      key: "open_recall",
      category: "safety",
      severity: "urgent",
      title:
        input.openRecallCount === 1
          ? "1 open recall on your vehicle"
          : `${input.openRecallCount} open recalls on your vehicle`,
      body: "Recall repairs are free at any authorized dealer. Automoteev can request appointment availability for you.",
      cta_label: "Have Automoteev schedule it",
      cta_route: "/tasks/new?type=recall_repair"
    });
  }

  if (input.vehicle.recall_status === "unknown" || input.vehicle.recall_status === null) {
    list.push({
      key: "recall_check_missing",
      category: "safety",
      severity: "recommended",
      title: "Run a recall check",
      body: "Automoteev hasn't yet looked up open recalls for this VIN. Takes a few seconds.",
      cta_label: "Run recall check now",
      cta_route: "/recalls/check"
    });
  }

  // ---- MAINTENANCE ----
  const maint = maintenanceDue(input.vehicle, (input.maintenanceItems ?? null) as any);
  if (maint.service_overdue) {
    list.push({
      key: "service_overdue",
      category: "maintenance",
      severity: "urgent",
      title: "Service is overdue",
      body: `Your vehicle is past its next service interval at ${maint.next_service_due_miles.toLocaleString()} miles. Skipping maintenance reduces resale value and risks engine wear.`,
      cta_label: "Find a shop",
      cta_route: "/tasks/new?type=service"
    });
  } else if (maint.service_due_soon) {
    list.push({
      key: "service_due_soon",
      category: "maintenance",
      severity: "recommended",
      title: "Service due soon",
      body: `Next service is around ${maint.next_service_due_miles.toLocaleString()} miles. Automoteev can request quotes from nearby shops.`,
      cta_label: "Get service quotes",
      cta_route: "/tasks/new?type=service"
    });
  }

  if (input.maintenanceItems) {
    for (const item of input.maintenanceItems) {
      if (item.status === "overdue" && item.item_type !== "oil_change") {
        list.push({
          key: `maint_overdue_${item.item_type}`,
          category: "maintenance",
          severity: "urgent",
          title: `${humanize(item.item_type)} overdue`,
          body: "Automoteev can request quotes from nearby shops for this service.",
          cta_label: "Get quotes",
          cta_route: "/tasks/new?type=service"
        });
      }
    }
  }

  // ---- SAVINGS — INSURANCE ----
  const premiumCents = input.insurance?.premium_cents ?? 0;
  if (input.insurance?.carrier_name && premiumCents > 0) {
    const monthlyDollars = premiumCents / 100;
    const stale =
      input.daysSinceLastInsuranceShop === null ||
      input.daysSinceLastInsuranceShop >= 180;
    if (stale && monthlyDollars >= 100) {
      const annualSavings = Math.round(monthlyDollars * 12 * 0.1);
      list.push({
        key: "shop_insurance",
        category: "savings",
        severity: "recommended",
        title: `Could save ~$${annualSavings}/yr on insurance`,
        body: `You're paying $${monthlyDollars.toFixed(0)}/mo. Drivers who rate-shop every 6 months save ~10% on average. Automoteev can request quotes from 3-5 carriers.`,
        cta_label: "Get insurance quotes",
        cta_route: "/tasks/new?type=insurance_quote",
        estimated_savings_usd_per_year: annualSavings
      });
    }
  }

  if (input.insurance?.renewal_date) {
    const days = daysUntil(input.insurance.renewal_date);
    if (days >= 0 && days <= 30) {
      list.push({
        key: "insurance_renewal_window",
        category: "savings",
        severity: "urgent",
        title: `Insurance renews in ${days} day${days === 1 ? "" : "s"}`,
        body: "This is the cheapest time to switch carriers. Automoteev can pull competing quotes today.",
        cta_label: "Shop competing quotes",
        cta_route: "/tasks/new?type=insurance_quote",
        estimated_savings_usd_per_year:
          premiumCents > 0 ? Math.round((premiumCents / 100) * 12 * 0.1) : undefined
      });
    }
  }

  // ---- SAVINGS — LOAN ----
  if (input.loanLease?.apr_bps && input.loanLease.balance_cents) {
    const apr = input.loanLease.apr_bps / 100;
    const balance = input.loanLease.balance_cents / 100;
    if (apr >= 8 && balance >= 5000) {
      const remainingMonths = Math.max(input.loanLease.term_months ?? 36, 12);
      const savedInterest = Math.round((balance * 0.02 * remainingMonths) / 12);
      list.push({
        key: "refinance_loan",
        category: "savings",
        severity: "recommended",
        title: `Refinancing could save ~$${savedInterest}/yr`,
        body: `Your APR is ${apr.toFixed(2)}%. Credit unions and online lenders are routinely 2+ points lower. Automoteev can request soft-pull quotes.`,
        cta_label: "Get refinance quotes",
        cta_route: "/tasks/new?type=refinance",
        estimated_savings_usd_per_year: savedInterest
      });
    }
  }

  if (input.loanLease?.lease_maturity_date) {
    const days = daysUntil(input.loanLease.lease_maturity_date);
    if (days >= 0 && days <= 90) {
      list.push({
        key: "lease_end_window",
        category: "action_ready",
        severity: "urgent",
        title: `Lease ends in ${days} day${days === 1 ? "" : "s"}`,
        body: "Now's the time to decide: buyout, return, or trade. Automoteev can prepare each option side-by-side.",
        cta_label: "Plan lease end",
        cta_route: "/tasks/new?type=lease_end"
      });
    }
  }

  // ---- COMPLETENESS ----
  if (
    input.vehicle.ownership_type !== "owned" &&
    !input.loanLease?.balance_cents
  ) {
    list.push({
      key: "missing_loan_info",
      category: "completeness",
      severity: "recommended",
      title: "Add your loan details",
      body: "Without your APR and balance, Automoteev can't tell you whether refinancing would save money. Takes 60 seconds.",
      cta_label: "Add loan details",
      cta_route: "/loan"
    });
  }
  if (!input.insurance?.carrier_name) {
    list.push({
      key: "missing_insurance",
      category: "completeness",
      severity: "recommended",
      title: "Add your insurance",
      body: "With your premium and renewal date, Automoteev can rate-shop on your behalf and only alert you to real savings.",
      cta_label: "Add insurance",
      cta_route: "/insurance"
    });
  } else if (!input.insurance.premium_cents || !input.insurance.renewal_date) {
    list.push({
      key: "incomplete_insurance",
      category: "completeness",
      severity: "info",
      title: "Complete your insurance details",
      body: "Add your premium and renewal date so Automoteev can time quote requests for the cheapest switch window.",
      cta_label: "Complete insurance",
      cta_route: "/insurance"
    });
  }
  if (!input.preferredServiceShopExists) {
    list.push({
      key: "no_preferred_shop",
      category: "completeness",
      severity: "info",
      title: "Pick a preferred service shop",
      body: "Automoteev will request quotes from a few options near you and remember the one you pick.",
      cta_label: "Find shops near me",
      cta_route: "/tasks/new?type=service"
    });
  }

  // ---- FUEL ----
  if (input.monthsSinceLastFuelEntry === null || input.monthsSinceLastFuelEntry > 1) {
    list.push({
      key: "log_fuel",
      category: "info",
      severity: "info",
      title: "Log this month's fuel spend",
      body: "Tracking fuel cost makes Automoteev's monthly cost number accurate and unlocks fuel-economy alerts.",
      cta_label: "Log fuel cost",
      cta_route: "/fuel"
    });
  }

  // Always at least ONE thing
  if (list.length === 0) {
    list.push({
      key: "all_good_value_check",
      category: "info",
      severity: "info",
      title: "Refresh your vehicle's market value",
      body: "Automoteev can pull the current estimated market and dealer values for your vehicle — useful before insurance renewal, refinancing, or selling.",
      cta_label: "Refresh value estimate",
      cta_route: "/value"
    });
  }

  return list.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

export function statusFromInsights(insights: Insight[]): OverallStatus {
  if (insights.some((i) => i.severity === "urgent")) return "action_needed";
  if (insights.some((i) => i.severity === "recommended")) return "action_recommended";
  return "all_good";
}

function severityRank(s: InsightSeverity): number {
  if (s === "urgent") return 3;
  if (s === "recommended") return 2;
  return 1;
}

function daysUntil(date: string): number {
  const target = new Date(`${date}T00:00:00.000Z`).getTime();
  return Math.ceil((target - Date.now()) / 86_400_000);
}

function humanize(slug: string): string {
  return slug
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
