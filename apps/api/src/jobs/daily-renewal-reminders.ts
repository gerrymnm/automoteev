/**
 * Daily renewal reminder cron.
 *
 * For each renewable_items row whose days_until_expiration matches one of
 * the five threshold values (30 / 14 / 7 / 1 / 0) AND we haven't fired
 * a notification at that threshold yet, send a push and record the row in
 * renewable_item_reminders so we never double-send.
 *
 * Cadence: same as daily-recalls — first run 90s after boot (offset by
 * 30s so the two crons don't fight for resources on a single Railway
 * instance), then every 24h. setInterval keeps it in-process; horizontal
 * scaling will need a real scheduler.
 */

import { runDailyRenewalReminders } from "../services/renewals-insights.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// Offset from daily-recalls (60s) so the two jobs don't pin the event
// loop simultaneously on cold start. 90s lets health checks complete first.
const FIRST_RUN_DELAY_MS = 90 * 1000;

export function startDailyRenewalRemindersJob() {
  console.log(
    "[cron] daily-renewal-reminders scheduled — first run in 90s, then every 24h"
  );
  setTimeout(() => {
    void runDailyRenewalReminders().catch((err) =>
      console.error("[cron] daily-renewal-reminders first run failed", err)
    );
    setInterval(() => {
      void runDailyRenewalReminders().catch((err) =>
        console.error("[cron] daily-renewal-reminders run failed", err)
      );
    }, ONE_DAY_MS);
  }, FIRST_RUN_DELAY_MS);
}
