import { supabaseAdmin } from "../supabase.js";

/**
 * Plaid transaction classifier.
 *
 * Scans a batch of transactions and decides whether each one is
 * vehicle-relevant. Rule-based (no LLM call) because most signals are
 * unambiguous from the merchant name + Plaid category alone, and we want
 * this to run automatically after every sync without rate-limit anxiety.
 *
 * Classes emitted today:
 *   fuel           — gas station purchase
 *   insurance      — auto insurance carrier ACH/charge
 *   lender         — auto loan or lease payment
 *   service        — dealer service department, repair shop, oil change,
 *                    tire shop charge
 *   parts          — auto parts retailer
 *   registration   — DMV / state agency fee
 *   parking_toll   — parking garage, FasTrak, EZ-Pass
 *   subscription   — recurring vehicle-related subscription (SiriusXM,
 *                    OnStar, FordPass+, BMW ConnectedDrive, Tesla Premium
 *                    Connectivity, etc.)
 *
 * Confidence scale:
 *   1.0   exact merchant match (whitelist hit)
 *   0.85  Plaid PFC category match (Plaid's own taxonomy)
 *   0.7   merchant name contains a known token
 *   0.5   name field contains a known token (merchant_name missing)
 *
 * The classifier writes upserts keyed on (plaid_transaction_id, class) so
 * re-running it on the same transactions is safe — the row simply updates
 * its confidence/reason/metadata.
 *
 * Confirmed/dismissed rows are NOT touched on re-classification (we don't
 * want a user's "Yes log this as fuel" to flip back to pending). The
 * upsert uses ON CONFLICT DO UPDATE only on the fields that should evolve.
 */

export type TransactionClass =
  | "fuel"
  | "insurance"
  | "lender"
  | "service"
  | "parts"
  | "registration"
  | "parking_toll"
  | "subscription";

interface ClassifierInput {
  id: string; // plaid_transactions.id (uuid)
  user_id: string;
  name: string;
  merchant_name: string | null;
  amount_cents: number;
  category: string[] | null; // legacy Plaid category hierarchy
  date: string; // YYYY-MM-DD
  pending: boolean;
}

interface ClassifierContext {
  /** Most recently created vehicle, used as the default vehicle for fuel/service.
   *  Pulled once per run, not per transaction, to avoid N+1. */
  defaultVehicleId: string | null;
  /** User's known insurance carriers for boost-matching. Lowercased. */
  insuranceCarriers: string[];
  /** User's known lenders for boost-matching. Lowercased. */
  lenderNames: string[];
  /** Existing classifications keyed by `${txn_id}:${class}`. Lets us preserve
   *  user-confirmed / user-dismissed rows on re-classification. */
  existing: Map<string, { id: string; confirmed_at: string | null; dismissed_at: string | null }>;
  /** Map from raw plaid_transaction_id text to our uuid — needed because the
   *  classifier accepts our internal id directly. (No remapping needed.) */
}

interface ClassifierResult {
  class: TransactionClass;
  confidence: number;
  reason: string;
  is_recurring?: boolean;
  matched_provider_name?: string | null;
}

// ---- Token tables -----------------------------------------------------------
// All tokens lowercased for case-insensitive substring matching.

const FUEL_MERCHANTS: ReadonlySet<string> = new Set([
  "shell", "chevron", "exxon", "exxonmobil", "mobil", "bp", "arco", "76",
  "valero", "marathon", "speedway", "circle k", "wawa", "sheetz", "loves",
  "love's", "pilot", "flying j", "ta travel", "sunoco", "phillips 66",
  "conoco", "citgo", "sinclair", "buc-ee's", "buc-ees", "qt", "quiktrip",
  "racetrac", "kwik trip", "kwik star", "casey's", "caseys", "holiday",
  "maverik", "kum & go", "kum and go", "minit mart", "go mart",
  "gulf oil", "irving oil", "stewart's", "wawa fuel",
  // EV / hybrid charging — same class for now; a separate ev_charging class
  // will land when we want different prompts (kWh logging vs gallons logging).
  "tesla supercharger", "supercharger", "electrify america", "evgo", "chargepoint",
  "blink charging"
]);

