import { z } from "zod";

export const profileSchema = z.object({
  full_name: z.string().min(1),
  email: z.string().email(),
  zip_code: z.string().min(5).max(10)
});

export const onboardingSchema = profileSchema.extend({
  vin: z.string().min(11).max(17),
  mileage: z.coerce.number().int().nonnegative(),
  ownership_type: z.enum(["owned", "financed", "leased"]),
  monthly_payment_cents: z.coerce.number().int().nonnegative().optional().nullable(),
  apr_bps: z.coerce.number().int().nonnegative().optional().nullable(),
  lender_name: z.string().optional().nullable(),
  loan_lease_balance_cents: z.coerce.number().int().nonnegative().optional().nullable(),
  lease_maturity_date: z.string().optional().nullable(),
  insurance_carrier: z.string().optional().nullable(),
  insurance_premium_cents: z.coerce.number().int().nonnegative().optional().nullable(),
  insurance_renewal_date: z.string().optional().nullable()
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
