/**
 * Current-provider detection.
 *
 * When the agent dispatches a refinance / insurance request, the user's
 * EXISTING lender or carrier often shows up in the discovered candidate
 * list. Without context, the agent looks dumb: "we found a great lender for
 * you — it's the one you already use." Worse, blasting your own lender with
 * a generic cold email throws away the established relationship.
 *
 * This module annotates a discovered provider list with which (if any) is
 * the user's current provider, plus a short explainer the UI shows on the
 * card. From there, the user can:
 *   - skip them ("got it, find me others")
 *   - include them with their known rep's email (existing contact)
 *   - include them blind (e.g., the loan was originated long enough ago
 *     that meaningful rate movement makes a comparison fair)
 *
 * The match is intentionally fuzzy on name only — we don't have lender IDs
 * across systems. Two-direction substring on lowercased+normalized strings
 * catches "Redwood Credit Union" matching "Redwood CU" and "GEICO" matching
 * "Geico Insurance Co".
 */

import { supabaseAdmin } from "../supabase.js";
import type { DispatchableTaskType } from "./dealer-discovery.js";

export interface CurrentProviderMatch {
  is_current_provider: true;
  current_provider_note: string;
}

export type CurrentProviderAnnotation = Partial<CurrentProviderMatch>;

/**
 * Return a map of provider-id -> annotation for any candidates that match
 * the user's current lender (refinance) or carrier (insurance_quote). Other
 * task types return an empty map.
 */
export async function detectCurrentProviders(params: {
  userId: string;
  vehicleId: string;
  taskType: DispatchableTaskType;
  candidates: Array<{ id: string; name: string }>;
}): Promise<Map<string, CurrentProviderAnnotation>> {
  const out = new Map<string, CurrentProviderAnnotation>();
  if (params.candidates.length === 0) return out;

  // Fetch the user's current relationship for the relevant vertical.
  let currentName: string | null = null;
  let originatedAt: string | null = null;
  let aprBps: number | null = null;
  let note: string;

  if (params.taskType === "refinance") {
    const { data: loan } = await supabaseAdmin
      .from("loan_lease_accounts")
      .select("lender_name, start_date, apr_bps, first_payment_date")
      .eq("vehicle_id", params.vehicleId)
      .maybeSingle();
    currentName = (loan as any)?.lender_name ?? null;
    originatedAt = (loan as any)?.start_date ?? (loan as any)?.first_payment_date ?? null;
    aprBps = (loan as any)?.apr_bps ?? null;
    note = buildLenderNote(originatedAt, aprBps);
  } else if (params.taskType === "insurance_quote") {
    const { data: ins } = await supabaseAdmin
      .from("insurance_accounts")
      .select("carrier_name")
      .eq("vehicle_id", params.vehicleId)
      .maybeSingle();
    currentName = (ins as any)?.carrier_name ?? null;
    note =
      "Your current carrier. Included for comparison — you may already qualify for renewal discounts. If you have a known agent, paste their email instead of cold-contacting the carrier's main inbox.";
  } else {
    return out;
  }

  if (!currentName) return out;

  const normalizedCurrent = normalizeName(currentName);
  if (!normalizedCurrent) return out;

  for (const c of params.candidates) {
    if (matchesName(normalizedCurrent, normalizeName(c.name))) {
      out.set(c.id, {
        is_current_provider: true,
        current_provider_note: note
      });
    }
  }
  return out;
}

/**
 * Two-direction substring match on normalized names. Each name is
 * lowercased and stripped of common corporate suffixes / punctuation so
 * "Redwood Credit Union, Inc." and "Redwood CU" reduce to the same root.
 */
function matchesName(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // Token overlap heuristic: if every token of the shorter name appears in
  // the longer name, treat as a match. Catches "Redwood Credit Union" vs
  // "Redwood CU" because we strip "credit union" and "cu" suffixes already,
  // but this is the belt-and-suspenders check for partial matches.
  const tokensA = a.split(/\s+/).filter((t) => t.length > 1);
  const tokensB = b.split(/\s+/).filter((t) => t.length > 1);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  return shorter.every((t) => longer.includes(t));
}

function normalizeName(input: string | null | undefined): string {
  if (!input) return "";
  let s = input.toLowerCase().trim();
  // Strip punctuation we don't care about
  s = s.replace(/[.,'"&/\\\-_()]/g, " ");
  // Common corporate / financial suffixes that don't aid identity
  const noiseWords = [
    "the",
    "inc",
    "incorporated",
    "llc",
    "corp",
    "corporation",
    "company",
    "co",
    "ltd",
    "fcu",
    "cu",
    "credit",
    "union",
    "federal",
    "national",
    "bank",
    "savings",
    "trust",
    "financial",
    "finance",
    "insurance",
    "mutual",
    "group",
    "holdings"
  ];
  s = s
    .split(/\s+/)
    .filter((w) => w.length > 0 && !noiseWords.includes(w))
    .join(" ");
  return s.trim();
}

function buildLenderNote(originatedAt: string | null, aprBps: number | null): string {
  // We don't have a real-time rate feed yet, so we frame it as "the user can
  // judge — here's what they have today." This avoids fabricating a savings
  // claim.
  const aprText =
    typeof aprBps === "number" ? `Your current rate: ${(aprBps / 100).toFixed(2)}%.` : "";
  const ageText = (() => {
    if (!originatedAt) return "";
    const months = Math.max(
      0,
      Math.floor((Date.now() - new Date(originatedAt).getTime()) / (30 * 86_400_000))
    );
    if (months < 6) return "Originated recently — refi savings are unlikely yet.";
    if (months < 18) return `Originated ~${months} months ago.`;
    return `Originated ~${Math.round(months / 12)} years ago — worth checking if rates have moved.`;
  })();
  return [
    "Your current lender.",
    aprText,
    ageText,
    "If you have a rep you already work with, swap in their email below."
  ]
    .filter(Boolean)
    .join(" ");
}