const INSURANCE_CARRIERS: ReadonlySet<string> = new Set([
  "geico", "state farm", "progressive", "allstate", "liberty mutual", "usaa",
  "farmers insurance", "nationwide insurance", "travelers", "american family",
  "amfam", "auto-owners", "auto owners", "the hartford", "hartford insurance",
  "mercury insurance", "esurance", "metromile", "root insurance",
  "lemonade insurance", "amica", "erie insurance", "safeco", "national general",
  "aaa insurance", "csaa insurance", "interinsurance exchange",
  "kemper", "infinity insurance", "direct auto", "national general insurance",
  "country financial", "encompass insurance", "plymouth rock"
]);

// Common auto lenders. Bank names without "auto" suffix won't match here —
// the user's known lender_name in context provides the boost for those.
const AUTO_LENDERS: ReadonlySet<string> = new Set([
  "ford credit", "ford motor credit", "toyota financial", "toyota motor credit",
  "honda financial", "american honda finance", "gm financial", "gmac",
  "ally auto", "ally financial", "ally bank auto",
  "chrysler capital", "stellantis financial",
  "nissan motor acceptance", "nissan financial",
  "hyundai motor finance", "kia motors finance",
  "subaru motors finance", "mazda financial",
  "bmw financial services", "mercedes-benz financial", "mb financial",
  "audi financial services", "vw credit", "volkswagen credit",
  "porsche financial services", "jaguar financial",
  "land rover financial", "lr financial",
  "lexus financial",
  "carmax auto finance", "santander auto", "santander consumer", "drive financial",
  "westlake financial", "credit acceptance", "world omni financial",
  "navy federal auto", "penfed auto", "lightstream", "myautoloan"
]);

const SERVICE_MERCHANTS: ReadonlySet<string> = new Set([
  "jiffy lube", "valvoline", "valvoline instant oil", "midas", "meineke",
  "firestone", "pep boys", "monro auto service", "monro muffler",
  "goodyear auto service", "discount tire", "tires plus", "big o tires",
  "ntb", "mavis tire", "mr. tire", "mr tire",
  "aamco", "cottman transmission", "mac haik",
  "les schwab", "express oil change", "take 5 oil change",
  "caliber collision", "service king", "gerber collision",
  "maaco", "earl scheib"
]);

const PARTS_MERCHANTS: ReadonlySet<string> = new Set([
  "autozone", "advance auto parts", "advance auto", "o'reilly auto parts",
  "o'reilly", "oreilly", "napa auto parts", "napa", "pep boys parts",
  "carquest", "rockauto", "rock auto", "summit racing",
  "4 wheel parts", "tire rack", "tirerack"
]);

const REGISTRATION_MERCHANTS: ReadonlySet<string> = new Set([
  "dmv", "department of motor vehicles",
  "secretary of state", "sos vehicle",
  "tax collector", "county tax",
  "registry of motor vehicles", "rmv"
]);

const PARKING_TOLL_MERCHANTS: ReadonlySet<string> = new Set([
  "fastrak", "fas trak", "e-zpass", "ezpass", "ez pass", "sunpass",
  "i-pass", "k-tag", "tollroadsny", "metropasstoll", "expresslanes",
  "spothero", "parkmobile", "passport parking", "premium parking",
  "abm parking", "laz parking",
  "lax parking", "sfo parking", "sjc parking", "oak parking",
  "ohare parking", "jfk parking",
  "garage downtown", "city parking authority"
]);

const VEHICLE_SUBSCRIPTIONS: ReadonlySet<string> = new Set([
  "siriusxm", "sirius xm", "sirius radio", "xm radio", "onstar",
  "fordpass", "ford pass", "bmw connecteddrive", "mercedes me connect",
  "audi connect", "porsche connect", "lexus enform", "toyota connected",
  "honda connect", "hyundai bluelink", "kia connect", "subaru starlink",
  "tesla premium connectivity", "tesla connect", "nissanconnect",
  "infiniti connection",
  "carfax", "kbb instant cash", "edmunds membership",
  "aaa membership", "aaa annual", "aaa club",
  "good sam", "auto club"
]);

