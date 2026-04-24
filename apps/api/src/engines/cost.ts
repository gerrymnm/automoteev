import type { CostProfileInput } from "../types.js";

export function calculateCosts(input: CostProfileInput) {
  const monthlyPaymentCents = input.monthly_payment_cents ?? 0;
  const insuranceCents = input.insurance_premium_cents ?? 0;
  const maintenanceCents = input.maintenance_monthly_cents ?? 8500;
  const missing: string[] = [];

  if (input.monthly_payment_cents == null) missing.push("monthly_payment");
  if (input.insurance_premium_cents == null) missing.push("insurance_premium");

  const totalMonthlyCents = monthlyPaymentCents + insuranceCents + maintenanceCents;

  return {
    monthly_payment_cents: input.monthly_payment_cents ?? null,
    insurance_premium_cents: input.insurance_premium_cents ?? null,
    maintenance_monthly_cents: maintenanceCents,
    total_monthly_cost_cents: totalMonthlyCents,
    annual_cost_cents: totalMonthlyCents * 12,
    missing_fields: missing
  };
}
