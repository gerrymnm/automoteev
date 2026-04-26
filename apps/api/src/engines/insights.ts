// Insight engine: always returns a prioritized list of things Automoteev can do
// for the user. Each insight declares an executable action, so tapping a
// recommendation creates a pre-populated task in needs_user_approval state
// (Option A: two-tap flow — create then approve).

import type { OverallStatus } from "../types.js";
import type { AutonomyCategory } from "../services/agent.js";
import { maintenanceDue } from "./maintenance.js";

export type InsightSeverity = "info" | "recommended" | "urgent";

export type InsightActionType =
  | "create_task" // Creates a vehicle_task in needs_user_approval state
  | "open_form" // Opens an inline form (e.g. add insurance)
  | "run_recall_check"; // Manual fallback for recall lookup

export interface InsightAction {
  type: InsightActionType;
  // For create_task:
  task_type?: string;
  category?: AutonomyCategory;
  task_title?: string;
  approval_summary?: string;
  shared_fields?: string[];
  prefill?: Record<string, unknown>;
  // For open_form:
  form_id?: "insurance" | "loan" | "fuel" | "preferred_shop";
}

export interface Insight {
  key: string;
  category: AutonomyCategory;
  severity: InsightSeverity;
  title: string;
  body: string;
  cta_label: string;
  action: InsightAction;
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
      category: "service",
      severity: "urgent",
      title:
        input.openRecallCount === 1
          ? "1 open recall on your vehicle"
          : `${input.openRecallCount} open recalls on your vehicle`,
      body: "Recall repairs are free at any authorized dealer. Automoteev can request appointment availability for you.",
      cta_label: "Have Automoteev schedule it",
      action: {
        type: "create_task",
        task_type: "recall_repair",
        category: "service",
        task_title: "Schedule recall repair",
        approval_summary:
          "Automoteev will contact 2-3 authorized dealers to request the soonest recall appointment.",
        shared_fields: ["name", "vehicle", "VIN", "mileage", "recall campaigns"]
      }
    });
  }

  if (input.vehicle.recall_status === "unknown" || input.vehicle.recall_status === null) {
    list.push({
      key: "recall_check_missing",
      category: "service",
      severity: "recommended",
      title: "Run a recall check",
      body: "Automoteev hasn't yet looked up open recalls for this VIN. Takes a few seconds.",
      cta_label: "Run recall check now",
      action: { type: "run_recall_check" }
    });
  }

  // ---- MAINTENANCE ----
  const maint = maintenanceDue(input.vehicle, (input.maintenanceItems ?? null) as any);
  if (maint.service_overdue) {
    list.push({
      key: "service_overdue",
      category: "service",
      severity: "urgent",
      title: "Service is overdue",
      body: `Your vehicle is past its next service interval at ${maint.next_service_due_miles.toLocaleString()} miles.`,
      cta_label: "Get service quotes",
      action: {
        type: "create_task",
        task_type: "service_quote",
        category: "service",
        task_title: "Get service quotes",
        approval_summary:
          "Automoteev will request quotes from 3 nearby shops for your overdue service items.",
        shared_fields: ["name", "vehicle", "mileage", "service items"]
      }
    });
  } else if (maint.service_due_soon) {
    list.push({
      key: "service_due_soon",
      category: "service",
      severity: "recommended",
      title: "Service due soon",
      body: `Next service is around ${maint.next_service_due_miles.toLocaleString()} miles. Automoteev can request quotes from nearby shops.`,
      cta_label: "Get service quotes",
      action: {
        type: "create_task",
        task_type: "service_quote",
        category: "service",
        task_title: "Get service quotes",
        approval_summary: "Automoteev will request quotes from 3 nearby shops.",
        shared_fields: ["name", "vehicle", "mileage", "service items"]
      }
    });
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
        category: "insurance",
        severity: "recommended",
        title: `Could save ~$${annualSavings}/yr on insurance`,
        body: `You're paying $${monthlyDollars.toFixed(0)}/mo. Drivers who rate-shop every 6 months save ~10% on average. Automoteev can request quotes from 3-5 carriers.`,
        cta_label: "Get insurance quotes",
        action: {
          type: "create_task",
          task_type: "insurance_quote",
          category: "insurance",
          task_title: "Shop competing insurance quotes",
          approval_summary:
            "Automoteev will request quotes from 3-5 carriers matching your current coverage.",
          shared_fields: ["name", "vehicle", "VIN", "ZIP", "current coverage"]
        },
        estimated_savings_usd_per_year: annualSavings
      });
    }
  }

  if (input.insurance?.renewal_date) {
    const days = daysUntil(input.insurance.renewal_date);
    if (days >= 0 && days <= 30) {
      list.push({
        key: "insurance_renewal_window",
        category: "insurance",
        severity: "urgent",
        title: `Insurance renews in ${days} day${days === 1 ? "" : "s"}`,
        body: "This is the cheapest time to switch carriers. Automoteev can pull competing quotes today.",
        cta_label: "Shop competing quotes",
        action: {
          type: "create_task",
          task_type: "insurance_quote",
          category: "insurance",
          task_title: "Shop competing insurance quotes",
          approval_summary:
            "Automoteev will request quotes from 3-5 carriers matching your current coverage.",
          shared_fields: ["name", "vehicle", "VIN", "ZIP", "current coverage"]
        },
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
        category: "lending",
        severity: "recommended",
        title: `Refinancing could save ~$${savedInterest}/yr`,
        body: `Your APR is ${apr.toFixed(2)}%. Credit unions and online lenders are routinely 2+ points lower. Automoteev can request soft-pull quotes.`,
        cta_label: "Get refinance quotes",
        action: {
          type: "create_task",
          task_type: "refinance",
          category: "lending",
          task_title: "Get refinance quotes",
          approval_summary:
            "Automoteev will request soft-pull quotes from 3 lenders. No hard credit pulls.",
          shared_fields: ["name", "vehicle", "VIN", "current APR", "current balance"]
        },
        estimated_savings_usd_per_year: savedInterest
      });
    }
  }

  if (input.loanLease?.lease_maturity_date) {
    const days = daysUntil(input.loanLease.lease_maturity_date);
    if (days >= 0 && days <= 90) {
      list.push({
        key: "lease_end_window",
        category: "lending",
        severity: "urgent",
        title: `Lease ends in ${days} day${days === 1 ? "" : "s"}`,
        body: "Now's the time to decide: buyout, return, or trade. Automoteev can prepare each option side-by-side.",
        cta_label: "Plan lease end",
        action: {
          type: "create_task",
          task_type: "lease_end",
          category: "lending",
          task_title: "Lease-end planning",
          approval_summary:
            "Automoteev will prepare buyout, return, and trade-in options side-by-side.",
          shared_fields: ["vehicle", "lease balance", "maturity date"]
        }
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
      category: "lending",
      severity: "recommended",
      title: "Add your loan details",
      body: "Without your APR and balance, Automoteev can't tell you whether refinancing would save money. Snap a photo of your loan statement and we'll fill it in.",
      cta_label: "Upload loan statement",
      action: { type: "open_form", form_id: "loan" }
    });
  }
  if (!input.insurance?.carrier_name) {
    list.push({
      key: "missing_insurance",
      category: "insurance",
      severity: "recommended",
      title: "Add your insurance",
      body: "Snap a photo of your insurance dec page and Automoteev will fill in carrier, premium, coverage, and renewal date automatically.",
      cta_label: "Upload dec page",
      action: { type: "open_form", form_id: "insurance" }
    });
  } else if (!input.insurance.premium_cents || !input.insurance.renewal_date) {
    list.push({
      key: "incomplete_insurance",
      category: "insurance",
      severity: "info",
      title: "Complete your insurance details",
      body: "Add your premium and renewal date so Automoteev can time quote requests for the cheapest switch window.",
      cta_label: "Complete insurance",
      action: { type: "open_form", form_id: "insurance" }
    });
  }
  if (!input.preferredServiceShopExists) {
    list.push({
      key: "no_preferred_shop",
      category: "service",
      severity: "info",
      title: "Pick a preferred service shop",
      body: "Automoteev will request quotes from a few options near you and remember the one you pick.",
      cta_label: "Find shops near me",
      action: { type: "open_form", form_id: "preferred_shop" }
    });
  }

  // ---- FUEL ----
  if (input.monthsSinceLastFuelEntry === null || input.monthsSinceLastFuelEntry > 1) {
    list.push({
      key: "log_fuel",
      category: "fuel",
      severity: "info",
      title: "Log this month's fuel spend",
      body: "Tracking fuel cost makes Automoteev's monthly cost number accurate and unlocks fuel-economy alerts.",
      cta_label: "Log fuel cost",
      action: { type: "open_form", form_id: "fuel" }
    });
  }

  // Always at least ONE thing
  if (list.length === 0) {
    list.push({
      key: "all_good_value_check",
      category: "general",
      severity: "info",
      title: "Refresh your vehicle's market value",
      body: "Automoteev can re-estimate market and dealer values for your vehicle.",
      cta_label: "Refresh value estimate",
      action: { type: "create_task", task_type: "value_refresh", category: "general", task_title: "Refresh value estimate" }
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
