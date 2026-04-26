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

export type MaintenanceStatus =
  | "upcoming"
  | "due"
  | "overdue"
  | "completed"
  | "skipped";

export type InsightSeverity = "info" | "recommended" | "urgent";
export type InsightCategory =
  | "savings"
  | "safety"
  | "completeness"
  | "maintenance"
  | "action_ready"
  | "info";

export type AutonomyCategoryName =
  | "service"
  | "insurance"
  | "lending"
  | "sale"
  | "fuel"
  | "general";

export type AutonomyLevel = 1 | 2 | 3;
export type AutonomyLevelLabel = "Assisted" | "Trusted" | "Autonomous";

export interface InsightAction {
  type: "create_task" | "open_form" | "run_recall_check";
  task_type?: string;
  category?: AutonomyCategoryName;
  task_title?: string;
  approval_summary?: string;
  shared_fields?: string[];
  prefill?: Record<string, unknown>;
  form_id?: "insurance" | "loan" | "fuel" | "preferred_shop";
}

export interface Insight {
  key: string;
  category: AutonomyCategoryName;
  severity: InsightSeverity;
  title: string;
  body: string;
  cta_label: string;
  action: InsightAction;
  estimated_savings_usd_per_year?: number;
}

export interface Profile {
  id: string;
  full_name: string;
  email: string;
  zip_code: string;
  plan: "free" | "pro";
  agent_email_local: string | null;
  agent_email_domain: string | null;
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
  market_value_low_cents: number | null;
  market_value_high_cents: number | null;
  dealer_value_low_cents: number | null;
  dealer_value_high_cents: number | null;
  value_estimated_at: string | null;
  overall_status: OverallStatus;
  next_service_due_miles: number | null;
  recall_status: string | null;
}

export interface CostProfile {
  total_monthly_cost_cents: number | null;
  annual_cost_cents: number | null;
  missing_fields: string[] | null;
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
  is_preferred?: boolean;
}

export interface MaintenanceItem {
  id: string;
  item_type: string;
  due_mileage: number | null;
  due_date: string | null;
  status: MaintenanceStatus;
  estimated_cost_cents: number | null;
}

export interface RecallRecord {
  id: string;
  nhtsa_campaign_id: string;
  summary: string | null;
  component: string | null;
  consequence: string | null;
  remedy: string | null;
  reported_at: string | null;
}

export interface Valuation {
  market_value_low_cents: number;
  market_value_high_cents: number;
  dealer_value_low_cents: number;
  dealer_value_high_cents: number;
  estimated_at: string | null;
}

export interface Dashboard {
  vehicle: Vehicle;
  valuation: Valuation | null;
  cost_profile: CostProfile | null;
  loan_lease: {
    balance_cents: number | null;
    lease_maturity_date: string | null;
    apr_bps: number | null;
    monthly_payment_cents: number | null;
  } | null;
  insurance: {
    carrier_name: string | null;
    renewal_date: string | null;
    premium_cents: number | null;
  } | null;
  insights: Insight[];
  maintenance_items: MaintenanceItem[];
  open_recalls: RecallRecord[];
  recommended_action: Insight | null;
  total_estimated_annual_savings_usd: number;
}

export interface CategoryAutonomy {
  category: AutonomyCategoryName;
  level: AutonomyLevel;
  level_label: AutonomyLevelLabel;
  level_description: string;
  approved_count: number;
  threshold: number;
  unlocked_at: string | null;
  requires_approval_for_next_send: boolean;
}

export interface AutonomyStatus {
  level: AutonomyLevel;
  level_label: AutonomyLevelLabel;
  level_description: string;
  approved_email_count: number;
  threshold: number;
  autonomy_unlocked: boolean;
  autonomy_unlocked_at: string | null;
  requires_approval_for_next_send: boolean;
  categories: CategoryAutonomy[];
  agent_email: string | null;
}

export interface SubscriptionStatus {
  is_pro: boolean;
  plan: "free" | "pro";
  subscription: {
    source: "stripe" | "apple" | "google";
    status: string;
    plan: "pro_monthly" | "pro_annual";
    current_period_end: string | null;
  } | null;
}

export interface UploadedDocument {
  id: string;
  user_id: string;
  vehicle_id: string | null;
  document_kind:
    | "insurance_dec_page"
    | "loan_statement"
    | "lease_agreement"
    | "registration"
    | "recall_notice"
    | "service_record"
    | "sale_paperwork"
    | "other";
  file_name: string;
  mime_type: string;
  byte_size: number;
  extraction_status: "pending" | "processing" | "completed" | "failed";
  extracted_data: Record<string, unknown> | null;
  extraction_error: string | null;
  uploaded_at: string;
  extracted_at: string | null;
}

export interface MCPConnection {
  id: string;
  client_name: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface OnboardingPrompt {
  field_name: string;
  prompt_count: number;
  last_prompted_at: string | null;
  completed: boolean;
  dismissed: boolean;
}
