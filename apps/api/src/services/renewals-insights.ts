import { supabaseAdmin } from "../supabase.js";
import { sendPushToUser } from "./push.js";
import { listRenewalsForUser, type RenewableItemWithStatus } from "./renewals.js";

/**
 * Renewals insights + reminder service.
 *
 * Two responsibilities:
 *   1. Produce synthetic "Needs You" cards for renewals that are within
 *      their reminder window. Consumed by /api/home so the user sees a
 *      "DL expires in 60 days — renew now" card alongside other urgent
 *      items.
 *   2. Drive the daily reminder cron: for each due-soon item, send ONE
 *      push notification per (item, threshold) pair, dedupe via
 *      renewable_item_reminders so we never spam.
 *
 * Thresholds we fire pushes at: 30 / 14 / 7 / 1 days before expiration,
 * plus a one-shot on the day-of (threshold=0). Each item only fires once
 * per threshold — re-running the cron is a no-op for already-notified rows.
 *
 * The Home cards (path 1) update on every fetch from the live data — they
 * do NOT depend on the cron having run. The cron only handles pushes.
 */

export interface RenewalCard {
  task_id: null;
  vehicle_id: string | null;
  kind: "renewal";
  title: string;
  body: string;
  options: null;
  set_at: null;
  category: "renewal";
  task_type: null;
  synthetic: true;
  insight_key: string;
  cta_label: string;
  cta_action: RenewalCtaAction;
  // The underlying renewable item id so the UI can wire Edit / Snooze /
  // Delete buttons to the right row without a second fetch.
  renewable_item_id: string;
  // Status fields surfaced for client rendering — same as the panel's
  // color-coded badges so the home card and panel stay consistent.
  is_expired: boolean;
  days_until_expiration: number | null;
}

/**
 * What action the CTA should take. Covers the three real flows we have today:
 *   shop_replacement → opens dispatch flow for insurance_quote (we have
 *                      the full pipeline already)
 *   open_external    → navigate the user to a URL (DMV for DL/registration
 *                      since the agent can't legally renew those for them)
 *   edit_renewal     → open the RenewalFormModal in edit mode (default for
 *                      warranties / memberships / subscriptions where the
 *                      right action is "go to your provider's portal" —
 *                      we surface that intent through the row's notes/url
 *                      eventually, but for now editing is a sensible default)
 */
export type RenewalCtaAction =
  | { type: "shop_replacement"; task_type: "insurance_quote" }
  | { type: "open_external"; url: string; label: string }
  | { type: "edit_renewal" };

/**
 * Build the home card for a single due-soon or expired renewable item.
 * Pure function — caller passes already-decorated items from
 * listRenewalsForUser().
 *
 * Title formatting balances brevity (it goes in the "Needs You" stack
 * alongside other cards) with enough context to act without drilling
 * in. For an item that's already expired we lead with "EXPIRED" so the
 * user can't miss it.
 */
