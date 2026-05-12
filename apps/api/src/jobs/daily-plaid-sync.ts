/**
 * Daily Plaid sync cron.
 *
 * Plaid webhooks are the primary refresh mechanism in production (they fire
 * within minutes of a new transaction posting), but:
 *   - sandbox/development environments don't fire webhooks reliably
 *   - production webhooks can be missed during outages, server restarts,
 *     or signature verification failures
 *
 * A daily backstop sync ensures every active item gets refreshed at least
 * once per 24h. Re-syncing is cheap (Plaid /transactions/sync is incremental
 * via cursor) and writes are idempotent (ON CONFLICT plaid_transaction_id).
 *
 * After each item's sync, the new transactions are auto-classified so the
 * Home Needs You stack stays up to date without manual triggers.
 *
 * Cadence: first run 120s after boot (offset 30s after daily-renewal-reminders
 * which is 90s after boot, which is 30s after daily-recalls at 60s). Then
 * every 24h. setInterval keeps it in-process; horizontal scaling needs a
 * real scheduler.
 */

import { supabaseAdmin } from "../supabase.js";
import { syncPlaidTransactions, type PlaidTransaction } from "../services/plaid.js";
import { decryptField } from "../security/encryption.js";
import { classifyTransactionsForUser } from "../services/transaction-classifier.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 120 * 1000;

export function startDailyPlaidSyncJob() {
  console.log(
    "[cron] daily-plaid-sync scheduled — first run in 120s, then every 24h"
  );
  setTimeout(() => {
    void runDailyPlaidSync().catch((err) =>
      console.error("[cron] daily-plaid-sync first run failed", err)
    );
    setInterval(() => {
      void runDailyPlaidSync().catch((err) =>
        console.error("[cron] daily-plaid-sync run failed", err)
      );
    }, ONE_DAY_MS);
  }, FIRST_RUN_DELAY_MS);
}

interface SyncSummary {
  items_scanned: number;
  items_synced: number;
  added: number;
  modified: number;
  removed: number;
  classified: number;
  errors: number;
}

/**
 * Sync every active Plaid item across the platform. Idempotent — safe to
 * call repeatedly. Items in `error` or `disconnected` status are skipped.
 *
 * Exported so the /api/jobs/:jobName/run endpoint and on-demand admin
 * triggers can invoke it.
 */
