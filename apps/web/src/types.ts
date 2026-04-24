export type OverallStatus = "all_good" | "action_recommended" | "action_needed";
export type TaskStatus =
  | "created"
  | "needs_user_approval"
  | "approved"
  | "in_progress"
  | "waiting_on_provider"
  | "completed"
  | "cancelled"
  | "failed";

export interface Profile {
  id: string;
  full_name: string;
  email: string;
  zip_code: string;
  plan: "free" | "pro";
}

export interface Vehicle {
  id: string;
  vin: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  mileage: number;
  ownership_type: "owned" | "financed" | "leased";
  estimated_value_cents: number | null;
  overall_status: OverallStatus;
  next_service_due_miles: number | null;
  recall_status: string | null;
}

export interface CostProfile {
  total_monthly_cost_cents: number | null;
  annual_cost_cents: number | null;
  missing_fields: string[] | null;
}

export interface Alert {
  id: string;
  title: string;
  body: string;
  severity: "info" | "recommended" | "urgent";
  alert_type: string;
}

export interface Task {
  id: string;
  vehicle_id: string;
  task_type: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  approval_summary: string | null;
  external_contacts: string[] | null;
  shared_fields: string[] | null;
  created_at: string;
}

export interface Provider {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  provider_type: string;
  location: string | null;
}

export interface Dashboard {
  vehicle: Vehicle;
  cost_profile: CostProfile | null;
  loan_lease: { balance_cents: number | null; lease_maturity_date: string | null } | null;
  insurance: { carrier_name: string | null; renewal_date: string | null; premium_cents: number | null } | null;
  alerts: Alert[];
  recommended_action: Alert | null;
}
