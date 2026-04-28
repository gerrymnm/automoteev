import { supabaseAdmin } from "../supabase.js";

/**
 * Renewables service — generic tracker for things that need renewal.
 *
 * The product spans DL, insurance, vehicle registration, warranties (basic /
 * powertrain / extended), prepaid maintenance, gap insurance, tire protection,
 * roadside assistance, AAA / memberships, subscriptions, etc. One generic
 * `renewable_items` table holds them all so adding a new category doesn't
 * require a schema migration.
 *
 * This module exposes:
 *   - the type definitions and per-kind defaults
 *   - upsertRenewalFromDLExtraction (the auto-create hook fired when a user
 *     applies a DL document and the extraction picked up an expiration date)
 *   - listRenewalsForUser (the read path that powers the renewals panel)
 *   - dismissRenewal (snooze for "Not now")
 *
 * The CRUD endpoints in routes.ts call these helpers; routes don't talk
 * to the table directly except through the per-user RLS-scoped client for
 * ownership checks. Anything that uses supabaseAdmin lives here so the
 * security boundary is clear.
 */

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

const ALL_KINDS: readonly RenewableKind[] = [
  "drivers_license",
  "insurance_policy",
  "vehicle_registration",
  "vehicle_warranty_basic",
  "vehicle_warranty_powertrain",
  "extended_warranty",
  "prepaid_maintenance",
  "gap_insurance",
  "tire_protection",
  "roadside_assistance",
  "aaa_membership",
  "membership",
  "subscription",
  "other"
];

export function isRenewableKind(value: unknown): value is RenewableKind {
  return typeof value === "string" && (ALL_KINDS as readonly string[]).includes(value);
}

/**
 * Default reminder lead-time per category. DL needs ~60 days because some
 * states require an in-person visit and the appointment slots fill up;
 * insurance shopping needs 45+ days to actually quote and switch carriers;
 * subscriptions only need a 7-day heads-up before they auto-renew.
 */
export function defaultReminderDays(kind: RenewableKind): number {
  switch (kind) {
    case "drivers_license":
      return 60;
    case "insurance_policy":
      return 45;
    case "vehicle_registration":
      return 30;
    case "subscription":
      return 7;
    case "membership":
    case "aaa_membership":
      return 14;
    default:
      return 30;
  }
}

/**
 * Default label per kind — used when a row is auto-created from an
 * extraction and the user hasn't customized it. The user can override this
 * via PATCH at any time.
 */
export function defaultLabel(kind: RenewableKind): string {
  switch (kind) {
    case "drivers_license":
      return "Driver's License";
    case "insurance_policy":
      return "Insurance Policy";
    case "vehicle_registration":
      return "Vehicle Registration";
    case "vehicle_warranty_basic":
      return "Bumper-to-bumper warranty";
    case "vehicle_warranty_powertrain":
      return "Powertrain warranty";
    case "extended_warranty":
      return "Extended warranty";
    case "prepaid_maintenance":
      return "Prepaid maintenance";
    case "gap_insurance":
      return "Gap insurance";
    case "tire_protection":
      return "Tire protection";
    case "roadside_assistance":
      return "Roadside assistance";
    case "aaa_membership":
      return "AAA membership";
    case "membership":
      return "Membership";
    case "subscription":
      return "Subscription";
    default:
      return "Renewal";
  }
}

/**
 * Upsert a renewable item from a DL document extraction. Idempotent on
 * source_document_id — re-applying the same DL won't create duplicates,
 * it'll just refresh the expiration date and provider_name.
 *
 * Returns the row (existing or newly created), or null if expiration_date
 * couldn't be parsed (partial OCR failure, photo of the wrong side of the
 * card, etc). This is intentionally fire-and-forget from the caller's
 * perspective — DL apply still succeeds even if renewal upsert fails,
 * because the dl_number being on file is the more important outcome.
 */