export async function runDailyPlaidSync(): Promise<SyncSummary> {
  const summary: SyncSummary = {
    items_scanned: 0,
    items_synced: 0,
    added: 0,
    modified: 0,
    removed: 0,
    classified: 0,
    errors: 0
  };

  // Pull all active items. We page by created_at desc so a small batch from
  // the latest signup gets refreshed first if something's flaky.
  const { data: items, error } = await supabaseAdmin
    .from("plaid_items")
    .select("id, user_id, access_token_encrypted, transactions_cursor")
    .eq("status", "active");
  if (error) {
    console.error("[cron-plaid] failed to list active items", error);
    return summary;
  }

  const itemList = (items ?? []) as Array<{
    id: string;
    user_id: string;
    access_token_encrypted: string;
    transactions_cursor: string | null;
  }>;
  summary.items_scanned = itemList.length;

  // Track which users had at least one item produce new transactions, so we
  // only re-classify users whose data actually changed (saves work on a
  // typical day where most items have zero new transactions).
  const usersToClassify = new Map<string, Set<string>>(); // userId -> set of plaid_transactions.id

  for (const item of itemList) {
    try {
      const accessToken = decryptField(item.access_token_encrypted);
      if (!accessToken) {
        console.warn(`[cron-plaid] item ${item.id} access token undecryptable, marking error`);
        await supabaseAdmin
          .from("plaid_items")
          .update({
            status: "error",
            error_code: "decrypt_failed",
            error_message: "Could not decrypt access token (key rotated?)"
          })
          .eq("id", item.id);
        summary.errors++;
        continue;
      }

      const result = await syncPlaidTransactions({
        accessToken,
        cursor: item.transactions_cursor ?? null
      });

      // Bulk-import the new and modified transactions. We piggyback on the
      // existing upsert helper from routes.ts — but since this module
      // can't easily import that file (it's an Express router), we inline
      // the equivalent write here.
      await applyPlaidSyncDeltas({
        userId: item.user_id,
        plaidItemId: item.id,
        added: result.added,
        modified: result.modified,
        removed: result.removed
      });

      await supabaseAdmin
        .from("plaid_items")
        .update({
          transactions_cursor: result.next_cursor,
          last_synced_at: new Date().toISOString(),
          status: "active",
          error_code: null,
          error_message: null
        })
        .eq("id", item.id);

      summary.items_synced++;
      summary.added += result.added.length;
      summary.modified += result.modified.length;
      summary.removed += result.removed.length;

      // Record this user as needing classification if anything actually changed.
      if (result.added.length > 0 || result.modified.length > 0) {
        if (!usersToClassify.has(item.user_id)) {
          usersToClassify.set(item.user_id, new Set());
        }
        // Resolve the plaid_transactions.id (our uuid) for each new/modified
        // Plaid txn so the classifier scopes to just the deltas.
        const plaidIds = [...result.added, ...result.modified].map((t) => t.transaction_id);
        if (plaidIds.length > 0) {
          const { data: rows } = await supabaseAdmin
            .from("plaid_transactions")
            .select("id")
            .eq("user_id", item.user_id)
            .in("plaid_transaction_id", plaidIds);
          for (const row of (rows ?? []) as Array<{ id: string }>) {
            usersToClassify.get(item.user_id)!.add(row.id);
          }
        }
      }
    } catch (err) {
      console.error(`[cron-plaid] item ${item.id} sync failed`, err);
      const errMsg = err instanceof Error ? err.message : "sync_failed";
      await supabaseAdmin
        .from("plaid_items")
        .update({
          status: "error",
          error_code: "sync_failed",
          error_message: errMsg.slice(0, 500)
        })
        .eq("id", item.id);
      summary.errors++;
    }
  }

  // Classify deltas per user.
  for (const [userId, txnIdSet] of usersToClassify) {
    try {
      const out = await classifyTransactionsForUser({
        userId,
        transactionIds: Array.from(txnIdSet)
      });
      summary.classified += out.classified;
    } catch (err) {
      console.error(`[cron-plaid] classification failed for user ${userId}`, err);
    }
  }

  console.log(
    `[cron-plaid] complete: scanned=${summary.items_scanned} synced=${summary.items_synced} added=${summary.added} modified=${summary.modified} removed=${summary.removed} classified=${summary.classified} errors=${summary.errors}`
  );
  return summary;
}

/**
 * Apply added/modified/removed transactions to the plaid_transactions table.
 * Mirrors routes.ts:upsertPlaidTransactions so this cron can run without
 * importing the Express router (which would cause a circular dep).
 */
async function applyPlaidSyncDeltas(params: {
  userId: string;
  plaidItemId: string;
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
}) {
  const transactions = [...params.added, ...params.modified];
  if (transactions.length) {
    const accountIds = Array.from(new Set(transactions.map((t) => t.account_id)));
    const { data: accounts } = await supabaseAdmin
      .from("plaid_accounts")
      .select("id, plaid_account_id")
      .in("plaid_account_id", accountIds);
    const accountMap = new Map<string, string>();
    for (const a of (accounts ?? []) as Array<{ id: string; plaid_account_id: string }>) {
      accountMap.set(a.plaid_account_id, a.id);
    }
    const rows = transactions.map((t) => ({
      user_id: params.userId,
      plaid_item_id: params.plaidItemId,
      plaid_account_id: accountMap.get(t.account_id) ?? null,
      plaid_transaction_id: t.transaction_id,
      name: t.name,
      merchant_name: t.merchant_name,
      amount_cents: Math.round(t.amount * 100),
      iso_currency_code: t.iso_currency_code,
      date: t.date,
      authorized_date: t.authorized_date,
      category: t.category,
      payment_channel: t.payment_channel,
      pending: t.pending,
      removed_at: null,
      raw: t
    }));
    const { error: upErr } = await supabaseAdmin
      .from("plaid_transactions")
      .upsert(rows, { onConflict: "plaid_transaction_id" });
    if (upErr) {
      throw new Error(`plaid_transactions upsert failed: ${upErr.message}`);
    }
  }
  if (params.removed.length) {
    const ids = params.removed.map((r) => r.transaction_id);
    await supabaseAdmin
      .from("plaid_transactions")
      .update({ removed_at: new Date().toISOString() })
      .in("plaid_transaction_id", ids)
      .eq("user_id", params.userId);
  }
}
