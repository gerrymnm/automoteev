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
  | "vehicle_value_update_available";

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

export interface CostProfileInput {
  monthly_payment_cents?: number | null;
  insurance_premium_cents?: number | null;
  maintenance_monthly_cents?: number | null;
}

export interface AuthUser {
  id: string;
  email?: string;
}