// Plaid Personal Finance Category fallback (when merchant tokens don't match).
// Format from Plaid: "TRANSPORTATION_GAS" etc. We sniff substrings rather than
// hard-coding all 100+ codes because Plaid evolves the taxonomy.
function classifyByPlaidCategory(
  cat: string[] | null
): { class: TransactionClass; reason: string } | null {
  if (!cat || cat.length === 0) return null;
  const joined = cat.join(" ").toLowerCase();

  // Plaid PFC codes use _ in the underlying constants but the human strings
  // are dot-separated arrays like ["Transportation", "Gas Stations"].
  if (/gas station|fuel/i.test(joined)) {
    return { class: "fuel", reason: `Plaid category: ${cat.join(" › ")}` };
  }
  if (/auto.*insurance|insurance.*auto|vehicle insurance/i.test(joined)) {
    return { class: "insurance", reason: `Plaid category: ${cat.join(" › ")}` };
  }
  if (/auto loan|car loan|vehicle loan|auto payment/i.test(joined)) {
    return { class: "lender", reason: `Plaid category: ${cat.join(" › ")}` };
  }
  if (/auto repair|car service|automotive|car maintenance/i.test(joined)) {
    return { class: "service", reason: `Plaid category: ${cat.join(" › ")}` };
  }
  if (/auto parts/i.test(joined)) {
    return { class: "parts", reason: `Plaid category: ${cat.join(" › ")}` };
  }
  if (/parking|toll/i.test(joined)) {
    return { class: "parking_toll", reason: `Plaid category: ${cat.join(" › ")}` };
  }
  return null;
}

/**
 * Classify a single transaction. Returns null if no class applies.
 *
 * Strategy:
 *   1. Try the user-context boosts first (their actual carrier / lender).
 *      Confidence 1.0 on hit because we KNOW it's their provider.
 *   2. Exact merchant whitelist match -> confidence 1.0.
 *   3. Substring token match on merchant_name -> confidence 0.7.
 *   4. Plaid category fallback -> confidence 0.85.
 *   5. Substring token match on name (when merchant_name is null) -> 0.5.
 */
function classifyTransaction(
  txn: ClassifierInput,
  ctx: ClassifierContext
): ClassifierResult | null {
  // Skip pending charges — they may evaporate / re-post under a different
  // merchant when the bank finalizes. We'll classify on the post.
  if (txn.pending) return null;

  // Skip incoming credits (negative amounts in Plaid = money in).
  if (txn.amount_cents <= 0) return null;

  const merchantLower = (txn.merchant_name ?? "").toLowerCase();
  const nameLower = txn.name.toLowerCase();

  // --- 1. User-context boost: their carrier ---
  for (const carrier of ctx.insuranceCarriers) {
    if (!carrier) continue;
    if (merchantLower.includes(carrier) || nameLower.includes(carrier)) {
      return {
        class: "insurance",
        confidence: 1.0,
        reason: `Matches your insurance carrier on file ("${carrier}")`,
        matched_provider_name: carrier
      };
    }
  }

  // --- 1b. User-context boost: their lender ---
  for (const lender of ctx.lenderNames) {
    if (!lender) continue;
    if (merchantLower.includes(lender) || nameLower.includes(lender)) {
      return {
        class: "lender",
        confidence: 1.0,
        reason: `Matches your lender on file ("${lender}")`,
        matched_provider_name: lender
      };
    }
  }

  // --- 2. Exact merchant whitelist ---
  const exactCheck = (
    set: ReadonlySet<string>,
    klass: TransactionClass,
    reasonPrefix: string,
    isRecurring = false
  ) => {
    for (const token of set) {
      if (merchantLower === token) {
        return {
          class: klass,
          confidence: 1.0,
          reason: `${reasonPrefix}: "${token}"`,
          matched_provider_name: token,
          is_recurring: isRecurring
        };
      }
    }
    return null;
  };

  const exactHit =
    exactCheck(FUEL_MERCHANTS, "fuel", "Fuel merchant") ??
    exactCheck(INSURANCE_CARRIERS, "insurance", "Insurance carrier") ??
    exactCheck(AUTO_LENDERS, "lender", "Auto lender") ??
    exactCheck(SERVICE_MERCHANTS, "service", "Service / repair shop") ??
    exactCheck(PARTS_MERCHANTS, "parts", "Auto parts retailer") ??
    exactCheck(REGISTRATION_MERCHANTS, "registration", "DMV / registration") ??
    exactCheck(PARKING_TOLL_MERCHANTS, "parking_toll", "Parking / toll") ??
    exactCheck(VEHICLE_SUBSCRIPTIONS, "subscription", "Vehicle subscription", true);
  if (exactHit) return exactHit;

  // --- 3. Substring token match on merchant_name (higher confidence than name) ---
  const subCheck = (
    set: ReadonlySet<string>,
    klass: TransactionClass,
    reasonPrefix: string,
    isRecurring = false
  ): ClassifierResult | null => {
    const target = merchantLower || nameLower;
    if (!target) return null;
    const useMerchant = Boolean(merchantLower);
    for (const token of set) {
      if (token.length < 4) continue; // skip ambiguous short tokens like "bp"
      if (target.includes(token)) {
        return {
          class: klass,
          confidence: useMerchant ? 0.7 : 0.5,
          reason: `${reasonPrefix} token "${token}" in ${useMerchant ? "merchant" : "name"}`,
          matched_provider_name: token,
          is_recurring: isRecurring
        };
      }
    }
    return null;
  };

  const subHit =
    subCheck(FUEL_MERCHANTS, "fuel", "Fuel") ??
    subCheck(INSURANCE_CARRIERS, "insurance", "Insurance") ??
    subCheck(AUTO_LENDERS, "lender", "Auto lender") ??
    subCheck(SERVICE_MERCHANTS, "service", "Service shop") ??
    subCheck(PARTS_MERCHANTS, "parts", "Auto parts") ??
    subCheck(REGISTRATION_MERCHANTS, "registration", "DMV") ??
    subCheck(PARKING_TOLL_MERCHANTS, "parking_toll", "Parking / toll") ??
    subCheck(VEHICLE_SUBSCRIPTIONS, "subscription", "Vehicle subscription", true);
  if (subHit) return subHit;

  // --- 4. Plaid category fallback ---
  const catHit = classifyByPlaidCategory(txn.category);
  if (catHit) {
    return {
      class: catHit.class,
      confidence: 0.85,
      reason: catHit.reason,
      matched_provider_name: null
    };
  }

  return null;
}

