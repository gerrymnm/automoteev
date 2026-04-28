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

export interface DispatchProvider extends Provider {
  /** "verified" = email scraped from dealer's site; "none" = no email available */
  derived_email_basis?: "verified" | "none";
  rating?: number | null;
  rating_count?: number | null;
  website?: string | null;
  /** Distance from user's ZIP, in miles. Null if user ZIP isn't geocodable. */
  distance_miles?: number | null;
  /** True when this provider is the user's CURRENT lender / insurer / etc.
   * Surfaces a banner in the dispatch modal explaining why they're shown
   * and prompting for an existing contact rather than blasting cold. */
  is_current_provider?: boolean;
  /** Human-readable explanation paired with is_current_provider. */
  current_provider_note?: string | null;
  verified_by_community?: boolean;
  community_contact_email?: string | null;
  community_success_count?: number | null;
}

/**
 * Lightweight metadata for a document the agent plans to attach to the
 * outbound provider email. Surfaced to the dispatch modal so the user sees
 * what's being sent before tapping Send. Bytes are NOT included here —
 * they're resolved server-side at send time.
 */
export interface PlannedAttachment {
  document_id: string;
  filename: string;
  document_kind:
    | "insurance_dec_page"
    | "loan_statement"
    | "lease_agreement"
    | "registration"
    | "recall_notice"
    | "service_record"
    | "sale_paperwork"
    | "drivers_license"
    | "other";
  category: DocumentCategory;
  byte_size: number;
}

export interface DispatchPayload {
  task: Task;
  providers: DispatchProvider[];
  preferred_provider_id: string | null;
  email_preview: { subject: string; body: string };
  /**
   * Documents that will be attached to the outbound email — dec page on
   * insurance, loan statement on refinance, registration on sale outreach.
   * Empty array when the task type doesn't take attachments or when the
   * user hasn't uploaded the relevant docs yet.
   */
  planned_attachments: PlannedAttachment[];
  already_existed?: boolean;
  /** True if a DL must be collected before this task can dispatch (insurance only). */
  requires_dl?: boolean;
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

export type DocumentCategory =
  | "insurance"
  | "loan"
  | "registration"
  | "recall"
  | "service"
  | "sale"
  | "identity"
  | "other";

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
    | "drivers_license"
    | "other";
  category: DocumentCategory | null;
  storage_path?: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  extraction_status: "pending" | "processing" | "completed" | "failed";
  extracted_data: Record<string, unknown> | null;
  extraction_error: string | null;
  uploaded_at: string;
  extracted_at: string | null;
}

export interface VehicleDocumentsResponse {
  documents: UploadedDocument[];
  by_category: Record<DocumentCategory, UploadedDocument[]> | null;
  counts: Record<DocumentCategory, number> | null;
  total: number;
}

// ============================================================================
// Renewables (DL, insurance, warranties, memberships, subscriptions, etc.)
// ============================================================================

export type RenewableKind =
  | "drivers_license"
  | "insurance_policy"
  | "vehicle_registration"
  | "vehicle_warranty_basic"
  | "vehicle_warranty_powertrain"
  | "extended_warranty"
  | "prepaid_maintenance"
  | "gap_insurance"
  | "tire_protection"
  | "roadside_assistance"
  | "aaa_membership"
  | "membership"
  | "subscription"
  | "other";

export type CostPeriod = "one_time" | "monthly" | "annual" | "biennial";

