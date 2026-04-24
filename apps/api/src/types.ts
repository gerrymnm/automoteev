export type OwnershipType = "owned" | "financed" | "leased";
export type OverallStatus = "all_good" | "action_recommended" | "action_needed";

export type AlertType =
  | "open_recall"
  | "insurance_renewal_approaching"
  | "insurance_info_missing"
  | "loan_lease_info_missing"
  | "lease_maturity_approaching"
  | "service_due_soon"
  | "high_monthly_cost_opportunity"
  | "vehicle_value_update_available"
  | "dl_missing_for_action"
  | "autonomy_unlocked";

export type TaskStatus =
  | "created"
  | "needs_user_approval"
  | "approved"
  | "in_progress"
  | "waiting_on_provider"
  | "completed"
  | "cancelled"
  | "failed";

export type TaskType =
  | "recall_check"
  | "recall_appointment"
  | "maintenance_quote"
  | "service_appointment"
  | "insurance_quote"
  | "insurance_review"
  | "refinance_review"
  | "payoff_request"
  | "lease_end_review"
  | "sell_vehicle"
  | "general_owner_request";

export type SubscriptionSource = "stripe" | "apple" | "google";
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "expired";
export type SubscriptionPlan = "pro_monthly" | "pro_annual";

export type MaintenanceStatus =
  | "upcoming"
  | "due"
  | "overdue"
  | "completed"
  | "skipped";

export type EmailDirection = "outbound" | "inbound";

export type AgreementType = "tos" | "privacy" | "autonomy_consent";

export type ObdShippingStatus =
  | "reserved"
  | "queued"
  | "shipped"
  | "delivered"
  | "returned";

export type DocumentType =
  | "loan_contract"
  | "insurance_dec"
  | "insurance_card"
  | "registration"
  | "title"
  | "photo"
  | "other";

export interface Vehicle {
  id: string;
  user_id: string;
  vin: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  mileage: number;
  ownership_type: OwnershipType;
  estimated_value_cents: number | null;
  overall_status: OverallStatus;
  next_service_due_miles: number | null;
  recall_status: string | null;
  last_obd_sync_at: string | null;
  obd_mileage: number | null;
  diagnostic_codes: string[] | null;
  battery_status: string | null;
  service_prediction: string | null;
}

export interface Profile {
  id: string;
  full_name: string;
  email: string;
  zip_code: string;
  plan: "free" | "pro";
  stripe_customer_id: string | null;
  approved_email_count: number;
  autonomy_unlocked_at: string | null;
  agent_email_local: string | null;
  agent_email_domain: string;
}

export interface CostProfileInput {
  monthly_payment_cents?: number | null;
  insurance_premium_cents?: number | null;
  maintenance_monthly_cents?: number | null;
}

export interface LoanLeaseAccount {
  id: string;
  user_id: string;
  vehicle_id: string;
  lender_name: string | null;
  apr_bps: number | null;
  balance_cents: number | null;
  monthly_payment_cents: number | null;
  lease_maturity_date: string | null;
  principal_cents: number | null;
  term_months: number | null;
  start_date: string | null;
  first_payment_date: string | null;
  rate_type: "fixed" | "variable" | null;
  encrypted_account_reference: string | null;
}

export interface InsuranceAccount {
  id: string;
  user_id: string;
  vehicle_id: string;
  carrier_name: string | null;
  premium_cents: number | null;
  renewal_date: string | null;
  coverage_type: "liability" | "full" | "comprehensive" | "unknown" | null;
  deductible_cents: number | null;
  liability_limits: string | null;
  policy_number_encrypted: string | null;
  encrypted_policy_reference: string | null;
}

export interface RecallRecord {
  id: string;
  user_id: string;
  vehicle_id: string;
  nhtsa_campaign_id: string;
  summary: string | null;
  component: string | null;
  consequence: string | null;
  remedy: string | null;
  reported_at: string | null;
  resolved_at: string | null;
}

export interface MaintenanceItem {
  id: string;
  user_id: string;
  vehicle_id: string;
  item_type: string;
  due_mileage: number | null;
  due_date: string | null;
  interval_miles: number | null;
  interval_months: number | null;
  last_performed_mileage: number | null;
  last_performed_date: string | null;
  status: MaintenanceStatus;
  estimated_cost_cents: number | null;
}

export interface AuthUser {
  id: string;
  email?: string;
}

// Fields that can be skipped at onboarding and re-prompted later.
export const TRACKED_ONBOARDING_FIELDS = [
  "monthly_payment",
  "loan_balance",
  "loan_apr",
  "loan_start_date",
  "loan_term_months",
  "insurance_premium",
  "insurance_renewal",
  "insurance_coverage",
  "phone",
  "street_address",
  "drivers_license"
] as const;

export type OnboardingField = (typeof TRACKED_ONBOARDING_FIELDS)[number];
