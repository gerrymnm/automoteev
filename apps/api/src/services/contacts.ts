/**
 * Per-department contact learning.
 *
 * A single dealership has multiple humans in multiple inboxes — service writer,
 * sales rep, F&I, parts. We don't conflate them. Each provider has a `contacts`
 * JSONB column keyed by department; the originally-published `providers.email`
 * remains the fallback (the address we discovered on their public site).
 *
 * Outbound flow:
 *   1. Map the task to a department via taskCategoryToDept().
 *   2. Look up provider.contacts[dept]. If present, use it.
 *   3. Otherwise fall back to provider.email.
 *
 * Inbound learning flow (in webhooks.ts):
 *   1. Find the originating outbound + its task.
 *   2. Determine the dept from the task's task_type / category.
 *   3. If reply's from-domain matches the to-domain (and isn't no-reply), write
 *      provider.contacts[dept] = reply.from. We never overwrite a different
 *      department's contact. We never overwrite the published .email field.
 */

export type ContactDept = "service" | "sales" | "finance" | "general";

/**
 * Map a task type to the dealer department it should reach.
 *
 *   service: recall, maintenance, service appointments
 *   sales:   selling the vehicle, lease-end / turn-in
 *   finance: payoff, refinance
 *   general: catch-all (insurance agencies, anything ambiguous)
 */
export function taskTypeToContactDept(taskType: string | null | undefined): ContactDept {
  if (!taskType) return "general";
  switch (taskType) {
    case "recall_repair":
    case "recall_appointment":
    case "recall_check":
    case "service_quote":
    case "service_appointment":
    case "maintenance_quote":
      return "service";

    case "sell_vehicle":
    case "lease_end_review":
      return "sales";

    case "refinance":
    case "refinance_review":
    case "payoff_request":
      return "finance";

    case "insurance_quote":
    case "insurance_review":
    default:
      return "general";
  }
}

/**
 * Pick the address we should email for this (provider, dept) combo.
 * `contacts` is the JSONB column off the providers row. `fallbackEmail` is
 * `providers.email`. `communityEmail` is the freshest community-verified
 * contact at the same business+dept (from business_contacts), if any.
 * Returns null if none is available.
 *
 * Priority:
 *   1. Per-user learned contact   (this user has already heard from this rep)
 *   2. Community-verified contact (some other user heard from a rep here)
 *   3. Published fallback email   (scraped from the dealer's website)
 */
export function pickProviderEmailForDept(
  contacts: Record<string, string> | null | undefined,
  fallbackEmail: string | null | undefined,
  dept: ContactDept,
  communityEmail?: string | null
): string | null {
  const learned = contacts?.[dept];
  if (typeof learned === "string" && learned.includes("@")) return learned;
  if (typeof communityEmail === "string" && communityEmail.includes("@")) return communityEmail;
  if (typeof fallbackEmail === "string" && fallbackEmail.includes("@")) return fallbackEmail;
  return null;
}

/**
 * Decide whether to learn a new dept-scoped contact from an inbound reply.
 * Returns the new address to store, or null if we should NOT learn from this reply.
 *
 * Rules:
 *   - same domain as the address we wrote to (cross-domain replies ignored)
 *   - not a no-reply / do-not-reply mailbox
 *   - different from what's already stored for this dept (avoid no-op writes)
 *   - different from the originally-emailed address (otherwise nothing learned)
 */
export function shouldLearnContact(params: {
  replyFrom: string;
  outboundTo: string;
  existingForDept: string | null | undefined;
}): string | null {
  const replyFrom = params.replyFrom.toLowerCase().trim();
  const outboundTo = params.outboundTo.toLowerCase().trim();

  if (!replyFrom.includes("@") || !outboundTo.includes("@")) return null;
  if (replyFrom === outboundTo) return null;

  const replyDomain = replyFrom.split("@")[1] ?? "";
  const outboundDomain = outboundTo.split("@")[1] ?? "";
  if (!replyDomain || !outboundDomain || replyDomain !== outboundDomain) return null;

  if (/^(no.?reply|do.?not.?reply|noreply)@/.test(replyFrom)) return null;

  const existing = params.existingForDept?.toLowerCase().trim();
  if (existing && existing === replyFrom) return null; // already learned

  return replyFrom;
}
