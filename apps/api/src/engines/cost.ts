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

/**
 * Amortization math. Returns monthly payment, total interest, remaining balance
 * estimate, and a monthly schedule. All dollar values in cents.
 */
export function amortize(params: {
  principalCents: number;
  aprBps: number; // e.g. 649 = 6.49% APR
  termMonths: number;
  startDate: string; // YYYY-MM-DD
  elapsedMonths?: number;
}) {
  const principal = params.principalCents;
  const r = params.aprBps / 10_000 / 12; // monthly interest
  const n = params.termMonths;

  const monthlyCents =
    r === 0
      ? Math.round(principal / n)
      : Math.round(principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1));

  let balance = principal;
  let totalInterest = 0;
  const schedule: Array<{ month: number; principal_cents: number; interest_cents: number; balance_cents: number }> = [];

  for (let m = 1; m <= n; m++) {
    const interest = Math.round(balance * r);
    const principalPaid = monthlyCents - interest;
    balance = Math.max(0, balance - principalPaid);
    totalInterest += interest;
    schedule.push({ month: m, principal_cents: principalPaid, interest_cents: interest, balance_cents: balance });
  }

  const elapsed = params.elapsedMonths ?? computeElapsedMonths(params.startDate);
  const estimatedBalance = elapsed >= n ? 0 : schedule[Math.max(0, elapsed - 1)]?.balance_cents ?? principal;

  return {
    monthly_payment_cents: monthlyCents,
    total_interest_cents: totalInterest,
    total_paid_cents: monthlyCents * n,
    estimated_balance_cents: estimatedBalance,
    elapsed_months: elapsed,
    schedule
  };
}

function computeElapsedMonths(startDate: string): number {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const now = new Date();
  const years = now.getUTCFullYear() - start.getUTCFullYear();
  const months = now.getUTCMonth() - start.getUTCMonth();
  return Math.max(0, years * 12 + months);
}