function cardFromRenewal(item: RenewableItemWithStatus): RenewalCard {
  const days = item.days_until_expiration;
  const isExpired = item.is_expired;

  // Title: lead with urgency state, then the user's label.
  const titlePrefix = isExpired
    ? `EXPIRED: ${item.label}`
    : days === 0
      ? `${item.label} expires TODAY`
      : days === 1
        ? `${item.label} expires tomorrow`
        : `${item.label} expires in ${days}d`;

  const provider = item.provider_name ? ` (${item.provider_name})` : "";

  // CTA depends on the kind. Insurance gets the dispatch shortcut since we
  // have a full shop-replacement pipeline. DL/registration go to a state
  // DMV redirect (legally we can't transact for them). Everything else
  // opens the edit form so the user can update the date or move it
  // elsewhere if it's already been renewed.
  let ctaLabel: string;
  let ctaAction: RenewalCtaAction;
  switch (item.kind) {
    case "insurance_policy":
      ctaLabel = "Shop replacement quotes";
      ctaAction = { type: "shop_replacement", task_type: "insurance_quote" };
      break;
    case "drivers_license":
      ctaLabel = "Open DMV";
      ctaAction = {
        type: "open_external",
        // California by default. We have dl_state in user_pii for the
        // proper redirect later; for now CA is the only supported state
        // and >95% of our test traffic.
        url: "https://www.dmv.ca.gov/portal/driver-licenses-identification-cards/renew-driver-license-rdl/",
        label: "DMV.ca.gov"
      };
      break;
    case "vehicle_registration":
      ctaLabel = "Renew registration";
      ctaAction = {
        type: "open_external",
        url: "https://www.dmv.ca.gov/portal/vehicle-registration/registration-renewal/",
        label: "DMV.ca.gov"
      };
      break;
    default:
      ctaLabel = "Update";
      ctaAction = { type: "edit_renewal" };
  }

  // Body line surfaces the "what to do" and the auto-renew distinction
  // because that's a real source of confusion (lapse vs cancel).
  const renewVerb = item.auto_renews
    ? "auto-renews if you don't act"
    : "won't renew automatically";
  const body = isExpired
    ? `${item.label}${provider} has lapsed. Update to keep coverage.`
    : `${item.label}${provider} ${renewVerb}.`;

  return {
    task_id: null,
    vehicle_id: item.vehicle_id,
    kind: "renewal",
    title: titlePrefix,
    body,
    options: null,
    set_at: null,
    category: "renewal",
    task_type: null,
    synthetic: true,
    // Stable insight_key so dismissed_insights can target this card. We
    // include the item id so dismissing one renewal doesn't dismiss all.
    insight_key: `renewal:${item.id}`,
    cta_label: ctaLabel,
    cta_action: ctaAction,
    renewable_item_id: item.id,
    is_expired: isExpired,
    days_until_expiration: days
  };
}

/**
 * Pull all due-soon or expired (but not snoozed) renewable items for a user
 * and convert each to a home card. Used by /api/home.
 *
 * "Due soon" means within reminder_days_before of expiration (per-item
 * threshold). "Expired" means the date has passed AND the item hasn't been
 * deleted/snoozed. Items expiring further out than their reminder window
 * don't surface as cards — they're visible in the renewals panel but not
 * the Needs You stack.
 */
export async function getRenewalCardsForHome(
  userId: string
): Promise<RenewalCard[]> {
  const items = await listRenewalsForUser({
    userId,
    includeDismissed: false,
    includeExpired: true
  });

  return items
    .filter((i) => i.is_due_soon || i.is_expired)
    .map(cardFromRenewal);
}

/**
 * Daily renewal reminder cron. For each user with at least one active
 * renewable item, find any item whose days_until_expiration matches a
 * notification threshold (30/14/7/1/0) AND we haven't fired that threshold
 * yet, then send a push and record the reminder.
 *
 * Cheap query pattern: we only consider items expiring within the next 31
 * days. Mileage-only items don't fire pushes (no time signal).
 *
 * Idempotent: rerunning the same day produces 0 new reminders (UNIQUE
 * constraint on (renewable_item_id, threshold_days) catches any race).
 */
