import { z } from "zod";

// 17-char VIN, no I/O/Q
const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/i;
export const vinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(vinRegex, "VIN must be 17 characters (A-Z 0-9, excluding I, O, Q)");

export const profileSchema = z.object({
  full_name: z.string().min(1),
  email: z.string().email(),
  zip_code: z.string().min(5).max(10)
});

export const onboardingSchema = profileSchema.extend({
  vin: vinSchema,
  mileage: z.coerce.number().int().nonnegative(),
  ownership_type: z.enum(["owned", "financed", "leased"]),

  // Loan / lease (all optional — skipped fields nudge later)
  monthly_payment_cents: z.coerce.number().int().nonnegative().optional().nullable(),
  apr_bps: z.coerce.number().int().nonnegative().optional().nullable(),
  lender_name: z.string().optional().nullable(),
  loan_lease_balance_cents: z.coerce.number().int().nonnegative().optional().nullable(),
  principal_cents: z.coerce.number().int().nonnegative().optional().nullable(),
  term_months: z.coerce.number().int().positive().optional().nullable(),
  loan_start_date: z.string().optional().nullable(),
  first_payment_date: z.string().optional().nullable(),
  rate_type: z.enum(["fixed", "variable"]).optional().nullable(),
  lease_maturity_date: z.string().optional().nullable(),

  // Insurance (all optional — skipped fields nudge later)
  insurance_carrier: z.string().optional().nullable(),
  insurance_premium_cents: z.coerce.number().int().nonnegative().optional().nullable(),
  insurance_renewal_date: z.string().optional().nullable(),
  insurance_coverage_type: z.enum(["liability", "full", "comprehensive", "unknown"]).optional().nullable(),
  insurance_deductible_cents: z.coerce.number().int().nonnegative().optional().nullable(),
  insurance_liability_limits: z.string().optional().nullable(),
  insurance_policy_number: z.string().optional().nullable(),

  // OBD + consent toggles
  reserve_obd: z.boolean().optional().default(true),
  accepted_tos: z.boolean(),
  accepted_privacy: z.boolean(),
  accepted_autonomy_consent: z.boolean()
});

export const loanLeaseUpdateSchema = z.object({
  lender_name: z.string().nullable().optional(),
  apr_bps: z.number().int().nullable().optional(),
  balance_cents: z.number().int().nullable().optional(),
  monthly_payment_cents: z.number().int().nullable().optional(),
  principal_cents: z.number().int().nullable().optional(),
  term_months: z.number().int().positive().nullable().optional(),
  start_date: z.string().nullable().optional(),
  first_payment_date: z.string().nullable().optional(),
  rate_type: z.enum(["fixed", "variable"]).nullable().optional(),
  lease_maturity_date: z.string().nullable().optional()
});

export const insuranceUpdateSchema = z.object({
  carrier_name: z.string().nullable().optional(),
  premium_cents: z.number().int().nullable().optional(),
  renewal_date: z.string().nullable().optional(),
  coverage_type: z.enum(["liability", "full", "comprehensive", "unknown"]).nullable().optional(),
  deductible_cents: z.number().int().nullable().optional(),
  liability_limits: z.string().nullable().optional(),
  policy_number: z.string().nullable().optional()
});

export const piiUpdateSchema = z.object({
  phone: z.string().nullable().optional(),
  street_address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().length(2).nullable().optional(),
  dl_number: z.string().nullable().optional(),
  dl_state: z.string().length(2).nullable().optional()
});

export const taskCommandSchema = z.object({
  vehicle_id: z.string().uuid(),
  command: z.string().min(2).max(500)
});

export const taskCreateSchema = z.object({
  vehicle_id: z.string().uuid(),
  task_type: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional().nullable()
});

export const providerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  provider_type: z.string().min(1),
  location: z.string().optional().nullable()
});

export const approvalSchema = z.object({
  approved: z.boolean(),
  provider_id: z.string().uuid().optional().nullable()
});

export const emailSendSchema = z.object({
  provider_id: z.string().uuid(),
  notes: z.string().optional().nullable()
});

export const providerSearchSchema = z.object({
  provider_type: z.string().min(1),
  zip_code: z.string().min(5).max(10).optional().nullable(),
  radius_miles: z.coerce.number().int().positive().max(50).default(15)
});

export const onboardingPromptDismissSchema = z.object({
  field_name: z.string().min(1)
});