export interface RenewableItem {
  id: string;
  user_id: string;
  vehicle_id: string | null;
  kind: RenewableKind;
  label: string;
  provider_name: string | null;
  policy_number_encrypted: string | null;
  expires_at: string | null;
  expires_at_mileage: number | null;
  auto_renews: boolean;
  cost_cents: number | null;
  cost_period: CostPeriod | null;
  reminder_days_before: number;
  dismissed_until: string | null;
  source_document_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface RenewableItemWithStatus extends RenewableItem {
  /** Negative when the item has already expired. Null when only mileage-based. */
  days_until_expiration: number | null;
  /** True when dismissed_until is in the future (snoozed). */
  is_dismissed: boolean;
  /** True when expires_at < today. Mileage-based items don't trigger this flag. */
  is_expired: boolean;
  /** True when within reminder_days_before of expiration. */
  is_due_soon: boolean;
}

export interface RenewalsListResponse {
  items: RenewableItemWithStatus[];
  total: number;
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

// ============================================================================
// Home (the redesigned landing screen)
// ============================================================================

export type PendingActionKind =
  | "decision"
  | "signature"
  | "info_request"
  | "confirm_close"
  | "review_quotes"
  | "approval"
  | "manual"
  | "renewal";

export interface PendingActionOption {
  id: string;
  label: string;
  style?: "primary" | "secondary" | "ghost" | "danger";
  /** Optional href for option-style links (e.g. "View PDF"). */
  href?: string;
}

/**
 * Action a renewal card's CTA button takes when tapped. Three flavors today:
 *   shop_replacement — dispatch flow for insurance_quote (only insurance has
 *                       a real shop-replacement pipeline)
 *   open_external    — navigate the user to a URL (DMV for DL/registration
 *                       since the agent can't legally renew those)
 *   edit_renewal     — open the RenewalFormModal (default for warranties /
 *                       memberships / subscriptions)
 */
export type RenewalCtaAction =
  | { type: "shop_replacement"; task_type: "insurance_quote" }
  | { type: "open_external"; url: string; label: string }
  | { type: "edit_renewal" };

export interface PendingAction {
  task_id: string | null;
  vehicle_id: string;
  kind: PendingActionKind;
  title: string;
  body: string | null;
  options: PendingActionOption[] | null;
  set_at: string | null;
  category: string | null;
  task_type: string | null;
  /** True if this card was synthesized from an insight (no real task yet). */
  synthetic?: boolean;
  insight_key?: string;
  cta_label?: string;
  // ---- Renewal cards only (kind === "renewal") ----
  /** The renewable_items.id this card is anchored to. */
  renewable_item_id?: string;
  /** What action the CTA should perform. */
  cta_action?: RenewalCtaAction;
  /** True when expires_at < today. Drives red badge on the card. */
  is_expired?: boolean;
  /** Negative if expired, null if mileage-only. */
  days_until_expiration?: number | null;
}

export interface AgentWorkingItem {
  task_id: string;
  title: string;
  task_type: string;
  status: TaskStatus;
  status_text: string;
  icon_kind: string;
}

export interface HomeSummary {
  vehicle: {
    id: string;
    year: number | null;
    make: string | null;
    model: string | null;
    vin: string;
    mileage: number;
  };
  monthly_cost_cents: number | null;
  savings_captured_usd_per_year: number;
  savings_on_the_table_usd_per_year: number;
}

export interface HomeResponse {
  pending_actions: PendingAction[];
  agent_working: AgentWorkingItem[];
  secondary_recommendations: Insight[];
  summary: HomeSummary | null;
}

// ============================================================================
// Per-thread timeline
// ============================================================================

export type ThreadItemKind =
  | "email_out"
  | "email_in"
  | "agent_classification"
  | "agent_decision"
  | "agent_action"
  | "state_transition"
  | "document_attached"
  | "user_decision"
  | "user_note"
  | "system";

export interface ThreadEmailData {
  id: string;
  direction: "outbound" | "inbound";
  to_email: string;
  from_email: string;
  subject: string;
  body_text: string;
  status: string;
  created_at: string;
}

export interface ThreadEventData {
  id: string;
  kind: string;
  summary: string;
  detail: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface ThreadItem {
  kind: ThreadItemKind;
  at: string;
  data: ThreadEmailData | ThreadEventData;
}

export interface ThreadResponse {
  task: Task;
  items: ThreadItem[];
}