/**
 * Classify every (non-pending) transaction in the given list and upsert
 * results. Designed to be called immediately after a Plaid sync completes
 * for a single user. Idempotent: re-running on the same transactions
 * updates the row's confidence/reason but never flips a confirmed/dismissed
 * row back to pending.
 *
 * Returns counts so the audit log can record "classified N, found M
 * vehicle-relevant".
 */
export async function classifyTransactionsForUser(params: {
  userId: string;
  /** plaid_transactions.id values to classify (uuids). If omitted, every
   *  non-removed transaction for this user is classified. */
  transactionIds?: string[];
}): Promise<{
  scanned: number;
  classified: number;
  byClass: Record<TransactionClass, number>;
}> {
  const byClass: Record<TransactionClass, number> = {
    fuel: 0,
    insurance: 0,
    lender: 0,
    service: 0,
    parts: 0,
    registration: 0,
    parking_toll: 0,
    subscription: 0
  };

  // Load user context (vehicles, carriers, lenders) — one query each, joined
  // in memory. The classifier hits this per-transaction so we cache it.
  const [vehiclesRes, insuranceRes, loanRes] = await Promise.all([
    supabaseAdmin
      .from("vehicles")
      .select("id, created_at")
      .eq("user_id", params.userId)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("insurance_accounts")
      .select("carrier_name")
      .eq("user_id", params.userId),
    supabaseAdmin
      .from("loan_lease_accounts")
      .select("lender_name")
      .eq("user_id", params.userId)
  ]);

  const defaultVehicleId =
    ((vehiclesRes.data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
  const insuranceCarriers = (((insuranceRes.data ?? []) as Array<{ carrier_name: string | null }>)
    .map((r) => (r.carrier_name ?? "").toLowerCase().trim())
    .filter(Boolean));
  const lenderNames = (((loanRes.data ?? []) as Array<{ lender_name: string | null }>)
    .map((r) => (r.lender_name ?? "").toLowerCase().trim())
    .filter(Boolean));

  // Pull transactions to classify.
  let txQuery = supabaseAdmin
    .from("plaid_transactions")
    .select("id, user_id, name, merchant_name, amount_cents, category, date, pending")
    .eq("user_id", params.userId)
    .is("removed_at", null);
  if (params.transactionIds && params.transactionIds.length > 0) {
    txQuery = txQuery.in("id", params.transactionIds);
  }
  const { data: txns, error: txErr } = await txQuery;
  if (txErr) {
    console.error("[classifier] failed to load transactions", txErr);
    return { scanned: 0, classified: 0, byClass };
  }

  const txnList = (txns ?? []) as ClassifierInput[];
  if (txnList.length === 0) return { scanned: 0, classified: 0, byClass };

  // Load existing classifications so we don't clobber confirmed/dismissed rows.
  const { data: existingRows } = await supabaseAdmin
    .from("plaid_transaction_classifications")
    .select("id, plaid_transaction_id, class, confirmed_at, dismissed_at")
    .eq("user_id", params.userId)
    .in(
      "plaid_transaction_id",
      txnList.map((t) => t.id)
    );
  const existing = new Map<
    string,
    { id: string; confirmed_at: string | null; dismissed_at: string | null }
  >();
  for (const row of (existingRows ?? []) as Array<{
    id: string;
    plaid_transaction_id: string;
    class: string;
    confirmed_at: string | null;
    dismissed_at: string | null;
  }>) {
    existing.set(`${row.plaid_transaction_id}:${row.class}`, {
      id: row.id,
      confirmed_at: row.confirmed_at,
      dismissed_at: row.dismissed_at
    });
  }

  const ctx: ClassifierContext = {
    defaultVehicleId,
    insuranceCarriers,
    lenderNames,
    existing
  };

  // Run classifier and accumulate upserts.
  const upserts: Array<{
    user_id: string;
    plaid_transaction_id: string;
    vehicle_id: string | null;
    class: TransactionClass;
    confidence: number;
    reason: string;
    is_recurring: boolean;
    matched_provider_name: string | null;
    metadata: Record<string, unknown>;
  }> = [];

  for (const txn of txnList) {
    const result = classifyTransaction(txn, ctx);
    if (!result) continue;

    const existingHit = existing.get(`${txn.id}:${result.class}`);
    // Don't re-write rows the user has already decided on — preserve their
    // confirm/dismiss state. Updating confidence/reason on a confirmed row
    // is fine, but we use the upsert below with onConflict so the values
    // refresh without flipping confirmed_at/dismissed_at.
    upserts.push({
      user_id: params.userId,
      plaid_transaction_id: txn.id,
      // Fuel/service/parts are scoped to the user's vehicle. Other classes
      // (insurance/lender) are user-scoped at the entity level.
      vehicle_id:
        result.class === "fuel" ||
        result.class === "service" ||
        result.class === "parts" ||
        result.class === "registration" ||
        result.class === "parking_toll"
          ? ctx.defaultVehicleId
          : null,
      class: result.class,
      confidence: result.confidence,
      reason: result.reason,
      is_recurring: Boolean(result.is_recurring),
      matched_provider_name: result.matched_provider_name ?? null,
      metadata: {
        merchant_name: txn.merchant_name,
        name: txn.name,
        amount_cents: txn.amount_cents,
        date: txn.date,
        // Existing user decision (if any) preserved for inspection in the UI.
        was_confirmed: Boolean(existingHit?.confirmed_at),
        was_dismissed: Boolean(existingHit?.dismissed_at)
      }
    });
    byClass[result.class]++;
  }

  if (upserts.length === 0) {
    return { scanned: txnList.length, classified: 0, byClass };
  }

  // Upsert in chunks of 200 to stay well under Postgres parameter limits.
  for (let i = 0; i < upserts.length; i += 200) {
    const chunk = upserts.slice(i, i + 200);
    const { error: upErr } = await supabaseAdmin
      .from("plaid_transaction_classifications")
      .upsert(chunk, { onConflict: "plaid_transaction_id,class" });
    if (upErr) {
      console.error("[classifier] upsert chunk failed", upErr);
    }
  }

  return { scanned: txnList.length, classified: upserts.length, byClass };
}

/**
 * Convenience for the route handler: re-classifies every transaction for
 * a user. Used when the user changes their insurance carrier / lender so
 * the boost rules pick up the new value.
 */
export async function reclassifyAllForUser(userId: string) {
  return classifyTransactionsForUser({ userId });
}