export async function runDailyRenewalReminders(): Promise<{
  checked: number;
  sent: number;
  skipped: number;
  errors: number;
}> {
  // Pull every renewable_item that could plausibly be at a threshold today.
  // 31 days ahead covers the 30d threshold; expired items still get the
  // day-of (threshold=0) treatment IF we haven't fired it yet (e.g.,
  // user added an already-expired item manually).
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cutoffFuture = new Date(today.getTime() + 31 * 86_400_000);

  const { data: candidates, error } = await supabaseAdmin
    .from("renewable_items")
    .select("id, user_id, label, kind, expires_at, reminder_days_before, dismissed_until")
    .not("expires_at", "is", null)
    .lte("expires_at", cutoffFuture.toISOString().slice(0, 10))
    .limit(1000);

  if (error) {
    console.error("[cron] renewal reminders query failed", error);
    return { checked: 0, sent: 0, skipped: 0, errors: 1 };
  }

  let sent = 0;
  let skipped = 0;
  let errors = 0;
  const checked = candidates?.length ?? 0;
  console.log(`[cron] renewal reminders: ${checked} candidate(s) within 31d window`);

  for (const c of candidates ?? []) {
    try {
      const item = c as any;

      // Skip items the user has snoozed.
      if (
        item.dismissed_until &&
        new Date(item.dismissed_until) > new Date()
      ) {
        skipped++;
        continue;
      }

      // Compute days_until and decide which threshold (if any) we hit today.
      const expires = new Date(item.expires_at);
      expires.setHours(0, 0, 0, 0);
      const daysUntil = Math.round(
        (expires.getTime() - today.getTime()) / 86_400_000
      );

      // Only fire at exact thresholds. We deliberately don't fire on every
      // day in between — the user would tune out. The five thresholds give
      // an escalating cadence: 30d (heads-up) → 14d → 7d (last chance to
      // schedule) → 1d (tomorrow!) → 0d (today is the day).
      const thresholds = [30, 14, 7, 1, 0] as const;
      const matched = thresholds.find((t) => t === daysUntil);
      if (matched === undefined) {
        skipped++;
        continue;
      }

      // Have we already fired this (item, threshold)? Skip if so.
      const { data: prior } = await supabaseAdmin
        .from("renewable_item_reminders")
        .select("id")
        .eq("renewable_item_id", item.id)
        .eq("threshold_days", matched)
        .maybeSingle();
      if (prior) {
        skipped++;
        continue;
      }

      // Compose the push. Title is the urgency framing; body is short
      // because notification trays clip everything past ~80 chars.
      const title =
        matched === 0
          ? `${item.label} expires today`
          : matched === 1
            ? `${item.label} expires tomorrow`
            : `${item.label} expires in ${matched} days`;
      const body =
        matched <= 7
          ? `Tap to renew or shop a replacement.`
          : `Plan ahead — open Automoteev when you're ready.`;

      // Insert FIRST, then send. The UNIQUE constraint guarantees we don't
      // double-send if two cron ticks race; the row is the dedupe oracle.
      const { error: insertErr } = await supabaseAdmin
        .from("renewable_item_reminders")
        .insert({
          user_id: item.user_id,
          renewable_item_id: item.id,
          threshold_days: matched,
          notification_title: title,
          notification_body: body
        });
      if (insertErr) {
        // 23505 = unique violation (another worker raced and already inserted).
        // Anything else is a real problem.
        if ((insertErr as any).code === "23505") {
          skipped++;
        } else {
          console.error(
            `[cron] reminder insert failed for item ${item.id}`,
            insertErr
          );
          errors++;
        }
        continue;
      }

      // Best-effort push. If the user has no active subscriptions
      // sendPushToUser is a no-op and returns 0, which is fine — the row
      // is recorded so we won't try again at this threshold even if the
      // user later subscribes.
      try {
        await sendPushToUser(item.user_id, {
          title,
          body,
          // Renewals panel lives on Home; deep link to it.
          url: "/app",
          tag: `renewal:${item.id}`
        });
        sent++;
      } catch (pushErr) {
        console.error(
          `[cron] push failed for renewal ${item.id} (already logged)`,
          pushErr
        );
        // Don't roll back the row — the user got a card on Home regardless.
      }
    } catch (err) {
      errors++;
      console.error(`[cron] renewal reminder loop error`, err);
    }
  }

  console.log(
    `[cron] renewal reminders done: checked=${checked} sent=${sent} skipped=${skipped} errors=${errors}`
  );
  return { checked, sent, skipped, errors };
}