export async function upsertRenewalFromDLExtraction(params: {
  userId: string;
  documentId: string;
  expirationDate: unknown;
  dlState: unknown;
}): Promise<RenewableItem | null> {
  // Validate ISO YYYY-MM-DD format. The extraction prompt asks for it but
  // we can't trust the model to always comply — bail gracefully on garbage.
  if (typeof params.expirationDate !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.expirationDate)) return null;

  const dlState =
    typeof params.dlState === "string" && params.dlState.trim().length > 0
      ? params.dlState.trim().toUpperCase()
      : null;
  const provider_name = dlState ? `${dlState} DMV` : "DMV";

  // Idempotency via source_document_id. If a row already exists for this
  // document, update it rather than insert a second one. This handles the
  // user re-apply flow where they tap "Apply to my profile" multiple times.
  const { data: existing } = await supabaseAdmin
    .from("renewable_items")
    .select("*")
    .eq("user_id", params.userId)
    .eq("source_document_id", params.documentId)
    .maybeSingle();

  if (existing) {
    const { data: updated } = await supabaseAdmin
      .from("renewable_items")
      .update({
        expires_at: params.expirationDate,
        provider_name
      })
      .eq("id", (existing as any).id)
      .select()
      .single();
    return (updated as RenewableItem) ?? null;
  }

  const { data: created } = await supabaseAdmin
    .from("renewable_items")
    .insert({
      user_id: params.userId,
      vehicle_id: null, // DL is user-scoped, not vehicle-scoped
      kind: "drivers_license",
      label: defaultLabel("drivers_license"),
      provider_name,
      expires_at: params.expirationDate,
      auto_renews: false,
      reminder_days_before: defaultReminderDays("drivers_license"),
      source_document_id: params.documentId
    })
    .select()
    .single();

  return (created as RenewableItem) ?? null;
}

/**
 * Compute the derived status fields (days_until_expiration / is_dismissed /
 * is_expired / is_due_soon) for a row. Pure function — no DB access — so
 * the caller can decorate rows fetched via either supabaseAdmin or req.db.
 */
export function decorateRenewable(item: RenewableItem): RenewableItemWithStatus {
  let daysUntil: number | null = null;
  let isExpired = false;
  let isDueSoon = false;

  if (item.expires_at) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expires = new Date(item.expires_at);
    expires.setHours(0, 0, 0, 0);
    const msPerDay = 86_400_000;
    daysUntil = Math.round((expires.getTime() - today.getTime()) / msPerDay);
    isExpired = daysUntil < 0;
    isDueSoon = daysUntil >= 0 && daysUntil <= item.reminder_days_before;
  }

  const isDismissed =
    item.dismissed_until !== null && new Date(item.dismissed_until) > new Date();

  return {
    ...item,
    days_until_expiration: daysUntil,
    is_dismissed: isDismissed,
    is_expired: isExpired,
    is_due_soon: isDueSoon
  };
}

/**
 * Read all renewables for a user, decorated with computed status. Filters:
 *   vehicleId       — optional, restrict to a specific vehicle (still includes
 *                     user-scoped items like DL since those are valid for any
 *                     vehicle context).
 *   includeDismissed— default false, hide snoozed items.
 *   includeExpired  — default true, show expired items so the user knows
 *                     what's lapsed.
 *
 * Sort: expires_at ASC (closest expiration first). Items with no expires_at
 * (mileage-based only) sort to the end.
 */
export async function listRenewalsForUser(params: {
  userId: string;
  vehicleId?: string | null;
  includeDismissed?: boolean;
  includeExpired?: boolean;
}): Promise<RenewableItemWithStatus[]> {
  const includeDismissed = params.includeDismissed ?? false;
  const includeExpired = params.includeExpired ?? true;

  let query = supabaseAdmin
    .from("renewable_items")
    .select("*")
    .eq("user_id", params.userId);

  // When a vehicle filter is supplied, include both rows tied to that
  // vehicle AND user-scoped rows (vehicle_id IS NULL like DL/membership)
  // because those still apply when the user is looking at any vehicle.
  if (params.vehicleId) {
    query = query.or(`vehicle_id.eq.${params.vehicleId},vehicle_id.is.null`);
  }

  const { data, error } = await query.order("expires_at", {
    ascending: true,
    nullsFirst: false
  });
  if (error) {
    console.error("[renewals] list query failed", error);
    return [];
  }

  const decorated = (data ?? []).map((row) =>
    decorateRenewable(row as RenewableItem)
  );

  return decorated.filter((item) => {
    if (!includeDismissed && item.is_dismissed) return false;
    if (!includeExpired && item.is_expired) return false;
    return true;
  });
}

/**
 * Soft-snooze a renewable item. Mirrors the dismissed_insights pattern:
 * writes dismissed_until = now() + ttlDays. The list query filters out
 * items whose dismissed_until is still in the future when
 * includeDismissed=false.
 *
 * Idempotent — re-dismissing extends the snooze.
 */
export async function dismissRenewal(params: {
  userId: string;
  itemId: string;
  ttlDays?: number;
}): Promise<{ ok: boolean; dismissed_until: string }> {
  const ttl = params.ttlDays ?? 7;
  const dismissedUntil = new Date(Date.now() + ttl * 86_400_000).toISOString();
  const { error } = await supabaseAdmin
    .from("renewable_items")
    .update({ dismissed_until: dismissedUntil })
    .eq("user_id", params.userId)
    .eq("id", params.itemId);
  return { ok: !error, dismissed_until: dismissedUntil };
}
