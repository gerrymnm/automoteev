import { Router, type NextFunction, type Request, type Response } from "express";
import "express-async-errors";
import multer from "multer";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { audit } from "./audit.js";
import { env } from "./config.js";
import { supabaseAdmin } from "./supabase.js";
import { calculateCosts } from "./engines/cost.js";
import { generateAlerts, statusFromAlerts } from "./engines/alerts.js";
import { generateInsights, statusFromInsights } from "./engines/insights.js";
import { getVehicleValuation } from "./services/valuation.js";
import {
  uploadDocument,
  extractDocument,
  applyExtractedDocument,
  planAttachmentsForDispatch,
  resolveAttachmentsForDispatch,
  createDocumentSignedUrl,
  type DocumentKind,
  type PlannedAttachment
} from "./services/documents.js";
import {
  maintenanceDue,
  seedMaintenanceItems
} from "./engines/maintenance.js";
import { taskFromCommand } from "./engines/tasks.js";
import {
  recordSkippedFields,
  markFieldCompleted,
  pendingPromptsForUser,
  touchPrompted,
  dismissPrompt
} from "./engines/onboarding.js";
import { decodeVin } from "./services/vin.js";
import { lookupRecallsByVehicle, lookupRecallsByVin } from "./services/recalls.js";
import { sendTaskEmail } from "./services/email.js";
import { taskEmailBody, taskEmailSubject } from "./services/emailTemplates.js";
import { createProCheckoutSession } from "./services/stripe.js";
import { searchProviders } from "./services/places.js";
import { discoverProvidersForTask, isDispatchable, type DispatchableTaskType } from "./services/dealer-discovery.js";
import { detectCurrentProviders } from "./services/current-provider.js";
import {
  upsertBusiness,
  lookupSharedContact,
  lookupSharedContactsBulk,
  type SharedContact
} from "./services/business-directory.js";
import { pickProviderEmailForDept, taskTypeToContactDept } from "./services/contacts.js";
import { subscribePush, unsubscribePush, sendPushToUser } from "./services/push.js";
import {
  getSmsConfigStatus,
  normalizePhoneForSms,
  sendSms,
  taskApprovalSmsBody
} from "./services/sms.js";
import {
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  getPlaidAccounts,
  getPlaidConfigStatus,
  getPlaidInstitution,
  getPlaidItem,
  syncPlaidTransactions,
  type PlaidAccount,
  type PlaidTransaction
} from "./services/plaid.js";
import {
  classifyTransactionsForUser,
  reclassifyAllForUser,
  type TransactionClass
} from "./services/transaction-classifier.js";
import { getGasPrice, getMaintenanceCost } from "./services/market.js";
import { assignAgentEmailLocal, composeAgentAddress } from "./services/alias.js";
import {
  listRenewalsForUser,
  dismissRenewal,
  defaultLabel,
  defaultReminderDays,
  type RenewableKind,
  type CostPeriod
} from "./services/renewals.js";
import { getRenewalCardsForHome } from "./services/renewals-insights.js";
import {
  getAutonomyState,
  recordApprovedSend,
  isPro
} from "./services/agent.js";
import { encryptField, decryptField } from "./security/encryption.js";
import {
  approvalSchema,
  onboardingSchema,
  profileSchema,
  providerSchema,
  providerSearchSchema,
  emailSendSchema,
  insuranceUpdateSchema,
  loanLeaseUpdateSchema,
  notificationPreferencesSchema,
  piiUpdateSchema,
  taskCommandSchema,
  taskCreateSchema
} from "./validators.js";
import type { OnboardingField, TaskType } from "./types.js";

export const router = Router();

// ---------- Public ----------

router.get("/health", (_req, res) => {
  res.json({ ok: true, service: "automoteev-api" });
});

router.use("/api", requireAuth);

// ---------- Profile ----------

router.get("/api/profile", async (req, res) => {
  const { data, error } = await req
    .db!.from("profiles")
    .select("*")
    .eq("id", req.user!.id)
    .maybeSingle();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ profile: data });
});

router.put("/api/profile", async (req, res) => {
  const payload = profileSchema.parse(req.body);
  const { data, error } = await req
    .db!.from("profiles")
    .upsert({ id: req.user!.id, ...payload }, { onConflict: "id" })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await audit({
    userId: req.user!.id,
    eventType: "profile_updated",
    summary: "Profile updated"
  });
  return res.json({ profile: data });
});

// ---------- Onboarding ----------

router.post("/api/onboarding", async (req, res) => {
  const payload = onboardingSchema.parse(req.body);

  if (!payload.accepted_tos || !payload.accepted_privacy || !payload.accepted_autonomy_consent) {
    return res.status(422).json({
      error: "You must accept the Terms of Service, Privacy Policy, and Autonomy Consent."
    });
  }

  const decoded = await decodeVin(payload.vin);

  // 1. Upsert profile
  const { data: profile, error: profileError } = await req
    .db!.from("profiles")
    .upsert(
      {
        id: req.user!.id,
        full_name: payload.full_name,
        email: payload.email,
        zip_code: payload.zip_code
      },
      { onConflict: "id" }
    )
    .select()
    .single();
  if (profileError) return res.status(400).json({ error: profileError.message });

  // 2. Reserve per-user agent email alias
  if (!profile.agent_email_local) {
    try {
      await assignAgentEmailLocal(req.user!.id, payload.full_name);
    } catch (err) {
      console.error("agent alias assignment failed", err);
    }
  }

  // 3. Record legal acceptances
  const acceptances = [
    { type: "tos" as const, version: env.TOS_VERSION, accepted: payload.accepted_tos },
    { type: "privacy" as const, version: env.PRIVACY_VERSION, accepted: payload.accepted_privacy },
    {
      type: "autonomy_consent" as const,
      version: env.AUTONOMY_CONSENT_VERSION,
      accepted: payload.accepted_autonomy_consent
    }
  ].filter((a) => a.accepted);
  if (acceptances.length) {
    await req.db!.from("user_agreements").insert(
      acceptances.map((a) => ({
        user_id: req.user!.id,
        agreement_type: a.type,
        version: a.version
      }))
    );
  }

  // 4. Optional OBD reservation
  if (payload.reserve_obd) {
    await req.db!
      .from("obd_reservations")
      .upsert({ user_id: req.user!.id }, { onConflict: "user_id" });
  }

  // 5. Insert vehicle
  const maintenance = maintenanceDue({
    mileage: payload.mileage,
    next_service_due_miles: null,
    obd_mileage: null,
    year: decoded.year
  });

  const { data: vehicle, error: vehicleError } = await req
    .db!.from("vehicles")
    .insert({
      user_id: req.user!.id,
      vin: payload.vin.toUpperCase(),
      year: decoded.year,
      make: decoded.make,
      model: decoded.model,
      trim: decoded.trim,
      mileage: payload.mileage,
      ownership_type: payload.ownership_type,
      estimated_value_cents: null,
      market_value_low_cents: null,
      market_value_high_cents: null,
      dealer_value_low_cents: null,
      dealer_value_high_cents: null,
      value_estimated_at: null,
      next_service_due_miles: maintenance.next_service_due_miles,
      recall_status: "unknown",
      overall_status: "action_recommended"
    })
    .select()
    .single();
  if (vehicleError) return res.status(400).json({ error: vehicleError.message });

  // 5b. Run recall lookup in the background — don't block onboarding if NHTSA is slow.
  // IMPORTANT: use supabaseAdmin here, not req.db. The request context (and its
  // user-scoped client) is gone by the time this background promise runs.
  // Capture stable values now since req may be GC'd.
  const userId = req.user!.id;
  const vehicleIdForRecall = vehicle.id;
  const vinForRecall = vehicle.vin;
  void (async () => {
    try {
      // VIN-specific lookup: returns ONLY campaigns NHTSA shows as still open
      // for this specific VIN. Avoids surfacing campaigns that were remedied
      // at prior service visits, which would otherwise create false-positive
      // anxiety for the owner.
      const recall = await lookupRecallsByVin(vinForRecall);

      console.log(
        `[onboarding] VIN recall lookup for ${vinForRecall}: ${recall.campaigns.length} open campaign(s), source=${recall.source}`
      );

      if (recall.campaigns.length) {
        await supabaseAdmin.from("recalls").upsert(
          recall.campaigns.map((c) => ({
            user_id: userId,
            vehicle_id: vehicleIdForRecall,
            nhtsa_campaign_id: c.nhtsa_campaign_id,
            summary: c.summary,
            component: c.component,
            consequence: c.consequence,
            remedy: c.remedy,
            reported_at: c.reported_at
          })),
          { onConflict: "vehicle_id,nhtsa_campaign_id", ignoreDuplicates: true }
        );
      } else {
        // No open recalls for this VIN — explicitly clear any stale rows from
        // a previous (model-year) lookup so the dashboard reflects truth.
        await supabaseAdmin
          .from("recalls")
          .update({ resolved_at: new Date().toISOString() })
          .eq("vehicle_id", vehicleIdForRecall)
          .is("resolved_at", null);
      }
      await supabaseAdmin
        .from("vehicles")
        .update({
          recall_status: recall.hasOpenRecall ? "open" : "clear",
          last_recall_check_at: new Date().toISOString()
        })
        .eq("id", vehicleIdForRecall);
    } catch (err) {
      console.error("[onboarding] recall lookup failed (non-fatal)", err);
    }
  })();

  // 6. Cost profile
  const costs = calculateCosts({
    monthly_payment_cents: payload.monthly_payment_cents,
    insurance_premium_cents: payload.insurance_premium_cents
  });
  await req.db!.from("vehicle_cost_profiles").insert({
    user_id: req.user!.id,
    vehicle_id: vehicle.id,
    ...costs
  });

  // 7. Loan / lease
  if (
    payload.ownership_type !== "owned" ||
    payload.lender_name ||
    payload.loan_lease_balance_cents
  ) {
    await req.db!.from("loan_lease_accounts").insert({
      user_id: req.user!.id,
      vehicle_id: vehicle.id,
      lender_name: payload.lender_name ?? null,
      apr_bps: payload.apr_bps ?? null,
      balance_cents: payload.loan_lease_balance_cents ?? null,
      monthly_payment_cents: payload.monthly_payment_cents ?? null,
      principal_cents: payload.principal_cents ?? null,
      term_months: payload.term_months ?? null,
      start_date: payload.loan_start_date ?? null,
      first_payment_date: payload.first_payment_date ?? null,
      rate_type: payload.rate_type ?? null,
      lease_maturity_date: payload.lease_maturity_date ?? null
    });
  }

  // 8. Insurance
  if (
    payload.insurance_carrier ||
    payload.insurance_premium_cents ||
    payload.insurance_renewal_date
  ) {
    await req.db!.from("insurance_accounts").insert({
      user_id: req.user!.id,
      vehicle_id: vehicle.id,
      carrier_name: payload.insurance_carrier ?? null,
      premium_cents: payload.insurance_premium_cents ?? null,
      renewal_date: payload.insurance_renewal_date ?? null,
      coverage_type: payload.insurance_coverage_type ?? null,
      deductible_cents: payload.insurance_deductible_cents ?? null,
      liability_limits: payload.insurance_liability_limits ?? null,
      policy_number_encrypted: payload.insurance_policy_number
        ? encryptField(payload.insurance_policy_number)
        : null
    });
  }

  // 9. Seed maintenance_items
  const seeds = seedMaintenanceItems({
    userId: req.user!.id,
    vehicleId: vehicle.id,
    currentMileage: payload.mileage,
    year: decoded.year,
    state: null // zip-only; state resolution to be added when geocoding is wired up
  });
  if (seeds.length) await req.db!.from("maintenance_items").insert(seeds);

  // 10. Record skipped onboarding fields for later nudges
  const skipped: OnboardingField[] = [];
  if (payload.monthly_payment_cents == null) skipped.push("monthly_payment");
  if (payload.loan_lease_balance_cents == null && payload.ownership_type !== "owned")
    skipped.push("loan_balance");
  if (payload.apr_bps == null && payload.ownership_type !== "owned")
    skipped.push("loan_apr");
  if (payload.loan_start_date == null && payload.ownership_type === "financed")
    skipped.push("loan_start_date");
  if (payload.term_months == null && payload.ownership_type === "financed")
    skipped.push("loan_term_months");
  if (payload.insurance_premium_cents == null) skipped.push("insurance_premium");
  if (payload.insurance_renewal_date == null) skipped.push("insurance_renewal");
  if (payload.insurance_coverage_type == null) skipped.push("insurance_coverage");
  await recordSkippedFields(req.user!.id, skipped);

  await audit({
    userId: req.user!.id,
    vehicleId: vehicle.id,
    eventType: "onboarding_completed",
    summary: "Owner completed onboarding"
  });

  return res.status(201).json({ profile, vehicle });
});

// ---------- Vehicles ----------

router.get("/api/vehicles", async (req, res) => {
  const { data, error } = await req
    .db!.from("vehicles")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ vehicles: data });
});

router.get("/api/vehicles/:id/dashboard", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.id);
  const vehicle = await one(
    req.db!.from("vehicles").select("*").eq("id", vehicleId)
  );
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

  const [
    costProfile,
    loanLease,
    insurance,
    maintRes,
    recallsRes,
    providersRes,
    fuelRes,
    activeTasksRes
  ] = await Promise.all([
    one(req.db!.from("vehicle_cost_profiles").select("*").eq("vehicle_id", vehicleId)),
    one(req.db!.from("loan_lease_accounts").select("*").eq("vehicle_id", vehicleId)),
    one(req.db!.from("insurance_accounts").select("*").eq("vehicle_id", vehicleId)),
    req
      .db!.from("maintenance_items")
      .select("*")
      .eq("vehicle_id", vehicleId)
      .order("due_mileage", { ascending: true }),
    req
      .db!.from("recalls")
      .select("*")
      .eq("vehicle_id", vehicleId)
      .is("resolved_at", null)
      .order("reported_at", { ascending: false }),
    req
      .db!.from("providers")
      .select("id")
      .eq("is_preferred", true)
      .limit(1),
    req
      .db!.from("fuel_entries")
      .select("entry_date")
      .eq("vehicle_id", vehicleId)
      .order("entry_date", { ascending: false })
      .limit(1),
    req
      .db!.from("vehicle_tasks")
      .select("task_type")
      .eq("vehicle_id", vehicleId)
      // Only suppress recommendations once the agent has actually acted.
      // needs_user_approval / approved tasks should still surface so the
      // user can re-engage with one tap (idempotent dispatch flow handles
      // re-engagement on the backend).
      .in("status", ["in_progress", "waiting_on_provider"])
  ]);

  // Generate insights inline so the user always sees the freshest list.
  const lastShoppedAt = (insurance as any)?.last_shopped_at;
  const daysSinceLastInsuranceShop = lastShoppedAt
    ? Math.floor((Date.now() - new Date(lastShoppedAt).getTime()) / 86_400_000)
    : null;
  const lastFuelEntry = fuelRes.data?.[0]?.entry_date;
  const monthsSinceLastFuelEntry = lastFuelEntry
    ? Math.floor((Date.now() - new Date(lastFuelEntry).getTime()) / (30 * 86_400_000))
    : null;

  const insights = generateInsights({
    vehicle,
    costProfile,
    loanLease,
    insurance,
    maintenanceItems: (maintRes.data ?? []) as any,
    openRecallCount: (recallsRes.data ?? []).length,
    preferredServiceShopExists: (providersRes.data ?? []).length > 0,
    monthsSinceLastFuelEntry,
    daysSinceLastInsuranceShop,
    activeTaskTypes: new Set((activeTasksRes.data ?? []).map((t: any) => t.task_type))
  });
  const overallStatus = statusFromInsights(insights);

  // Drift-correct the cached overall_status whenever it differs from what the
  // engine computes right now. Cheap.
  if (vehicle.overall_status !== overallStatus) {
    await req
      .db!.from("vehicles")
      .update({ overall_status: overallStatus })
      .eq("id", vehicleId);
    vehicle.overall_status = overallStatus;
  }

  // Total estimated savings the user could capture from the recommended actions.
  const totalEstimatedSavings = insights.reduce(
    (sum, i) => sum + (i.estimated_savings_usd_per_year ?? 0),
    0
  );

  return res.json({
    vehicle,
    valuation: vehicle.market_value_low_cents
      ? {
          market_value_low_cents: vehicle.market_value_low_cents,
          market_value_high_cents: vehicle.market_value_high_cents,
          dealer_value_low_cents: vehicle.dealer_value_low_cents,
          dealer_value_high_cents: vehicle.dealer_value_high_cents,
          estimated_at: vehicle.value_estimated_at
        }
      : null,
    cost_profile: costProfile,
    loan_lease: loanLease,
    insurance,
    insights,
    open_recalls: recallsRes.data ?? [],
    maintenance_items: maintRes.data ?? [],
    recommended_action: insights[0] ?? null,
    total_estimated_annual_savings_usd: totalEstimatedSavings
  });
});

router.put("/api/vehicles/:id/cost-profile", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.id);
  const costs = calculateCosts(req.body);
  const { data, error } = await req
    .db!.from("vehicle_cost_profiles")
    .upsert(
      { user_id: req.user!.id, vehicle_id: vehicleId, ...costs },
      { onConflict: "vehicle_id" }
    )
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await audit({
    userId: req.user!.id,
    vehicleId,
    eventType: "cost_profile_updated",
    summary: "Cost profile recalculated"
  });
  return res.json({ cost_profile: data });
});

router.post("/api/vehicles/:id/alerts/regenerate", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.id);
  const vehicle = await one(
    req.db!.from("vehicles").select("*").eq("id", vehicleId)
  );
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

  const [costProfile, loanLease, insurance, maintRes] = await Promise.all([
    one(req.db!.from("vehicle_cost_profiles").select("*").eq("vehicle_id", vehicleId)),
    one(req.db!.from("loan_lease_accounts").select("*").eq("vehicle_id", vehicleId)),
    one(req.db!.from("insurance_accounts").select("*").eq("vehicle_id", vehicleId)),
    req.db!.from("maintenance_items").select("*").eq("vehicle_id", vehicleId)
  ]);
  const generated = generateAlerts({
    vehicle,
    costProfile,
    loanLease,
    insurance,
    maintenanceItems: (maintRes.data ?? []) as any
  });

  await req
    .db!.from("vehicle_alerts")
    .update({ is_resolved: true })
    .eq("vehicle_id", vehicleId)
    .eq("is_resolved", false);
  if (generated.length) {
    await req.db!.from("vehicle_alerts").insert(
      generated.map((alert) => ({
        user_id: req.user!.id,
        vehicle_id: vehicleId,
        ...alert
      }))
    );
  }
  await req
    .db!.from("vehicles")
    .update({ overall_status: statusFromAlerts(generated) })
    .eq("id", vehicleId);
  await audit({
    userId: req.user!.id,
    vehicleId,
    eventType: "alerts_regenerated",
    summary: "Vehicle alerts regenerated"
  });

  return res.json({ alerts: generated });
});

router.get("/api/alerts", async (req, res) => {
  const { data, error } = await req
    .db!.from("vehicle_alerts")
    .select("*")
    .eq("is_resolved", false)
    .order("created_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ alerts: data });
});

// ---------- Tasks ----------

router.get("/api/tasks", async (req, res) => {
  const { data, error } = await req
    .db!.from("vehicle_tasks")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ tasks: data });
});

router.post("/api/tasks", async (req, res) => {
  const payload = taskCreateSchema.parse(req.body);
  const { data, error } = await req
    .db!.from("vehicle_tasks")
    .insert({ user_id: req.user!.id, ...payload, status: "created" })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await audit({
    userId: req.user!.id,
    taskId: data.id,
    vehicleId: payload.vehicle_id,
    eventType: "task_created",
    summary: data.title
  });
  return res.status(201).json({ task: data });
});

router.post("/api/tasks/command", async (req, res) => {
  const payload = taskCommandSchema.parse(req.body);
  const mapped = taskFromCommand(payload.command);
  const { data, error } = await req
    .db!.from("vehicle_tasks")
    .insert({
      user_id: req.user!.id,
      vehicle_id: payload.vehicle_id,
      ...mapped,
      description: payload.command
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await audit({
    userId: req.user!.id,
    taskId: data.id,
    vehicleId: payload.vehicle_id,
    eventType: "command_to_task",
    summary: `Command converted to ${mapped.task_type}`
  });
  return res.status(201).json({ task: data });
});

router.post("/api/tasks/:id/approval", async (req, res) => {
  const taskId = z.string().uuid().parse(req.params.id);
  const payload = approvalSchema.parse(req.body);
  const status = payload.approved ? "approved" : "cancelled";
  const { data, error } = await req
    .db!.from("vehicle_tasks")
    .update({
      status,
      approved_at: payload.approved ? new Date().toISOString() : null
    })
    .eq("id", taskId)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await audit({
    userId: req.user!.id,
    taskId,
    vehicleId: data.vehicle_id,
    eventType: payload.approved ? "task_approved" : "task_cancelled",
    summary: payload.approved
      ? "Owner approved external action"
      : "Owner cancelled task"
  });
  return res.json({ task: data });
});

router.post("/api/tasks/:id/sms/approval-nudge", async (req, res) => {
  const taskId = z.string().uuid().parse(req.params.id);
  const [task, prefsResult, piiResult] = await Promise.all([
    one(req.db!.from("vehicle_tasks").select("*").eq("id", taskId)),
    req
      .db!.from("user_notification_preferences")
      .select("sms_enabled")
      .eq("user_id", req.user!.id)
      .maybeSingle(),
    req
      .db!.from("user_pii")
      .select("phone_encrypted")
      .eq("user_id", req.user!.id)
      .maybeSingle()
  ]);
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (prefsResult.error) return res.status(400).json({ error: prefsResult.error.message });
  if (piiResult.error) return res.status(400).json({ error: piiResult.error.message });
  if (!prefsResult.data?.sms_enabled) {
    return res.status(422).json({ error: "SMS is not enabled for this account." });
  }

  const phone = piiResult.data?.phone_encrypted
    ? decryptField(piiResult.data.phone_encrypted)
    : null;
  const normalizedPhone = normalizePhoneForSms(phone);
  if (!normalizedPhone) {
    return res.status(422).json({ error: "Add a valid SMS number before sending SMS nudges." });
  }

  const result = await sendSms({
    userId: req.user!.id,
    taskId,
    toPhone: normalizedPhone,
    body: taskApprovalSmsBody({
      taskTitle: task.title,
      appUrl: env.APP_URL
    })
  });

  await audit({
    userId: req.user!.id,
    taskId,
    vehicleId: task.vehicle_id,
    eventType: "sms_approval_nudge_sent",
    summary:
      result.status === "sent"
        ? "SMS approval nudge sent"
        : `SMS approval nudge ${result.status}`,
    metadata: { status: result.status, reason: result.reason ?? null }
  });

  if (result.status === "failed") {
    return res.status(502).json({ error: result.reason ?? "SMS send failed." });
  }
  if (result.status === "skipped") {
    return res.status(503).json({ error: result.reason ?? "SMS skipped." });
  }
  return res.json({ sent: true, provider_message_id: result.messageId ?? null });
});

router.post("/api/tasks/:id/emails", async (req, res) => {
  const taskId = z.string().uuid().parse(req.params.id);
  const body = emailSendSchema.parse(req.body);

  const task = await one(
    req.db!.from("vehicle_tasks").select("*").eq("id", taskId)
  );
  if (!task) return res.status(404).json({ error: "Task not found" });

  // Pro gate
  if (!(await isPro(req.user!.id))) {
    return res
      .status(402)
      .json({ error: "Automoteev Pro is required for provider email outreach." });
  }

  // Autonomy gate: during the "first N approvals" phase, the task must be
  // explicitly approved before each outbound send. After unlocking, the agent
  // can send on an in-progress task without per-email re-approval.
  const autonomy = await getAutonomyState(req.user!.id);
  if (autonomy.requires_approval_for_next_send && task.status !== "approved") {
    return res.status(409).json({
      error: "Task must be approved before email outreach (autonomy not yet unlocked).",
      autonomy
    });
  }

  const [profile, vehicle, provider] = await Promise.all([
    one(req.db!.from("profiles").select("*").eq("id", req.user!.id)),
    one(req.db!.from("vehicles").select("*").eq("id", task.vehicle_id)),
    one(req.db!.from("providers").select("*").eq("id", body.provider_id))
  ]);
  if (!profile || !vehicle || !provider?.email) {
    return res.status(400).json({ error: "Missing profile, vehicle, or provider email" });
  }
  if (!profile.agent_email_local) {
    return res.status(400).json({
      error:
        "Agent email alias not assigned. Re-run onboarding or call /api/agent/alias to resolve."
    });
  }

  const vehicleName =
    `${vehicle.year ?? ""} ${vehicle.make ?? ""} ${vehicle.model ?? ""}`.trim() ||
    "vehicle";
  const subject = taskEmailSubject(task.task_type as TaskType, vehicleName);
  const text = taskEmailBody({
    type: task.task_type as TaskType,
    userName: profile.full_name,
    vehicleName,
    vin: vehicle.vin,
    mileage: vehicle.mileage,
    notes: body.notes
  });

  const sent = await sendTaskEmail({
    to: provider.email,
    fromLocal: profile.agent_email_local,
    fromDisplayName: profile.full_name,
    subject,
    body: text
  });

  const { data: emailLog, error } = await req
    .db!.from("task_emails")
    .insert({
      user_id: req.user!.id,
      task_id: taskId,
      provider_id: provider.id,
      to_email: provider.email,
      from_email: sent.from,
      subject,
      body_text: text,
      status: sent.status,
      provider_message_id: sent.providerMessageId,
      direction: "outbound",
      thread_id: sent.providerMessageId ?? null
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  await req.db!.from("vehicle_tasks").update({ status: "waiting_on_provider" }).eq("id", taskId);

  // Count this as an approved send (will auto-unlock autonomy at threshold).
  // Use the task's category so per-category autonomy progresses correctly.
  const taskCategory = (task.category as any) ?? "general";
  const newAutonomy = await recordApprovedSend(req.user!.id, taskCategory);

  await audit({
    userId: req.user!.id,
    taskId,
    vehicleId: task.vehicle_id,
    eventType: "email_sent",
    summary: `Email sent to ${provider.name}`,
    metadata: { autonomy: newAutonomy }
  });

  return res.status(201).json({ email: emailLog, autonomy: newAutonomy });
});

router.get("/api/tasks/:id/history", async (req, res) => {
  const taskId = z.string().uuid().parse(req.params.id);
  const [emails, auditLogs] = await Promise.all([
    req
      .db!.from("task_emails")
      .select("*")
      .eq("task_id", taskId)
      .order("created_at", { ascending: false }),
    req
      .db!.from("task_audit_logs")
      .select("*")
      .eq("task_id", taskId)
      .order("created_at", { ascending: false })
  ]);
  return res.json({
    emails: emails.data ?? [],
    audit_logs: auditLogs.data ?? [],
    provider_responses: []
  });
});

// ---------- Providers ----------

router.get("/api/providers", async (req, res) => {
  const { data, error } = await req
    .db!.from("providers")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ providers: data });
});

router.post("/api/providers", async (req, res) => {
  const payload = providerSchema.parse(req.body);
  const { data, error } = await req
    .db!.from("providers")
    .insert({ user_id: req.user!.id, ...payload })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  return res.status(201).json({ provider: data });
});

router.post("/api/provider-search", async (req, res) => {
  const payload = providerSearchSchema.parse(req.body);
  const results = await searchProviders({
    providerType: payload.provider_type,
    zipCode: payload.zip_code,
    radiusMiles: payload.radius_miles
  });
  return res.json({ providers: results });
});

// ---------- Recalls ----------

router.post("/api/recalls/check/:vehicleId", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.vehicleId);
  const vehicle = await one(
    req.db!.from("vehicles").select("*").eq("id", vehicleId)
  );
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

  // VIN-specific lookup is the ONLY one we surface to users — model-year
  // lookups produce false positives that create anxiety for no reason.
  const result = await lookupRecallsByVin(vehicle.vin);

  // Dedupe-insert each campaign we don't already have on file.
  if (result.campaigns.length) {
    await req.db!.from("recalls").upsert(
      result.campaigns.map((c) => ({
        user_id: req.user!.id,
        vehicle_id: vehicleId,
        nhtsa_campaign_id: c.nhtsa_campaign_id,
        summary: c.summary,
        component: c.component,
        consequence: c.consequence,
        remedy: c.remedy,
        reported_at: c.reported_at
      })),
      { onConflict: "vehicle_id,nhtsa_campaign_id", ignoreDuplicates: true }
    );
  } else {
    // No open recalls per NHTSA — mark any prior rows as resolved.
    await req
      .db!.from("recalls")
      .update({ resolved_at: new Date().toISOString() })
      .eq("vehicle_id", vehicleId)
      .is("resolved_at", null);
  }

  await req
    .db!.from("vehicles")
    .update({
      recall_status: result.hasOpenRecall ? "open" : "clear",
      last_recall_check_at: new Date().toISOString()
    })
    .eq("id", vehicleId);

  const { data: task } = await req
    .db!.from("vehicle_tasks")
    .insert({
      user_id: req.user!.id,
      vehicle_id: vehicleId,
      task_type: "recall_check",
      title: "Recall check",
      status: "completed",
      description: result.summary
    })
    .select()
    .single();

  await audit({
    userId: req.user!.id,
    taskId: task?.id,
    vehicleId,
    eventType: "recall_checked",
    summary: result.summary
  });

  return res.json({ recall: result, task });
});

router.get("/api/recalls/:vehicleId/list", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.vehicleId);
  const { data, error } = await req
    .db!.from("recalls")
    .select("*")
    .eq("vehicle_id", vehicleId)
    .order("reported_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ recalls: data ?? [] });
});

// ---------- Home (the "Needs me" + "Agent working" + savings shape) ----------

/**
 * The new home endpoint. Returns exactly the three sections the redesigned
 * home screen renders, in the shape the UI expects. Keeps the frontend
 * simple — one fetch, one render, no client-side composition.
 *
 * Contract:
 *   pending_actions: items the user MUST decide on. Each is one card.
 *   agent_working:   campaigns the agent is autonomously working on. One line each.
 *   summary:         monthly cost, savings captured, savings still on the table.
 */
router.get("/api/home", async (req, res) => {
  const userId = req.user!.id;

  // Pick the user's primary vehicle (most recently created) to scope the
  // savings figures. If there are zero vehicles the home is essentially
  // empty and the frontend redirects to onboarding anyway.
  const { data: vehicleRow } = await req
    .db!.from("vehicles")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!vehicleRow) {
    return res.json({ pending_actions: [], agent_working: [], summary: null });
  }
  const vehicle = vehicleRow as any;

  // -------- Pending actions: explicit pending_user_action_kind on tasks --
  // Plus a few synthetic ones derived from state we don't yet store as
  // explicit pending actions (e.g. open recalls that were just discovered).
  const { data: explicitPendingTasks } = await req
    .db!.from("vehicle_tasks")
    .select("*")
    .eq("user_id", userId)
    .not("pending_user_action_kind", "is", null)
    .order("pending_user_action_set_at", { ascending: false });

  const pendingActions = (explicitPendingTasks ?? []).map((t: any) => ({
    task_id: t.id,
    vehicle_id: t.vehicle_id,
    kind: t.pending_user_action_kind,
    title: t.pending_user_action_text ?? t.title,
    body: t.description ?? null,
    options: (t.pending_user_action_options as any) ?? null,
    set_at: t.pending_user_action_set_at,
    category: t.category ?? null,
    task_type: t.task_type
  }));

  // Synthetic pending actions — things that need the user but don't yet have
  // a real campaign. Most importantly: "approve dispatch" for new urgent
  // insights like an open recall just discovered. These appear as cards too.
  const [costProfile, loanLease, insurance, maintRes, recallsRes, providersRes, fuelRes, activeTasksRes] =
    await Promise.all([
      one(req.db!.from("vehicle_cost_profiles").select("*").eq("vehicle_id", vehicle.id)),
      one(req.db!.from("loan_lease_accounts").select("*").eq("vehicle_id", vehicle.id)),
      one(req.db!.from("insurance_accounts").select("*").eq("vehicle_id", vehicle.id)),
      req.db!.from("maintenance_items").select("*").eq("vehicle_id", vehicle.id),
      req.db!.from("recalls").select("*").eq("vehicle_id", vehicle.id).is("resolved_at", null),
      req.db!.from("providers").select("id").eq("is_preferred", true).limit(1),
      req
        .db!.from("fuel_entries")
        .select("entry_date")
        .eq("vehicle_id", vehicle.id)
        .order("entry_date", { ascending: false })
        .limit(1),
      req
        .db!.from("vehicle_tasks")
        .select("task_type, status")
        .eq("vehicle_id", vehicle.id)
        .in("status", ["in_progress", "waiting_on_provider", "approved", "needs_user_approval"])
    ]);

  const lastShoppedAt = (insurance as any)?.last_shopped_at;
  const lastFuelEntry = fuelRes.data?.[0]?.entry_date;

  const insights = generateInsights({
    vehicle,
    costProfile,
    loanLease,
    insurance,
    maintenanceItems: (maintRes.data ?? []) as any,
    openRecallCount: (recallsRes.data ?? []).length,
    preferredServiceShopExists: (providersRes.data ?? []).length > 0,
    monthsSinceLastFuelEntry: lastFuelEntry
      ? Math.floor((Date.now() - new Date(lastFuelEntry).getTime()) / (30 * 86_400_000))
      : null,
    daysSinceLastInsuranceShop: lastShoppedAt
      ? Math.floor((Date.now() - new Date(lastShoppedAt).getTime()) / 86_400_000)
      : null,
    activeTaskTypes: new Set((activeTasksRes.data ?? []).map((t: any) => t.task_type))
  });

  // Filter out insights the user has dismissed ("Not now") within the
  // active TTL. Real tasks already have a status-based filter elsewhere;
  // this only affects synthetic recommendation cards that haven't yet
  // been turned into tasks. Dismissed entries auto-expire at
  // dismissed_until so cards re-surface after the snooze.
  const { data: activeDismissals } = await req
    .db!.from("dismissed_insights")
    .select("insight_key")
    .eq("user_id", userId)
    .eq("vehicle_id", vehicle.id)
    .gt("dismissed_until", new Date().toISOString());
  const dismissedKeys = new Set(
    (activeDismissals ?? []).map((d: any) => d.insight_key)
  );
  const visibleInsights = insights.filter((i) => !dismissedKeys.has(i.key));

  // Promote ONLY urgent insights to synthetic pending actions — recommended/
  // info-level live in a separate "savings on the table" panel below the
  // home stack. Skip insights that already have an explicit pending action
  // (so we don't double-stack).
  const syntheticPending = visibleInsights
    .filter((i) => i.severity === "urgent")
    .map((i) => ({
      task_id: null as string | null,
      vehicle_id: vehicle.id,
      kind: "decision" as const,
      title: i.title,
      body: i.body,
      options: null,
      set_at: null,
      category: i.category,
      task_type: (i.action as any).task_type ?? null,
      synthetic: true,
      insight_key: i.key,
      cta_label: i.cta_label
    }));

  // ---- needs_user_approval tasks ----
  // Tasks waiting on the user to approve dispatch (e.g. "Get refinance quotes"
  // created from a recommendation but not yet approved). These belong on the
  // home stack because they literally need the user. Skip ones whose task_type
  // is already represented as a synthetic insight to avoid double-stacking.
  const syntheticTaskTypes = new Set(
    syntheticPending.map((s) => s.task_type).filter(Boolean) as string[]
  );
  const explicitTaskIds = new Set(pendingActions.map((p) => p.task_id));
  const { data: approvalTasks } = await req
    .db!.from("vehicle_tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "needs_user_approval")
    .order("created_at", { ascending: false });
  const approvalPending = (approvalTasks ?? [])
    .filter((t: any) => !explicitTaskIds.has(t.id) && !syntheticTaskTypes.has(t.task_type))
    .map((t: any) => ({
      task_id: t.id,
      vehicle_id: t.vehicle_id,
      kind: "approval" as const,
      title: t.title,
      body: t.approval_summary ?? t.description ?? null,
      options: null,
      set_at: t.created_at,
      category: t.category ?? null,
      task_type: t.task_type,
      cta_label: "Approve & contact providers"
    }));

  // ---- Renewal cards ----
  // Pull due-soon and expired renewable items, render as cards on the
  // Home Needs You stack. Same dismissed-insights filter applies via the
  // insight_key prefix `renewal:<id>`. Renewals slot in AFTER explicit
  // pending actions and approval-required tasks (those are time-critical
  // by definition) but BEFORE pure recommendation insights, since a
  // missed renewal is more damaging than a missed savings opportunity.
  const renewalCards = await getRenewalCardsForHome(userId);
  const visibleRenewalCards = renewalCards.filter(
    (c) => !dismissedKeys.has(c.insight_key)
  );
  // Insert before approvalPending so renewals get badge priority over
  // dispatch-approval reminders that aren't time-critical.
  const allPendingWithRenewals = [
    ...pendingActions,
    ...syntheticPending,
    ...visibleRenewalCards,
    ...approvalPending
  ];

  // -------- Agent working: tasks with no pending action that the agent is on --
  const { data: agentWorkingTasks } = await req
    .db!.from("vehicle_tasks")
    .select("id, title, task_type, status, agent_status_text, updated_at, created_at")
    .eq("user_id", userId)
    .in("status", ["in_progress", "waiting_on_provider", "approved"])
    .is("pending_user_action_kind", null)
    .order("created_at", { ascending: false });

  const agentWorking = (agentWorkingTasks ?? []).map((t: any) => ({
    task_id: t.id,
    title: t.title,
    task_type: t.task_type,
    status: t.status,
    status_text: t.agent_status_text ?? defaultAgentStatusText(t.task_type, t.status),
    icon_kind: iconKindForTaskType(t.task_type)
  }));

  // -------- Summary: monthly cost + savings captured + savings on the table --
  const monthlyCostCents =
    (costProfile as any)?.total_monthly_cost_cents ?? null;
  const savingsOnTheTableUsd = insights
    .filter((i) => i.severity !== "info")
    .reduce((sum, i) => sum + (i.estimated_savings_usd_per_year ?? 0), 0);

  // Savings captured: sum of completed tasks that recorded savings. This is
  // a placeholder until we track real captured savings on task completion.
  const { data: capturedSavingsRows } = await req
    .db!.from("vehicle_tasks")
    .select("metadata")
    .eq("user_id", userId)
    .eq("status", "completed");
  const savingsCapturedUsd = (capturedSavingsRows ?? []).reduce((sum: number, t: any) => {
    const v = (t.metadata as any)?.captured_savings_usd_per_year;
    return sum + (typeof v === "number" ? v : 0);
  }, 0);

  return res.json({
    pending_actions: allPendingWithRenewals,
    agent_working: agentWorking,
    // Recommended/info insights live here — secondary, not on the main stack.
    secondary_recommendations: visibleInsights.filter((i) => i.severity !== "urgent"),
    summary: {
      vehicle: {
        id: vehicle.id,
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        vin: vehicle.vin,
        mileage: vehicle.mileage
      },
      monthly_cost_cents: monthlyCostCents,
      savings_captured_usd_per_year: Math.round(savingsCapturedUsd),
      savings_on_the_table_usd_per_year: Math.round(savingsOnTheTableUsd)
    }
  });
});

function defaultAgentStatusText(taskType: string, status: string): string {
  const verb = status === "waiting_on_provider" ? "waiting for reply" : "working";
  switch (taskType) {
    case "recall_repair":
    case "recall_appointment":
      return `Recall outreach — ${verb}`;
    case "insurance_quote":
      return `Insurance shopping — ${verb}`;
    case "refinance":
      return `Refinance quotes — ${verb}`;
    case "sell_vehicle":
      return `Vehicle sale — ${verb}`;
    case "service_quote":
      return `Service quotes — ${verb}`;
    default:
      return `${taskType.replaceAll("_", " ")} — ${verb}`;
  }
}

function iconKindForTaskType(taskType: string): string {
  switch (taskType) {
    case "recall_repair":
    case "recall_appointment":
      return "recall";
    case "insurance_quote":
      return "insurance";
    case "refinance":
    case "payoff_quote":
      return "lending";
    case "sell_vehicle":
      return "sale";
    case "service_quote":
      return "service";
    default:
      return "general";
  }
}

/**
 * Per-thread timeline. Returns the union of task_emails + thread_events for
 * a given task, sorted chronologically. This is what powers the campaign
 * detail view (and replaces the current History expand-row).
 */
router.get("/api/threads/:taskId", async (req, res) => {
  const taskId = z.string().uuid().parse(req.params.taskId);
  const task = await one(req.db!.from("vehicle_tasks").select("*").eq("id", taskId));
  if (!task) return res.status(404).json({ error: "Task not found" });

  const [emailsRes, eventsRes] = await Promise.all([
    req
      .db!.from("task_emails")
      .select("*")
      .eq("task_id", taskId)
      .order("created_at", { ascending: true }),
    req
      .db!.from("thread_events")
      .select("*")
      .eq("task_id", taskId)
      .order("created_at", { ascending: true })
  ]);

  // Merge into a single timeline. Each item carries its own `kind` so the UI
  // can render the right icon and layout.
  const items = [
    ...(emailsRes.data ?? []).map((e: any) => ({
      kind: e.direction === "outbound" ? "email_out" : "email_in",
      at: e.created_at,
      data: e
    })),
    ...(eventsRes.data ?? []).map((ev: any) => ({
      kind: ev.kind,
      at: ev.created_at,
      data: ev
    }))
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return res.json({ task, items });
});

/**
 * Answer a pending user action. Clears the pending fields so the campaign
 * leaves the home screen and writes a thread_event capturing what the user
 * decided. The actual side-effect (email reply, document approval, signature)
 * is handled by the specific endpoint the option's `next` field points at —
 * this endpoint's job is just to record the answer and unblock the timeline.
 */
router.post("/api/needs-me/:taskId/answer", async (req, res) => {
  const taskId = z.string().uuid().parse(req.params.taskId);
  const schema = z.object({
    option_id: z.string().min(1),
    note: z.string().optional().nullable()
  });
  const { option_id, note } = schema.parse(req.body ?? {});

  const task = await one(req.db!.from("vehicle_tasks").select("*").eq("id", taskId));
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!(task as any).pending_user_action_kind) {
    return res.status(409).json({ error: "Task has no pending user action" });
  }

  // Clear the pending action so the card leaves the home screen.
  await req
    .db!.from("vehicle_tasks")
    .update({
      pending_user_action_kind: null,
      pending_user_action_text: null,
      pending_user_action_options: null,
      pending_user_action_set_at: null
    })
    .eq("id", taskId);

  // Record the user's answer in the thread for posterity.
  await req.db!.from("thread_events").insert({
    user_id: req.user!.id,
    task_id: taskId,
    kind: "user_decision",
    summary: `User chose: ${option_id}`,
    detail: note ?? null,
    metadata: { option_id, note }
  });

  await audit({
    userId: req.user!.id,
    taskId,
    vehicleId: (task as any).vehicle_id,
    eventType: "user_answered_pending",
    summary: `User chose: ${option_id}`
  });

  return res.json({ ok: true });
});

// ---------- Maintenance ----------

router.get("/api/maintenance/:vehicleId", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.vehicleId);
  const [vehicle, itemsRes] = await Promise.all([
    one(req.db!.from("vehicles").select("*").eq("id", vehicleId)),
    req
      .db!.from("maintenance_items")
      .select("*")
      .eq("vehicle_id", vehicleId)
      .order("due_mileage", { ascending: true })
  ]);
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });
  const items = (itemsRes.data ?? []) as any[];
  const summary = maintenanceDue(vehicle, items);
  return res.json({ summary, items });
});

router.post("/api/maintenance/:vehicleId/seed", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.vehicleId);
  const vehicle = await one(
    req.db!.from("vehicles").select("*").eq("id", vehicleId)
  );
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

  const seeds = seedMaintenanceItems({
    userId: req.user!.id,
    vehicleId,
    currentMileage: vehicle.mileage,
    year: vehicle.year,
    state: null
  });
  if (seeds.length) {
    await req.db!.from("maintenance_items").insert(seeds);
  }
  return res.json({ seeded: seeds.length });
});

router.put("/api/maintenance/items/:id", async (req, res) => {
  const itemId = z.string().uuid().parse(req.params.id);
  const update = z
    .object({
      status: z.enum(["upcoming", "due", "overdue", "completed", "skipped"]).optional(),
      last_performed_mileage: z.number().int().nonnegative().nullable().optional(),
      last_performed_date: z.string().nullable().optional(),
      due_mileage: z.number().int().nonnegative().nullable().optional(),
      due_date: z.string().nullable().optional(),
      estimated_cost_cents: z.number().int().nonnegative().nullable().optional()
    })
    .parse(req.body);
  const { data, error } = await req
    .db!.from("maintenance_items")
    .update(update)
    .eq("id", itemId)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ item: data });
});

// ---------- Insurance / Loan ----------

router.put("/api/insurance/:vehicleId", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.vehicleId);
  const payload = insuranceUpdateSchema.parse(req.body);
  const row: Record<string, unknown> = {
    user_id: req.user!.id,
    vehicle_id: vehicleId,
    carrier_name: payload.carrier_name ?? null,
    premium_cents: payload.premium_cents ?? null,
    renewal_date: payload.renewal_date ?? null,
    coverage_type: payload.coverage_type ?? null,
    deductible_cents: payload.deductible_cents ?? null,
    liability_limits: payload.liability_limits ?? null
  };
  if (payload.policy_number) {
    row.policy_number_encrypted = encryptField(payload.policy_number);
  }
  const { data, error } = await req
    .db!.from("insurance_accounts")
    .upsert(row, { onConflict: "vehicle_id" })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  if (payload.premium_cents != null) {
    await markFieldCompleted(req.user!.id, "insurance_premium");
  }
  if (payload.renewal_date != null) {
    await markFieldCompleted(req.user!.id, "insurance_renewal");
  }
  if (payload.coverage_type != null) {
    await markFieldCompleted(req.user!.id, "insurance_coverage");
  }

  return res.json({ insurance: data });
});

router.put("/api/loan-lease/:vehicleId", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.vehicleId);
  const payload = loanLeaseUpdateSchema.parse(req.body);
  const { data, error } = await req
    .db!.from("loan_lease_accounts")
    .upsert(
      { user_id: req.user!.id, vehicle_id: vehicleId, ...payload },
      { onConflict: "vehicle_id" }
    )
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  if (payload.monthly_payment_cents != null) {
    await markFieldCompleted(req.user!.id, "monthly_payment");
  }
  if (payload.balance_cents != null) {
    await markFieldCompleted(req.user!.id, "loan_balance");
  }
  if (payload.apr_bps != null) {
    await markFieldCompleted(req.user!.id, "loan_apr");
  }
  if (payload.start_date != null) {
    await markFieldCompleted(req.user!.id, "loan_start_date");
  }
  if (payload.term_months != null) {
    await markFieldCompleted(req.user!.id, "loan_term_months");
  }

  return res.json({ loan_lease: data });
});

// ---------- PII (just-in-time DL, phone, address) ----------

router.get("/api/pii", async (req, res) => {
  const { data, error } = await req
    .db!.from("user_pii")
    .select("*")
    .eq("user_id", req.user!.id)
    .maybeSingle();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({
    pii: data
      ? {
          phone: decryptField(data.phone_encrypted) ?? null,
          street_address: decryptField(data.street_address_encrypted) ?? null,
          city: data.city,
          state: data.state,
          dl_number: decryptField(data.dl_number_encrypted) ?? null,
          dl_state: data.dl_state,
          dl_collected_at: data.dl_collected_at,
          dl_expires_at: data.dl_expires_at ?? null,
          dl_issued_date: data.dl_issued_date ?? null
        }
      : null
  });
});

router.put("/api/pii", async (req, res) => {
  const payload = piiUpdateSchema.parse(req.body);
  const row: Record<string, unknown> = { user_id: req.user!.id };
  if (payload.phone !== undefined) row.phone_encrypted = payload.phone ? encryptField(payload.phone) : null;
  if (payload.street_address !== undefined)
    row.street_address_encrypted = payload.street_address
      ? encryptField(payload.street_address)
      : null;
  if (payload.city !== undefined) row.city = payload.city;
  if (payload.state !== undefined) row.state = payload.state;
  if (payload.dl_number !== undefined) {
    row.dl_number_encrypted = payload.dl_number ? encryptField(payload.dl_number) : null;
    row.dl_collected_at = payload.dl_number ? new Date().toISOString() : null;
  }
  if (payload.dl_state !== undefined) row.dl_state = payload.dl_state;
  // Structured DL date columns. Pass-through YYYY-MM-DD strings; Postgres
  // date columns store them natively without timezone shenanigans.
  if (payload.dl_expires_at !== undefined) row.dl_expires_at = payload.dl_expires_at;
  if (payload.dl_issued_date !== undefined) row.dl_issued_date = payload.dl_issued_date;

  const { data, error } = await req
    .db!.from("user_pii")
    .upsert(row, { onConflict: "user_id" })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  if (payload.phone) await markFieldCompleted(req.user!.id, "phone");
  if (payload.street_address) await markFieldCompleted(req.user!.id, "street_address");
  if (payload.dl_number) await markFieldCompleted(req.user!.id, "drivers_license");

  await audit({
    userId: req.user!.id,
    eventType: "pii_updated",
    summary: "User PII updated"
  });

  return res.json({ pii: { user_id: data.user_id, dl_collected_at: data.dl_collected_at } });
});

// ---------- Notification preferences (app/email/SMS) ----------

router.get("/api/notification-preferences", async (req, res) => {
  const [prefsResult, piiResult] = await Promise.all([
    req
      .db!.from("user_notification_preferences")
      .select("*")
      .eq("user_id", req.user!.id)
      .maybeSingle(),
    req
      .db!.from("user_pii")
      .select("phone_encrypted")
      .eq("user_id", req.user!.id)
      .maybeSingle()
  ]);
  if (prefsResult.error) return res.status(400).json({ error: prefsResult.error.message });
  if (piiResult.error) return res.status(400).json({ error: piiResult.error.message });

  const phone = piiResult.data?.phone_encrypted
    ? decryptField(piiResult.data.phone_encrypted)
    : null;
  const normalizedPhone = normalizePhoneForSms(phone);
  return res.json({
    preferences: prefsResult.data ?? {
      sms_enabled: false,
      email_enabled: true,
      push_enabled: true
    },
    phone,
    phone_valid_for_sms: Boolean(normalizedPhone),
    sms: getSmsConfigStatus()
  });
});

router.put("/api/notification-preferences", async (req, res) => {
  const payload = notificationPreferencesSchema.parse(req.body);

  if (payload.phone !== undefined) {
    await req
      .db!.from("user_pii")
      .upsert(
        {
          user_id: req.user!.id,
          phone_encrypted: payload.phone ? encryptField(payload.phone) : null
        },
        { onConflict: "user_id" }
      );
    if (payload.phone) await markFieldCompleted(req.user!.id, "phone");
  }

  const row: Record<string, unknown> = { user_id: req.user!.id };
  if (payload.sms_enabled !== undefined) row.sms_enabled = payload.sms_enabled;
  if (payload.email_enabled !== undefined) row.email_enabled = payload.email_enabled;
  if (payload.push_enabled !== undefined) row.push_enabled = payload.push_enabled;

  const { data, error } = await req
    .db!.from("user_notification_preferences")
    .upsert(row, { onConflict: "user_id" })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  await audit({
    userId: req.user!.id,
    eventType: "notification_preferences_updated",
    summary: "Notification preferences updated",
    metadata: {
      sms_enabled: data.sms_enabled,
      email_enabled: data.email_enabled,
      push_enabled: data.push_enabled
    }
  });

  const phone = payload.phone !== undefined ? payload.phone : null;
  return res.json({
    preferences: data,
    phone_valid_for_sms: payload.phone === undefined ? null : Boolean(normalizePhoneForSms(phone)),
    sms: getSmsConfigStatus()
  });
});

router.post("/api/sms/test", async (req, res) => {
  const [prefsResult, piiResult] = await Promise.all([
    req
      .db!.from("user_notification_preferences")
      .select("sms_enabled")
      .eq("user_id", req.user!.id)
      .maybeSingle(),
    req
      .db!.from("user_pii")
      .select("phone_encrypted")
      .eq("user_id", req.user!.id)
      .maybeSingle()
  ]);
  if (prefsResult.error) return res.status(400).json({ error: prefsResult.error.message });
  if (piiResult.error) return res.status(400).json({ error: piiResult.error.message });
  if (!prefsResult.data?.sms_enabled) {
    return res.status(422).json({ error: "Turn on SMS before sending a test." });
  }

  const phone = piiResult.data?.phone_encrypted
    ? decryptField(piiResult.data.phone_encrypted)
    : null;
  const normalizedPhone = normalizePhoneForSms(phone);
  if (!normalizedPhone) {
    return res.status(422).json({ error: "Add a valid SMS number before sending a test." });
  }

  const result = await sendSms({
    userId: req.user!.id,
    toPhone: normalizedPhone,
    body: "Automoteev test SMS. Your approval alerts are ready."
  });

  await audit({
    userId: req.user!.id,
    eventType: "sms_test_sent",
    summary:
      result.status === "sent"
        ? "Test SMS sent"
        : `Test SMS ${result.status}`,
    metadata: { status: result.status, reason: result.reason ?? null }
  });

  if (result.status === "failed") {
    return res.status(502).json({ error: result.reason ?? "SMS send failed." });
  }
  if (result.status === "skipped") {
    return res.status(503).json({ error: result.reason ?? "SMS skipped." });
  }
  return res.json({ sent: true, provider_message_id: result.messageId ?? null });
});

// ---------- Plaid bank connection + Transactions Sync ----------

router.get("/api/plaid/status", async (req, res) => {
  const { data, error } = await req
    .db!.from("plaid_items")
    .select("id, institution_name, status, last_synced_at, created_at")
    .eq("user_id", req.user!.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({
    plaid: getPlaidConfigStatus(),
    items: data ?? []
  });
});

router.post("/api/plaid/link-token", async (req, res) => {
  const result = await createPlaidLinkToken({
    userId: req.user!.id,
    userEmail: req.user!.email ?? null
  });
  return res.json(result);
});

router.post("/api/plaid/exchange", async (req, res) => {
  const body = z.object({ public_token: z.string().min(1) }).parse(req.body);
  const exchange = await exchangePlaidPublicToken(body.public_token);
  const item = await getPlaidItem(exchange.access_token);
  const institution = await getPlaidInstitution(item.item.institution_id);

  const { data: plaidItem, error } = await req
    .db!.from("plaid_items")
    .upsert(
      {
        user_id: req.user!.id,
        plaid_item_id: exchange.item_id,
        access_token_encrypted: encryptField(exchange.access_token),
        institution_id: item.item.institution_id,
        institution_name: institution?.institution.name ?? null,
        products: item.item.products ?? [],
        status: "active",
        error_code: null,
        error_message: null
      },
      { onConflict: "plaid_item_id" }
    )
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  const accounts = await importPlaidAccounts({
    userId: req.user!.id,
    plaidItemId: plaidItem.id,
    accessToken: exchange.access_token
  });

  await audit({
    userId: req.user!.id,
    eventType: "plaid_item_connected",
    summary: "Bank account connected with Plaid",
    metadata: {
      plaid_item_id: exchange.item_id,
      institution_name: plaidItem.institution_name,
      account_count: accounts.length
    }
  });

  return res.status(201).json({ item: redactPlaidItem(plaidItem), accounts });
});

router.post("/api/plaid/items/:id/sync", async (req, res) => {
  const plaidItemId = z.string().uuid().parse(req.params.id);
  const item = await one(
    req.db!.from("plaid_items").select("*").eq("id", plaidItemId).eq("user_id", req.user!.id)
  );
  if (!item) return res.status(404).json({ error: "Plaid item not found." });
  const accessToken = decryptField((item as any).access_token_encrypted);
  if (!accessToken) return res.status(500).json({ error: "Plaid access token could not be decrypted." });

  const result = await syncPlaidTransactions({
    accessToken,
    cursor: (item as any).transactions_cursor ?? null
  });
  await upsertPlaidTransactions({
    userId: req.user!.id,
    plaidItemId,
    added: result.added,
    modified: result.modified,
    removed: result.removed
  });

  await req
    .db!.from("plaid_items")
    .update({
      transactions_cursor: result.next_cursor,
      last_synced_at: new Date().toISOString(),
      status: "active",
      error_code: null,
      error_message: null
    })
    .eq("id", plaidItemId)
    .eq("user_id", req.user!.id);

  // Run the classifier on the newly added/modified transactions so the
  // Home Needs You stack reflects the freshest signals as soon as the
  // sync completes. We scope by transactionIds rather than re-classifying
  // everything — keeps cost bounded for users with thousands of rows.
  let classified = 0;
  const newPlaidIds = [
    ...result.added.map((t) => t.transaction_id),
    ...result.modified.map((t) => t.transaction_id)
  ];
  if (newPlaidIds.length > 0) {
    const { data: ourRows } = await supabaseAdmin
      .from("plaid_transactions")
      .select("id")
      .eq("user_id", req.user!.id)
      .in("plaid_transaction_id", newPlaidIds);
    const ourIds = ((ourRows ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ourIds.length > 0) {
      const out = await classifyTransactionsForUser({
        userId: req.user!.id,
        transactionIds: ourIds
      });
      classified = out.classified;
    }
  }

  await audit({
    userId: req.user!.id,
    eventType: "plaid_transactions_synced",
    summary: "Plaid transactions synced",
    metadata: {
      item_id: plaidItemId,
      added: result.added.length,
      modified: result.modified.length,
      removed: result.removed.length,
      classified
    }
  });

  return res.json({
    added: result.added.length,
    modified: result.modified.length,
    removed: result.removed.length,
    classified
  });
});

// ---------- Plaid transaction classifications ----------
//
// The classifier (apps/api/src/services/transaction-classifier.ts) runs
// automatically after every sync and writes one row per detected
// vehicle-relevant transaction. These endpoints let the UI:
//   - list the pending classifications (the Needs You stack on Home)
//   - confirm a classification (and for fuel, mint a fuel_entries row
//     with the amount/date pulled from the transaction)
//   - dismiss a misclassification so we stop showing it
//   - re-run the classifier (e.g. after the user adds their insurance
//     carrier so the carrier-boost rules fire)

/**
 * List the user's classifications, optionally filtered. Default sort is
 * newest-first by transaction date. The transaction is joined inline so
 * the UI has merchant/amount/date without a second roundtrip.
 *
 * Query params:
 *   ?status=pending|confirmed|dismissed|any   (default: pending)
 *   ?class=fuel,insurance,...                  (CSV, optional)
 *   ?limit=N                                   (default: 50, max 200)
 */
router.get("/api/plaid/classifications", async (req, res) => {
  const status =
    typeof req.query.status === "string"
      ? req.query.status
      : "pending";
  const classesParam =
    typeof req.query.class === "string" ? req.query.class : null;
  const allowedClasses = new Set([
    "fuel",
    "insurance",
    "lender",
    "service",
    "parts",
    "registration",
    "parking_toll",
    "subscription"
  ]);
  const classes = classesParam
    ? classesParam
        .split(",")
        .map((c) => c.trim())
        .filter((c) => allowedClasses.has(c))
    : null;
  const limit = Math.max(
    1,
    Math.min(200, Number(req.query.limit ?? 50) || 50)
  );

  let query = req
    .db!.from("plaid_transaction_classifications")
    .select(
      "id, plaid_transaction_id, vehicle_id, class, confidence, reason, matched_provider_name, is_recurring, confirmed_at, dismissed_at, fuel_entry_id, metadata, created_at, plaid_transactions(id, name, merchant_name, amount_cents, date, category)"
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status === "pending") {
    query = query.is("confirmed_at", null).is("dismissed_at", null);
  } else if (status === "confirmed") {
    query = query.not("confirmed_at", "is", null);
  } else if (status === "dismissed") {
    query = query.not("dismissed_at", "is", null);
  }
  if (classes && classes.length > 0) {
    query = query.in("class", classes);
  }

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });

  // Flatten the joined transaction onto each row so the UI doesn't have to
  // dig through Supabase's nested representation.
  const rows = ((data ?? []) as any[]).map((row) => {
    const txn = (row.plaid_transactions ?? {}) as any;
    return {
      id: row.id,
      plaid_transaction_id: row.plaid_transaction_id,
      vehicle_id: row.vehicle_id,
      class: row.class,
      confidence: Number(row.confidence ?? 0),
      reason: row.reason,
      matched_provider_name: row.matched_provider_name,
      is_recurring: Boolean(row.is_recurring),
      confirmed_at: row.confirmed_at,
      dismissed_at: row.dismissed_at,
      fuel_entry_id: row.fuel_entry_id,
      created_at: row.created_at,
      transaction: {
        id: txn.id ?? null,
        name: txn.name ?? null,
        merchant_name: txn.merchant_name ?? null,
        amount_cents: txn.amount_cents ?? null,
        date: txn.date ?? null,
        category: txn.category ?? null
      }
    };
  });

  return res.json({ classifications: rows, total: rows.length });
});

/**
 * Confirm a classification. Side-effects depend on the class:
 *   fuel        — mints a fuel_entries row (entry_date = txn date,
 *                 total_cents = txn amount) and stashes the fuel_entry_id
 *                 on the classification so we can show "already logged"
 *                 next time. Caller may pass override fields (mileage,
 *                 gallons) to enrich the fuel entry.
 *   insurance   — touches insurance_accounts.last_seen_charge_at via
 *                 metadata (no schema change in this commit; tracked for
 *                 a future renewal-detection insight).
 *   lender      — same: metadata-only confirmation.
 *   service     — inserts a vehicle_events row tagged service_charge.
 *   parts       — same: vehicle_events tagged parts_purchase.
 *   subscription— doesn't auto-create a renewable_item (we don't know
 *                 the cadence yet); the UI nudges the user to add one.
 *
 * All branches write a task_audit_logs entry. Failures partway through
 * still mark the row confirmed_at so the user doesn't keep seeing it.
 */
router.post("/api/plaid/classifications/:id/confirm", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const schema = z
    .object({
      mileage: z.number().int().nonnegative().optional(),
      gallons: z.number().nonnegative().optional(),
      notes: z.string().max(500).optional(),
      // Override vehicle_id (defaults to the classification's vehicle_id).
      vehicle_id: z.string().uuid().optional()
    })
    .optional();
  const payload = schema.parse(req.body ?? {}) ?? {};

  // RLS-scoped read — user must own the classification.
  const { data: row } = await req
    .db!.from("plaid_transaction_classifications")
    .select(
      "id, vehicle_id, class, confirmed_at, dismissed_at, fuel_entry_id, plaid_transaction_id, plaid_transactions(id, name, merchant_name, amount_cents, date)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!row) return res.status(404).json({ error: "Not found" });
  if ((row as any).confirmed_at) {
    return res.status(200).json({ ok: true, already_confirmed: true });
  }
  if ((row as any).dismissed_at) {
    return res.status(409).json({ error: "Already dismissed — cannot confirm." });
  }

  const txn = ((row as any).plaid_transactions ?? {}) as {
    id: string;
    name: string;
    merchant_name: string | null;
    amount_cents: number;
    date: string;
  };
  const klass = (row as any).class as string;
  const vehicleId = payload.vehicle_id ?? (row as any).vehicle_id ?? null;

  let fuelEntryId: string | null = (row as any).fuel_entry_id ?? null;
  let sideEffectSummary = "";

  if (klass === "fuel" && vehicleId && !fuelEntryId) {
    const { data: entry, error: entryErr } = await req
      .db!.from("fuel_entries")
      .insert({
        user_id: req.user!.id,
        vehicle_id: vehicleId,
        entry_date: txn.date,
        total_cents: txn.amount_cents,
        gallons: payload.gallons ?? null,
        odometer_miles: payload.mileage ?? null,
        notes:
          payload.notes ??
          `Auto-logged from Plaid charge: ${txn.merchant_name ?? txn.name}`
      })
      .select()
      .single();
    if (entryErr) {
      return res.status(400).json({ error: entryErr.message });
    }
    fuelEntryId = (entry as any).id;
    sideEffectSummary = `Logged ${(txn.amount_cents / 100).toFixed(2)} fuel entry on ${txn.date}`;
  } else if (klass === "service" && vehicleId) {
    await req.db!.from("vehicle_events").insert({
      user_id: req.user!.id,
      vehicle_id: vehicleId,
      event_type: "service_charge",
      summary: `Service charge: ${txn.merchant_name ?? txn.name} — ${(txn.amount_cents / 100).toFixed(2)}`,
      metadata: {
        source: "plaid_classification",
        plaid_transaction_id: (row as any).plaid_transaction_id,
        amount_cents: txn.amount_cents,
        date: txn.date,
        notes: payload.notes ?? null
      }
    });
    sideEffectSummary = `Logged service charge`;
  } else if (klass === "parts" && vehicleId) {
    await req.db!.from("vehicle_events").insert({
      user_id: req.user!.id,
      vehicle_id: vehicleId,
      event_type: "parts_purchase",
      summary: `Parts purchase: ${txn.merchant_name ?? txn.name} — ${(txn.amount_cents / 100).toFixed(2)}`,
      metadata: {
        source: "plaid_classification",
        plaid_transaction_id: (row as any).plaid_transaction_id,
        amount_cents: txn.amount_cents,
        date: txn.date
      }
    });
    sideEffectSummary = `Logged parts purchase`;
  } else if (klass === "insurance" || klass === "lender") {
    // No side-effect today — just record the user's acknowledgment. The next
    // commit will use these confirmations to detect premium changes and
    // payment drift.
    sideEffectSummary = `Acknowledged ${klass} charge`;
  } else if (klass === "subscription" || klass === "registration" || klass === "parking_toll") {
    sideEffectSummary = `Acknowledged ${klass.replace("_", " ")} charge`;
  }

  const { data: updated, error: updErr } = await req
    .db!.from("plaid_transaction_classifications")
    .update({
      confirmed_at: new Date().toISOString(),
      fuel_entry_id: fuelEntryId
    })
    .eq("id", id)
    .select()
    .single();
  if (updErr) return res.status(400).json({ error: updErr.message });

  await audit({
    userId: req.user!.id,
    vehicleId,
    eventType: "plaid_classification_confirmed",
    summary: `Confirmed Plaid ${klass} classification — ${txn.merchant_name ?? txn.name}`,
    metadata: {
      classification_id: id,
      class: klass,
      plaid_transaction_id: (row as any).plaid_transaction_id,
      amount_cents: txn.amount_cents,
      side_effect: sideEffectSummary,
      fuel_entry_id: fuelEntryId
    }
  });

  return res.json({
    classification: updated,
    fuel_entry_id: fuelEntryId,
    side_effect: sideEffectSummary
  });
});

/**
 * Dismiss a classification ("no, this isn't a car charge"). Doesn't delete
 * the row — we keep it so the classifier won't re-surface it next sync.
 */
router.post("/api/plaid/classifications/:id/dismiss", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { data: row } = await req
    .db!.from("plaid_transaction_classifications")
    .select("id, class, confirmed_at, dismissed_at, plaid_transaction_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) return res.status(404).json({ error: "Not found" });
  if ((row as any).dismissed_at) {
    return res.status(200).json({ ok: true, already_dismissed: true });
  }
  if ((row as any).confirmed_at) {
    return res.status(409).json({ error: "Already confirmed — cannot dismiss." });
  }

  const { data: updated, error } = await req
    .db!.from("plaid_transaction_classifications")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  await audit({
    userId: req.user!.id,
    eventType: "plaid_classification_dismissed",
    summary: `Dismissed Plaid ${(row as any).class} classification`,
    metadata: {
      classification_id: id,
      plaid_transaction_id: (row as any).plaid_transaction_id
    }
  });

  return res.json({ classification: updated });
});

/**
 * Re-run the classifier across all of the user's transactions. Useful when
 * they add an insurance carrier or lender so the carrier-/lender-boost
 * rules pick up the new value and reclassify prior charges.
 */
router.post("/api/plaid/classifications/reclassify", async (req, res) => {
  const result = await reclassifyAllForUser(req.user!.id);
  await audit({
    userId: req.user!.id,
    eventType: "plaid_classifications_reclassified",
    summary: `Reclassified ${result.scanned} transactions; ${result.classified} are vehicle-relevant`,
    metadata: { ...result }
  });
  return res.json(result);
});

// ---------- Onboarding prompts (nudge system) ----------

router.get("/api/onboarding/prompts", async (req, res) => {
  const pending = await pendingPromptsForUser(req.user!.id);
  // Record that we showed them so cadence advances
  await Promise.all(pending.map((p) => touchPrompted(req.user!.id, p.field_name)));
  return res.json({ prompts: pending });
});

router.post("/api/onboarding/prompts/:field/dismiss", async (req, res) => {
  const field = z.string().min(1).parse(req.params.field);
  await dismissPrompt(req.user!.id, field);
  return res.json({ dismissed: field });
});

router.post("/api/onboarding/prompts/:field/complete", async (req, res) => {
  const field = z.string().min(1).parse(req.params.field);
  await markFieldCompleted(req.user!.id, field as OnboardingField);
  return res.json({ completed: field });
});

// ---------- Market data ----------

router.get("/api/market/gas", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : null;
  const result = await getGasPrice(state);
  return res.json(result);
});

router.get("/api/market/maintenance-cost", async (req, res) => {
  const itemType = typeof req.query.item_type === "string" ? req.query.item_type : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  if (!itemType) return res.status(400).json({ error: "item_type required" });
  const result = getMaintenanceCost(itemType, state);
  if (!result) return res.status(404).json({ error: "unknown_item_type" });
  return res.json(result);
});

// ---------- Agent / Autonomy / Subscription ----------

router.get("/api/autonomy/status", async (req, res) => {
  const state = await getAutonomyState(req.user!.id);
  const profile = await one(
    req.db!.from("profiles").select("agent_email_local, agent_email_domain").eq("id", req.user!.id)
  );
  return res.json({
    ...state,
    agent_email:
      profile?.agent_email_local && profile.agent_email_domain
        ? composeAgentAddress(profile.agent_email_local, profile.agent_email_domain)
        : null
  });
});

router.get("/api/subscription/status", async (req, res) => {
  const [{ data: sub }, { data: profile }] = await Promise.all([
    req.db!.from("subscriptions").select("*").eq("user_id", req.user!.id).maybeSingle(),
    req.db!.from("profiles").select("plan").eq("id", req.user!.id).maybeSingle()
  ]);
  const pro = await isPro(req.user!.id);
  return res.json({ is_pro: pro, subscription: sub, plan: profile?.plan ?? "free" });
});

router.post("/api/agreements/accept", async (req, res) => {
  const schema = z.object({
    agreement_type: z.enum(["tos", "privacy", "autonomy_consent"]),
    version: z.string().min(1)
  });
  const payload = schema.parse(req.body);
  const { data, error } = await req
    .db!.from("user_agreements")
    .insert({
      user_id: req.user!.id,
      agreement_type: payload.agreement_type,
      version: payload.version
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  return res.status(201).json({ agreement: data });
});

// ---------- Sell vehicle ----------

router.post("/api/sell-vehicle/:vehicleId", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.vehicleId);
  const payload = z
    .object({
      mileage: z.number().int().nonnegative(),
      condition: z.enum(["excellent", "good", "fair", "poor"]),
      payoff_amount_cents: z.number().int().nonnegative().nullable(),
      notes: z.string().optional().nullable()
    })
    .parse(req.body);
  const { data, error } = await req
    .db!.from("vehicle_tasks")
    .insert({
      user_id: req.user!.id,
      vehicle_id: vehicleId,
      task_type: "sell_vehicle",
      title: "Prepare sale package",
      status: "needs_user_approval",
      description:
        "Confirm mileage, condition, payoff, photos placeholder, and valuation before sale outreach.",
      approval_summary:
        "Automoteev will prepare a sale package and contact buying providers only after approval.",
      shared_fields: ["name", "email", "vehicle", "VIN", "mileage", "condition", "payoff amount"],
      metadata: payload
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await audit({
    userId: req.user!.id,
    taskId: data.id,
    vehicleId,
    eventType: "sell_flow_started",
    summary: "Sale preparation task created"
  });
  return res.status(201).json({ task: data });
});

// ---------- Billing ----------

router.post("/api/billing/create-checkout-session", async (req, res) => {
  const schema = z.object({ plan: z.enum(["monthly", "annual"]).default("monthly") });
  const { plan } = schema.parse(req.body ?? {});
  const session = await createProCheckoutSession({
    userId: req.user!.id,
    email: req.user!.email,
    plan
  });
  return res.json(session);
});

// ---------- Placeholder jobs trigger ----------

router.post("/api/jobs/:jobName/run", async (req, res) => {
  const jobName = z
    .enum([
      "daily-recalls",
      "daily-renewal-reminders",
      "insurance-renewals",
      "lease-maturity",
      "maintenance-due",
      "weekly-value-refresh",
      "onboarding-nudges"
    ])
    .parse(req.params.jobName);

  // For jobs that have real implementations, run them inline so smoke tests
  // and Gerry's local triggering both work. The rest stay placeholders.
  if (jobName === "daily-renewal-reminders") {
    const { runDailyRenewalReminders } = await import(
      "./services/renewals-insights.js"
    );
    const result = await runDailyRenewalReminders();
    await audit({
      userId: req.user!.id,
      eventType: "job_run",
      summary: `Ran ${jobName}: sent=${result.sent} skipped=${result.skipped} errors=${result.errors}`,
      metadata: result
    });
    return res.json({ ok: true, job: jobName, mode: "executed", ...result });
  }

  await audit({
    userId: req.user!.id,
    eventType: "job_placeholder_run",
    summary: `Placeholder job run: ${jobName}`
  });
  return res.json({ ok: true, job: jobName, mode: "placeholder" });
});

// ---------- Vehicle valuation ----------

router.post("/api/vehicles/:id/value/refresh", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.id);
  const [vehicle, profile] = await Promise.all([
    one(req.db!.from("vehicles").select("*").eq("id", vehicleId)),
    one(req.db!.from("profiles").select("zip_code").eq("id", req.user!.id))
  ]);
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

  let valuation;
  try {
    valuation = await getVehicleValuation({
      vin: vehicle.vin,
      mileage: vehicle.mileage,
      zipCode: (profile as any)?.zip_code ?? null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Vehicle valuation failed.";
    return res.status(message.includes("configured") ? 503 : 422).json({ error: message });
  }

  await req
    .db!.from("vehicles")
    .update({
      market_value_low_cents: valuation.market_value_low_cents,
      market_value_high_cents: valuation.market_value_high_cents,
      dealer_value_low_cents: valuation.dealer_value_low_cents,
      dealer_value_high_cents: valuation.dealer_value_high_cents,
      estimated_value_cents: Math.round(
        (valuation.market_value_low_cents + valuation.market_value_high_cents) / 2
      ),
      value_estimated_at: new Date().toISOString()
    })
    .eq("id", vehicleId);

  await audit({
    userId: req.user!.id,
    vehicleId,
    eventType: "value_refreshed",
    summary: "Vehicle value checked with MarketCheck"
  });

  return res.json({ valuation });
});

// ---------- Fuel log ----------

router.get("/api/vehicles/:id/fuel", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.id);
  const { data, error } = await req
    .db!.from("fuel_entries")
    .select("*")
    .eq("vehicle_id", vehicleId)
    .order("entry_date", { ascending: false })
    .limit(50);
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ entries: data ?? [] });
});

router.post("/api/vehicles/:id/fuel", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.id);
  const payload = z
    .object({
      entry_date: z.string(),
      total_cents: z.number().int().nonnegative(),
      gallons: z.number().nonnegative().nullable().optional(),
      odometer_miles: z.number().int().nonnegative().nullable().optional(),
      notes: z.string().nullable().optional()
    })
    .parse(req.body);

  const { data, error } = await req
    .db!.from("fuel_entries")
    .insert({
      user_id: req.user!.id,
      vehicle_id: vehicleId,
      entry_date: payload.entry_date,
      total_cents: payload.total_cents,
      gallons: payload.gallons ?? null,
      odometer_miles: payload.odometer_miles ?? null,
      notes: payload.notes ?? null
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  return res.status(201).json({ entry: data });
});

// ---------- Insights: act on a recommendation (one-tap to create task) ----------

router.post("/api/insights/act", async (req, res) => {
  const schema = z.object({
    insight_key: z.string().min(1),
    vehicle_id: z.string().uuid()
  });
  const { insight_key, vehicle_id } = schema.parse(req.body);

  // Re-generate insights live so we operate on the freshest set
  const vehicle = await one(
    req.db!.from("vehicles").select("*").eq("id", vehicle_id)
  );
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

  const [costProfile, loanLease, insurance, maintRes, recallsRes, providersRes, fuelRes, activeTasksRes] =
    await Promise.all([
      one(req.db!.from("vehicle_cost_profiles").select("*").eq("vehicle_id", vehicle_id)),
      one(req.db!.from("loan_lease_accounts").select("*").eq("vehicle_id", vehicle_id)),
      one(req.db!.from("insurance_accounts").select("*").eq("vehicle_id", vehicle_id)),
      req.db!.from("maintenance_items").select("*").eq("vehicle_id", vehicle_id),
      req.db!.from("recalls").select("*").eq("vehicle_id", vehicle_id).is("resolved_at", null),
      req.db!.from("providers").select("id").eq("is_preferred", true).limit(1),
      req
        .db!.from("fuel_entries")
        .select("entry_date")
        .eq("vehicle_id", vehicle_id)
        .order("entry_date", { ascending: false })
        .limit(1),
      req
        .db!.from("vehicle_tasks")
        .select("task_type")
        .eq("vehicle_id", vehicle_id)
        // Only suppress when the agent has acted — needs_user_approval / approved
        // tasks should keep their recommendation visible so the user can re-engage.
        .in("status", ["in_progress", "waiting_on_provider"])
    ]);

  const lastShoppedAt = (insurance as any)?.last_shopped_at;
  const lastFuelEntry = fuelRes.data?.[0]?.entry_date;

  const insights = generateInsights({
    vehicle,
    costProfile,
    loanLease,
    insurance,
    maintenanceItems: (maintRes.data ?? []) as any,
    openRecallCount: (recallsRes.data ?? []).length,
    preferredServiceShopExists: (providersRes.data ?? []).length > 0,
    monthsSinceLastFuelEntry: lastFuelEntry
      ? Math.floor((Date.now() - new Date(lastFuelEntry).getTime()) / (30 * 86_400_000))
      : null,
    daysSinceLastInsuranceShop: lastShoppedAt
      ? Math.floor((Date.now() - new Date(lastShoppedAt).getTime()) / 86_400_000)
      : null,
    activeTaskTypes: new Set((activeTasksRes.data ?? []).map((t: any) => t.task_type))
  });

  const insight = insights.find((i) => i.key === insight_key);
  if (!insight) {
    return res.status(404).json({ error: "Insight no longer applies" });
  }

  // Branch by action type
  if (insight.action.type === "create_task") {
    const taskType = insight.action.task_type ?? "general";

    // Idempotency: if an active task of this type already exists for this
    // vehicle, return it instead of creating a duplicate. Prevents the
    // "tap a recommendation twice → two tasks" bug.
    const existingActive = await one(
      req
        .db!.from("vehicle_tasks")
        .select("*")
        .eq("vehicle_id", vehicle_id)
        .eq("task_type", taskType)
        .in("status", ["needs_user_approval", "approved", "in_progress", "waiting_on_provider"])
        .order("created_at", { ascending: false })
        .limit(1)
    );
    if (existingActive) {
      // Hand back the existing task plus a fresh dispatch payload (so the user
      // can pick dealers / send) if this is a dispatchable task type.
      const dispatchPayload = isDispatchable(taskType)
        ? await buildDispatchPayload(req.user!.id, vehicle, existingActive as any, taskType)
        : null;
      if (dispatchPayload) {
        return res.status(200).json({
          action: "open_dispatch",
          task: existingActive,
          ...dispatchPayload,
          already_existed: true
        });
      }
      return res.status(200).json({
        action: "task_created",
        task: existingActive,
        navigate_to: `/tasks/${(existingActive as any).id}`,
        already_existed: true
      });
    }

    const { data: task, error } = await req
      .db!.from("vehicle_tasks")
      .insert({
        user_id: req.user!.id,
        vehicle_id,
        task_type: taskType,
        category: insight.category,
        title: insight.action.task_title ?? insight.title,
        description: insight.body,
        status: "needs_user_approval",
        approval_summary: insight.action.approval_summary ?? null,
        shared_fields: insight.action.shared_fields ?? null
      })
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });

    await audit({
      userId: req.user!.id,
      taskId: task.id,
      vehicleId: vehicle_id,
      eventType: "insight_acted",
      summary: `Insight "${insight.title}" → task created (${insight.category})`
    });

    // If this is a dispatchable task type, do discovery + draft email + return
    // everything the user needs to review and send. They sign off via the
    // DispatchModal (one tap = approve + send).
    if (isDispatchable(taskType)) {
      const dispatchPayload = await buildDispatchPayload(req.user!.id, vehicle, task, taskType);
      if (dispatchPayload) {
        return res.status(201).json({
          action: "open_dispatch",
          task,
          ...dispatchPayload
        });
      }
    }

    return res.status(201).json({
      action: "task_created",
      task,
      navigate_to: `/tasks/${task.id}`
    });
  }

  if (insight.action.type === "open_form") {
    return res.json({
      action: "open_form",
      form_id: insight.action.form_id,
      vehicle_id
    });
  }

  if (insight.action.type === "run_recall_check") {
    // Trigger the same VIN-specific recall lookup as the onboarding background promise.
    const recall = await lookupRecallsByVin(vehicle.vin);

    if (recall.campaigns.length) {
      await supabaseAdmin.from("recalls").upsert(
        recall.campaigns.map((c) => ({
          user_id: req.user!.id,
          vehicle_id,
          nhtsa_campaign_id: c.nhtsa_campaign_id,
          summary: c.summary,
          component: c.component,
          consequence: c.consequence,
          remedy: c.remedy,
          reported_at: c.reported_at
        })),
        { onConflict: "vehicle_id,nhtsa_campaign_id", ignoreDuplicates: true }
      );
    } else {
      // No open recalls — clear any stale rows so dashboard reflects truth.
      await supabaseAdmin
        .from("recalls")
        .update({ resolved_at: new Date().toISOString() })
        .eq("vehicle_id", vehicle_id)
        .is("resolved_at", null);
    }
    await supabaseAdmin
      .from("vehicles")
      .update({
        recall_status: recall.hasOpenRecall ? "open" : "clear",
        last_recall_check_at: new Date().toISOString()
      })
      .eq("id", vehicle_id);

    return res.json({
      action: "recall_check_run",
      recall_status: recall.hasOpenRecall ? "open" : "clear",
      campaign_count: recall.campaigns.length
    });
  }

  return res.status(400).json({ error: "Unsupported action type" });
});

/**
 * Dismiss a synthetic insight card on Home for a TTL window. Real tasks
 * (status = needs_user_approval) decline via /api/tasks/:id/approval with
 * approved=false; this endpoint is only for insight-driven cards that
 * don't yet have a task_id.
 *
 * Default snooze 7 days — long enough that the user isn't pestered, short
 * enough that an actually-important recommendation re-surfaces.
 */
router.post("/api/insights/dismiss", async (req, res) => {
  const schema = z.object({
    insight_key: z.string().min(1),
    vehicle_id: z.string().uuid(),
    snooze_days: z.number().int().positive().max(90).optional()
  });
  const { insight_key, vehicle_id, snooze_days } = schema.parse(req.body);
  const ttlDays = snooze_days ?? 7;
  const dismissedUntil = new Date(Date.now() + ttlDays * 86_400_000).toISOString();

  const { error } = await supabaseAdmin
    .from("dismissed_insights")
    .upsert(
      {
        user_id: req.user!.id,
        vehicle_id,
        insight_key,
        dismissed_at: new Date().toISOString(),
        dismissed_until: dismissedUntil
      },
      { onConflict: "user_id,vehicle_id,insight_key" }
    );
  if (error) return res.status(400).json({ error: error.message });

  await audit({
    userId: req.user!.id,
    vehicleId: vehicle_id,
    eventType: "insight_dismissed",
    summary: `Dismissed insight: ${insight_key} (snoozed ${ttlDays}d)`
  });

  return res.json({ ok: true, dismissed_until: dismissedUntil });
});

// ---------- Documents (image upload + AI extraction) ----------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

router.post("/api/documents", upload.single("file"), async (req, res) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  const schema = z.object({
    document_kind: z.enum([
      "insurance_dec_page",
      "loan_statement",
      "lease_agreement",
      "registration",
      "recall_notice",
      "service_record",
      "sale_paperwork",
      "drivers_license",
      "other"
    ]),
    vehicle_id: z.string().uuid().optional()
  });
  const { document_kind, vehicle_id } = schema.parse(req.body);

  const allowed = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];
  if (!allowed.includes(file.mimetype)) {
    return res.status(415).json({ error: `Unsupported mime type: ${file.mimetype}` });
  }

  // Ownership check on the vehicle_id before we let the admin client write
  // a row tying this document to that vehicle. Without this, a malicious
  // caller could pass any vehicle UUID and the storage path would land
  // under vehicles/<other-user-vehicle-id>/<category>/. The req.db client
  // is RLS-scoped to req.user; if the row isn't visible, ownership fails.
  if (vehicle_id) {
    const { data: ownership } = await req
      .db!.from("vehicles")
      .select("id")
      .eq("id", vehicle_id)
      .maybeSingle();
    if (!ownership) return res.status(404).json({ error: "Vehicle not found" });
  }

  const doc = await uploadDocument({
    userId: req.user!.id,
    vehicleId: vehicle_id ?? null,
    documentKind: document_kind as DocumentKind,
    fileName: file.originalname,
    mimeType: file.mimetype,
    buffer: file.buffer
  });

  await audit({
    userId: req.user!.id,
    vehicleId: vehicle_id,
    eventType: "document_uploaded",
    summary: `Uploaded ${document_kind}: ${file.originalname}`
  });

  // Trigger extraction asynchronously
  void extractDocument(doc.id).catch((err) =>
    console.error(`[documents] extraction failed for ${doc.id}`, err)
  );

  return res.status(201).json({ document: doc });
});

router.get("/api/documents/:id", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { data, error } = await req
    .db!.from("uploaded_documents")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Not found" });
  return res.json({ document: data });
});

router.post("/api/documents/:id/apply", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const schema = z.object({ vehicle_id: z.string().uuid() });
  const { vehicle_id } = schema.parse(req.body);

  const result = await applyExtractedDocument({
    userId: req.user!.id,
    documentId: id,
    vehicleId: vehicle_id
  });

  await audit({
    userId: req.user!.id,
    vehicleId: vehicle_id,
    eventType: "document_applied",
    summary: `Applied document fields: ${result.applied.join(", ")}`
  });

  return res.json(result);
});

/**
 * List uploaded documents for a vehicle, grouped by category. Powers the
 * "everything I have on this car" view: registration, insurance dec pages,
 * loan statements, recall notices, service records, sale paperwork.
 *
 * Optional ?category=<name> filters the result set to one folder. With no
 * filter, returns ALL documents on the vehicle plus a `by_category` map
 * for grouped rendering.
 */
router.get("/api/vehicles/:vehicleId/documents", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.vehicleId);
  const categoryParam =
    typeof req.query.category === "string" ? req.query.category : null;
  const validCategories = [
    "insurance",
    "loan",
    "registration",
    "recall",
    "service",
    "sale",
    "other"
  ] as const;
  const category =
    categoryParam && (validCategories as readonly string[]).includes(categoryParam)
      ? categoryParam
      : null;

  let query = req
    .db!.from("uploaded_documents")
    .select("*")
    .eq("vehicle_id", vehicleId)
    .order("uploaded_at", { ascending: false });

  if (category) {
    query = query.eq("category", category);
  }

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });

  const documents = (data ?? []) as any[];

  // Group for the "folders" UI — only computed when no category filter is
  // applied (callers asking for one specific folder don't need the map).
  const by_category: Record<string, any[]> = {};
  const counts: Record<string, number> = {};
  if (!category) {
    for (const cat of validCategories) {
      by_category[cat] = [];
      counts[cat] = 0;
    }
    for (const doc of documents) {
      const cat = (doc.category as string) || "other";
      if (!by_category[cat]) {
        by_category[cat] = [];
        counts[cat] = 0;
      }
      by_category[cat].push(doc);
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
  }

  return res.json({
    documents,
    by_category: category ? null : by_category,
    counts: category ? null : counts,
    total: documents.length
  });
});

/**
 * Generate a short-TTL signed URL so the user can open or download a
 * document straight from the VehicleDocumentsPanel folders view. Ownership
 * is enforced via the RLS-scoped req.db client first — if the user doesn't
 * own the document, RLS returns no row and we respond 404 (rather than 403)
 * to avoid leaking existence of documents on other accounts.
 */
router.get("/api/documents/:id/signed-url", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);

  const { data: ownership } = await req
    .db!.from("uploaded_documents")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!ownership) return res.status(404).json({ error: "Not found" });

  const result = await createDocumentSignedUrl(id, 300);
  if (!result) {
    return res.status(500).json({ error: "Could not generate signed URL" });
  }
  return res.json(result);
});

// ---------- Renewals (DL, insurance, warranties, memberships, subscriptions) -

const RENEWABLE_KINDS = [
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
] as const;

const COST_PERIODS = ["one_time", "monthly", "annual", "biennial"] as const;

const renewalCreateSchema = z
  .object({
    vehicle_id: z.string().uuid().nullable().optional(),
    kind: z.enum(RENEWABLE_KINDS),
    label: z.string().min(1).max(120).optional(),
    provider_name: z.string().min(1).max(120).nullable().optional(),
    policy_number: z.string().min(1).max(60).nullable().optional(),
    expires_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expires_at must be YYYY-MM-DD")
      .nullable()
      .optional(),
    expires_at_mileage: z.number().int().nonnegative().nullable().optional(),
    auto_renews: z.boolean().optional(),
    cost_cents: z.number().int().nonnegative().nullable().optional(),
    cost_period: z.enum(COST_PERIODS).nullable().optional(),
    reminder_days_before: z.number().int().positive().max(365).optional(),
    notes: z.string().max(2000).nullable().optional()
  })
  .refine(
    (v) => v.expires_at != null || v.expires_at_mileage != null,
    "At least one of expires_at or expires_at_mileage is required"
  );

const renewalUpdateSchema = z.object({
  vehicle_id: z.string().uuid().nullable().optional(),
  kind: z.enum(RENEWABLE_KINDS).optional(),
  label: z.string().min(1).max(120).optional(),
  provider_name: z.string().min(1).max(120).nullable().optional(),
  policy_number: z.string().min(1).max(60).nullable().optional(),
  expires_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  expires_at_mileage: z.number().int().nonnegative().nullable().optional(),
  auto_renews: z.boolean().optional(),
  cost_cents: z.number().int().nonnegative().nullable().optional(),
  cost_period: z.enum(COST_PERIODS).nullable().optional(),
  reminder_days_before: z.number().int().positive().max(365).optional(),
  notes: z.string().max(2000).nullable().optional()
});

/**
 * List the user's renewable items. Includes status decoration (days until
 * expiration, is_expired, is_due_soon) computed server-side so the client
 * doesn't need to re-derive on every render.
 *
 * Query params:
 *   ?vehicle_id=<uuid>           Restrict to one vehicle (still includes
 *                                user-scoped items like DL).
 *   ?include_dismissed=true      Show snoozed items (default: hide).
 *   ?include_expired=false       Hide expired items (default: show).
 */
router.get("/api/renewals", async (req, res) => {
  const vehicleId =
    typeof req.query.vehicle_id === "string" && req.query.vehicle_id.length > 0
      ? req.query.vehicle_id
      : null;
  const includeDismissed = req.query.include_dismissed === "true";
  const includeExpired = req.query.include_expired !== "false";

  const items = await listRenewalsForUser({
    userId: req.user!.id,
    vehicleId,
    includeDismissed,
    includeExpired
  });

  return res.json({ items, total: items.length });
});

/**
 * Create a renewable item manually. The DL flow auto-creates via the
 * documents pipeline; this endpoint is for everything the agent can't
 * extract: warranties on a printed contract, AAA memberships, prepaid
 * maintenance plans, gym subscriptions, etc.
 *
 * Defaults applied: label falls back to defaultLabel(kind),
 * reminder_days_before falls back to defaultReminderDays(kind), auto_renews
 * defaults to false (lapse semantics).
 */
router.post("/api/renewals", async (req, res) => {
  const payload = renewalCreateSchema.parse(req.body);
  const kind = payload.kind as RenewableKind;

  const insertRow: Record<string, unknown> = {
    user_id: req.user!.id,
    vehicle_id: payload.vehicle_id ?? null,
    kind,
    label: payload.label ?? defaultLabel(kind),
    provider_name: payload.provider_name ?? null,
    expires_at: payload.expires_at ?? null,
    expires_at_mileage: payload.expires_at_mileage ?? null,
    auto_renews: payload.auto_renews ?? false,
    cost_cents: payload.cost_cents ?? null,
    cost_period: (payload.cost_period as CostPeriod) ?? null,
    reminder_days_before: payload.reminder_days_before ?? defaultReminderDays(kind),
    notes: payload.notes ?? null
  };
  if (payload.policy_number) {
    insertRow.policy_number_encrypted = encryptField(payload.policy_number);
  }

  const { data, error } = await req
    .db!.from("renewable_items")
    .insert(insertRow)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  await audit({
    userId: req.user!.id,
    vehicleId: payload.vehicle_id ?? undefined,
    eventType: "renewal_created",
    summary: `Created renewal: ${insertRow.label} (${kind})`
  });

  return res.status(201).json({ item: data });
});

/**
 * Update a renewable item. Used to correct an extracted expiration date,
 * change the reminder lead-time, attach a cost figure after the fact, etc.
 * Ownership enforced via req.db RLS — a row owned by another user simply
 * isn't visible and the update affects 0 rows.
 */
router.patch("/api/renewals/:id", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const payload = renewalUpdateSchema.parse(req.body);

  const update: Record<string, unknown> = {};
  if (payload.vehicle_id !== undefined) update.vehicle_id = payload.vehicle_id;
  if (payload.kind !== undefined) update.kind = payload.kind;
  if (payload.label !== undefined) update.label = payload.label;
  if (payload.provider_name !== undefined) update.provider_name = payload.provider_name;
  if (payload.expires_at !== undefined) update.expires_at = payload.expires_at;
  if (payload.expires_at_mileage !== undefined)
    update.expires_at_mileage = payload.expires_at_mileage;
  if (payload.auto_renews !== undefined) update.auto_renews = payload.auto_renews;
  if (payload.cost_cents !== undefined) update.cost_cents = payload.cost_cents;
  if (payload.cost_period !== undefined) update.cost_period = payload.cost_period;
  if (payload.reminder_days_before !== undefined)
    update.reminder_days_before = payload.reminder_days_before;
  if (payload.notes !== undefined) update.notes = payload.notes;
  if (payload.policy_number !== undefined) {
    update.policy_number_encrypted = payload.policy_number
      ? encryptField(payload.policy_number)
      : null;
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  const { data, error } = await req
    .db!.from("renewable_items")
    .update(update)
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Not found" });

  await audit({
    userId: req.user!.id,
    eventType: "renewal_updated",
    summary: `Updated renewal ${id}`,
    metadata: { updated_fields: Object.keys(update) }
  });

  return res.json({ item: data });
});

/**
 * Hard-delete a renewable item. Easy to recreate (manual entry) so a soft-
 * delete doesn't earn its complexity here. Snooze with /dismiss instead
 * if the user just wants to hide the item temporarily.
 */
router.delete("/api/renewals/:id", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);

  const { data: existing } = await req
    .db!.from("renewable_items")
    .select("id, label, kind")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: "Not found" });

  const { error } = await req.db!.from("renewable_items").delete().eq("id", id);
  if (error) return res.status(400).json({ error: error.message });

  await audit({
    userId: req.user!.id,
    eventType: "renewal_deleted",
    summary: `Deleted renewal: ${(existing as any).label} (${(existing as any).kind})`
  });

  return res.json({ deleted: id });
});

/**
 * Soft-snooze a renewable item. Hides it from the home stack until
 * dismissed_until passes. Default snooze is 7 days; the user can pass
 * snooze_days (1–365) to override.
 */
router.post("/api/renewals/:id/dismiss", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const schema = z.object({
    snooze_days: z.number().int().positive().max(365).optional()
  });
  const { snooze_days } = schema.parse(req.body ?? {});

  // Ownership check via the RLS-scoped client first — if the row isn't
  // visible to this user, return 404 (don't leak existence).
  const { data: ownership } = await req
    .db!.from("renewable_items")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!ownership) return res.status(404).json({ error: "Not found" });

  const result = await dismissRenewal({
    userId: req.user!.id,
    itemId: id,
    ttlDays: snooze_days
  });

  await audit({
    userId: req.user!.id,
    eventType: "renewal_dismissed",
    summary: `Snoozed renewal ${id} until ${result.dismissed_until}`
  });

  return res.json(result);
});

// ---------- MCP token issuance (used from web app to generate a paste-able token) ----------

router.post("/api/mcp/tokens", async (req, res) => {
  const schema = z.object({ client_name: z.string().min(1).max(100).default("MCP Client") });
  const { client_name } = schema.parse(req.body ?? {});

  const rawToken = `aev_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  const { error } = await supabaseAdmin.from("mcp_connections").insert({
    user_id: req.user!.id,
    client_name,
    access_token_hash: tokenHash,
    scopes: ["read:vehicle", "read:recommendations", "write:tasks"]
  });
  if (error) return res.status(400).json({ error: error.message });

  await audit({
    userId: req.user!.id,
    eventType: "mcp_token_issued",
    summary: `Issued MCP token for ${client_name}`
  });

  // Return raw token ONCE
  return res.status(201).json({ access_token: rawToken, token_type: "bearer", client_name });
});

router.get("/api/mcp/connections", async (req, res) => {
  const { data } = await req
    .db!.from("mcp_connections")
    .select("id, client_name, scopes, expires_at, last_used_at, created_at, revoked_at")
    .eq("user_id", req.user!.id)
    .order("created_at", { ascending: false });
  return res.json({ connections: data ?? [] });
});

router.post("/api/mcp/connections/:id/revoke", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await supabaseAdmin
    .from("mcp_connections")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", req.user!.id);
  return res.json({ revoked: id });
});

// ---------- Push Notifications (PWA web push) ----------

/**
 * Returns the VAPID public key + whether push is configured on this server.
 * The frontend needs the public key to subscribe a browser. We also expose
 * the configured flag so the UI can hide the subscribe button entirely on
 * environments where keys aren't set.
 */
router.get("/api/push/vapid-key", async (_req, res) => {
  return res.json({
    public_key: env.VAPID_PUBLIC_KEY ?? null,
    configured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY)
  });
});

/**
 * Save (upsert) a browser push subscription for the current user.
 * Endpoint is the unique key — re-subscribing on the same device updates
 * rather than duplicates. Auth and p256dh come from the browser's
 * PushSubscription.toJSON() output.
 */
router.post("/api/push/subscribe", async (req, res) => {
  const schema = z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1)
    })
  });
  const { endpoint, keys } = schema.parse(req.body);
  const userAgent = req.header("user-agent") ?? null;

  await subscribePush({
    userId: req.user!.id,
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    userAgent
  });

  await audit({
    userId: req.user!.id,
    eventType: "push_subscribed",
    summary: "Push notification subscription added"
  });

  return res.status(201).json({ subscribed: true });
});

/**
 * Remove a single subscription (the device the user is currently signing
 * out of, or one they tapped "unsubscribe" on). Idempotent.
 */
router.delete("/api/push/subscribe", async (req, res) => {
  const schema = z.object({ endpoint: z.string().url() });
  const { endpoint } = schema.parse(req.body);
  await unsubscribePush({ userId: req.user!.id, endpoint });
  return res.json({ unsubscribed: true });
});

/**
 * Quick "is this device subscribed" + count of total active subs across
 * all devices. UI uses this to render the right toggle state.
 */
router.get("/api/push/status", async (req, res) => {
  const endpoint = typeof req.query.endpoint === "string" ? req.query.endpoint : null;
  const { data: subs } = await req
    .db!.from("push_subscriptions")
    .select("endpoint")
    .eq("user_id", req.user!.id)
    .is("failed_at", null);
  const all = (subs ?? []).map((s: any) => s.endpoint as string);
  return res.json({
    active_count: all.length,
    this_device_subscribed: endpoint ? all.includes(endpoint) : false
  });
});

/**
 * Send a test push to all of the user's subscriptions. Used by the Settings
 * UI to verify the end-to-end pipeline is working.
 */
router.post("/api/push/test", async (req, res) => {
  const delivered = await sendPushToUser(req.user!.id, {
    title: "Automoteev test notification",
    body: "If you see this, push notifications are working.",
    url: "/app?tab=settings",
    tag: "test"
  });
  return res.json({ delivered });
});

// ---------- Dispatch (send approved task to many providers in one go) ----------

/**
 * Returns true if the user's saved preferred provider can handle this task.
 * Refinance tasks shouldn't auto-include a service dealership; insurance
 * tasks shouldn't auto-include a body shop; etc. The preferred-provider
 * concept is a per-relationship hint, not a universal address book.
 *
 * If we don't have a strong type signal (older rows with no provider_type),
 * we conservatively only allow inclusion for the task types it could plausibly
 * serve — i.e., service-flavored tasks. Refinance / insurance / sell never
 * inherit an unknown preferred provider.
 */
function isPreferredCompatibleWithTask(
  preferredType: string | null | undefined,
  taskType: DispatchableTaskType
): boolean {
  const t = (preferredType ?? "").toLowerCase();
  switch (taskType) {
    case "recall_repair":
      return t === "dealership_service" || t === "service_shop";
    case "service_quote":
      return (
        t === "dealership_service" ||
        t === "service_shop" ||
        t === "oil_change" ||
        t === "tire_shop" ||
        t === "body_shop"
      );
    case "insurance_quote":
      return t === "insurance_agent";
    case "refinance":
      // Only actual lenders. Service dealerships do NOT refinance — banks
      // and credit unions do. Restrictive on purpose so we don't email a
      // service writer asking for an APR quote.
      return t === "lender" || t === "credit_union" || t === "bank";
    case "sell_vehicle":
      return t === "buying_center";
  }
}

/**
 * Build the dispatch payload for a task: discover providers, generate the
 * email, and reuse any existing preferred provider. Returns null only if
 * we can't fetch user/vehicle context.
 */
async function buildDispatchPayload(
  userId: string,
  vehicle: any,
  task: any,
  taskType: DispatchableTaskType
) {
  const profile = await one(
    supabaseAdmin.from("profiles").select("*").eq("id", userId)
  );
  if (!profile) return null;

  // Pull existing preferred provider for this user (if any) so we can
  // pre-select it. Type-loose since the providers table doesn't carry vehicle_id.
  const existingPreferred = await one(
    supabaseAdmin
      .from("providers")
      .select("*")
      .eq("user_id", userId)
      .eq("is_preferred", true)
      .limit(1)
  );

  // Only auto-include the preferred provider when it's compatible with the
  // current task. "Land Rover Marin" (dealership_service) should NOT show
  // up in a refinance dispatch — dealers don't refinance.
  const compatiblePreferred =
    existingPreferred &&
    isPreferredCompatibleWithTask((existingPreferred as any).provider_type, taskType)
      ? existingPreferred
      : null;

  // Discover up to 5 candidates via Google Places.
  const discovered = await discoverProvidersForTask({
    taskType,
    vehicleMake: vehicle.make ?? null,
    zipCode: (profile as any).zip_code ?? null,
    maxResults: 5
  });

  // For refinance, the lender ENTITY is what matters — "SF Federal Credit Union"
  // at branch A and branch B are the same applicant pipeline. Dedupe the
  // discovered list by name before persisting so the user sees one row, not
  // two. For service / sales tasks we keep both because each location is an
  // independent shop with its own inventory and writers.
  const dedupedDiscovered =
    taskType === "refinance"
      ? Array.from(new Map(discovered.map((d) => [d.name.toLowerCase(), d])).values())
      : discovered;

  // Upsert each discovered provider so it has an id we can dispatch to.
  // Dedupe key varies by task type — see comment above.
  const dept = taskTypeToContactDept(taskType);

  // Pass 1: ensure each discovered candidate has both a businesses row
  // (shared directory) and a per-user providers row linked via business_id.
  // We hold the rows here and resolve the effective email in pass 2 once
  // we've bulk-fetched community contacts.
  type StagedProvider = {
    row: any;
    business_id: string | null;
    derived_email_basis: string | null;
    rating: number | null;
    rating_count: number | null;
    website: string | null;
    distance_miles: number | null;
  };
  const stage1: StagedProvider[] = [];

  for (const d of dedupedDiscovered) {
    // Upsert into shared directory FIRST so future users get the seed.
    const business = await upsertBusiness({
      place_id: d.external_id,
      name: d.name,
      address: d.location ?? null,
      phone: d.phone ?? null,
      website: d.website ?? null,
      latitude: d.lat ?? null,
      longitude: d.lng ?? null,
      provider_type: d.provider_type ?? null,
      published_email: d.derived_email ?? null,
      rating: d.rating ?? null,
      rating_count: d.rating_count ?? null
    });
    const businessId = business?.id ?? null;
    const placeId = d.external_id ?? null;

    let lookup = supabaseAdmin
      .from("providers")
      .select("*")
      .eq("user_id", userId)
      .eq("name", d.name);
    if (taskType !== "refinance") {
      lookup = lookup.eq("location", d.location ?? "");
    }
    const { data: existing } = await lookup.maybeSingle();

    if (existing) {
      const updates: Record<string, unknown> = {};
      if (!existing.email && d.derived_email) updates.email = d.derived_email;
      if (!existing.business_id && businessId) updates.business_id = businessId;
      if (!existing.place_id && placeId) updates.place_id = placeId;
      if (Object.keys(updates).length > 0) {
        await supabaseAdmin.from("providers").update(updates).eq("id", existing.id);
        Object.assign(existing, updates);
      }
      stage1.push({
        row: existing,
        business_id: businessId ?? existing.business_id ?? null,
        derived_email_basis: existing.email ? "verified" : null,
        rating: d.rating,
        rating_count: d.rating_count,
        website: d.website,
        distance_miles: d.distance_miles
      });
    } else {
      const { data: created } = await supabaseAdmin
        .from("providers")
        .insert({
          user_id: userId,
          name: d.name,
          email: d.derived_email,
          phone: d.phone,
          provider_type: d.provider_type,
          location: d.location,
          is_preferred: false,
          business_id: businessId,
          place_id: placeId
        })
        .select()
        .single();
      if (created) {
        stage1.push({
          row: created,
          business_id: businessId,
          derived_email_basis: d.derived_email_basis,
          rating: d.rating,
          rating_count: d.rating_count,
          website: d.website,
          distance_miles: d.distance_miles
        });
      }
    }
  }

  // Pass 2: bulk-lookup community-verified contacts for every business
  // touched. Single query. Then resolve each row's effective email using
  // the new 4-layer priority and annotate verified_by_community.
  const businessIds = stage1
    .map((s) => s.business_id)
    .filter((id): id is string => Boolean(id));
  const sharedMap = await lookupSharedContactsBulk({
    business_ids: businessIds,
    dept
  });

  const inserted: any[] = stage1.map((s) => {
    const community = s.business_id ? sharedMap.get(s.business_id) : undefined;
    const communityEmail = community?.email ?? null;
    const perUserContact =
      (s.row.contacts as Record<string, string> | null | undefined)?.[dept] ??
      null;
    const resolved = pickProviderEmailForDept(
      s.row.contacts as Record<string, string>,
      s.row.email,
      dept,
      communityEmail
    );

    // Verified by community = the row's effective email comes from the
    // shared pool (this user has no per-user contact for this dept AND
    // the resolver picked the community address). Drives the green
    // "Verified contact" badge in the dispatch modal.
    const verified_by_community =
      Boolean(community) && !perUserContact && resolved === communityEmail;

    return {
      ...s.row,
      email: resolved,
      derived_email_basis: resolved ? "verified" : "none",
      rating: s.rating,
      rating_count: s.rating_count,
      website: s.website,
      distance_miles: s.distance_miles,
      verified_by_community,
      community_contact_email: communityEmail,
      community_success_count: community?.success_count ?? null
    };
  });

  // If user has a preferred provider that's compatible with this task and not
  // already in the discovered list, prepend it.
  let providers = inserted;
  if (compatiblePreferred && !providers.find((p) => p.id === (compatiblePreferred as any).id)) {
    const pref = compatiblePreferred as any;
    // Look up community contact for the preferred provider's business too.
    const prefCommunity = pref.business_id
      ? await lookupSharedContact({ business_id: pref.business_id, dept })
      : null;
    const prefCommunityEmail = prefCommunity?.email ?? null;
    const perUserPref =
      (pref.contacts as Record<string, string> | null | undefined)?.[dept] ??
      null;
    const resolved = pickProviderEmailForDept(
      pref.contacts as Record<string, string>,
      pref.email,
      dept,
      prefCommunityEmail
    );
    providers = [
      {
        ...pref,
        email: resolved,
        derived_email_basis: resolved ? "verified" : "none",
        rating: null,
        rating_count: null,
        website: null,
        distance_miles: null,
        verified_by_community:
          Boolean(prefCommunity) && !perUserPref && resolved === prefCommunityEmail,
        community_contact_email: prefCommunityEmail,
        community_success_count: prefCommunity?.success_count ?? null
      },
      ...providers
    ];
  }

  // Annotate any provider that matches the user's CURRENT lender / carrier
  // so the dispatch UI can render a "this is who you already use" banner
  // instead of cold-emailing them. This addresses a real failure mode where
  // refinance recommendations would surface the user's own lender as a
  // "discovery" — making the agent look uninformed.
  const currentMap = await detectCurrentProviders({
    userId,
    vehicleId: vehicle.id,
    taskType,
    candidates: providers.map((p) => ({ id: p.id, name: p.name }))
  });
  if (currentMap.size > 0) {
    providers = providers.map((p) => {
      const ann = currentMap.get(p.id);
      if (!ann) return p;
      return {
        ...p,
        is_current_provider: true,
        current_provider_note: ann.current_provider_note ?? null
      };
    });
    // Float current providers to the top so the user sees the context first.
    providers.sort((a, b) =>
      (b.is_current_provider ? 1 : 0) - (a.is_current_provider ? 1 : 0)
    );
  }

  const vehicleName =
    `${vehicle.year ?? ""} ${vehicle.make ?? ""} ${vehicle.model ?? ""}`.trim() || "vehicle";

  // For recall tasks, pull open campaigns so we can list them in the email.
  // The email is dramatically more likely to get a reply when the dealer can
  // see the specific NHTSA IDs being asked about.
  let recalls: { nhtsa_campaign_id: string; component: string | null }[] = [];
  if (task.task_type === "recall_repair" || task.task_type === "recall_appointment") {
    const { data: recallRows } = await supabaseAdmin
      .from("recalls")
      .select("nhtsa_campaign_id, component")
      .eq("vehicle_id", vehicle.id)
      .is("resolved_at", null);
    recalls = recallRows ?? [];
  }

  const subject = taskEmailSubject(task.task_type as TaskType, vehicleName, {
    recallCount: recalls.length
  });
  const body = taskEmailBody({
    type: task.task_type as TaskType,
    userName: (profile as any).full_name,
    vehicleName,
    vin: vehicle.vin,
    mileage: vehicle.mileage,
    notes: null,
    recalls
  });

  return {
    providers,
    preferred_provider_id: (compatiblePreferred as any)?.id ?? null,
    email_preview: { subject, body },
    // Documents that will ride along with the outbound email — dec page on
    // insurance, loan statement on refinance, registration on sale outreach.
    // Surfaced to the dispatch UI so the user sees what's being sent before
    // tapping Send. The actual bytes are resolved at send time, not here.
    planned_attachments: await planAttachmentsForDispatch({
      userId,
      vehicleId: vehicle.id,
      taskType
    }),
    // Insurance providers need a DL number/state to issue a real quote.
    // Surface this to the frontend so the UI can collect it before dispatch
    // instead of bouncing the user halfway through. Only insurance_quote
    // requires it; other dispatchable types don't.
    requires_dl: await isDlRequiredForTask(userId, taskType)
  };
}

/**
 * Returns true if the user is missing a DL on file AND this task type needs
 * one for providers to issue a quote. Today: insurance_quote only.
 */
async function isDlRequiredForTask(
  userId: string,
  taskType: DispatchableTaskType
): Promise<boolean> {
  if (taskType !== "insurance_quote") return false;
  const pii = await one(
    supabaseAdmin
      .from("user_pii")
      .select("dl_collected_at")
      .eq("user_id", userId)
  );
  return !(pii as any)?.dl_collected_at;
}

router.get("/api/tasks/:id/dispatch-preview", async (req, res) => {
  const taskId = z.string().uuid().parse(req.params.id);
  const task = await one(req.db!.from("vehicle_tasks").select("*").eq("id", taskId));
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!isDispatchable((task as any).task_type)) {
    return res.status(400).json({ error: "Task type is not dispatchable" });
  }
  const vehicle = await one(
    req.db!.from("vehicles").select("*").eq("id", (task as any).vehicle_id)
  );
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

  const payload = await buildDispatchPayload(
    req.user!.id,
    vehicle,
    task,
    (task as any).task_type as DispatchableTaskType
  );
  if (!payload) return res.status(400).json({ error: "Could not build dispatch payload" });

  return res.json({ action: "open_dispatch", task, ...payload });
});

router.post("/api/tasks/:id/dispatch", async (req, res) => {
  const taskId = z.string().uuid().parse(req.params.id);
  const schema = z.object({
    provider_ids: z.array(z.string().uuid()).min(1).max(10),
    preferred_id: z.string().uuid().nullable().optional(),
    custom_subject: z.string().optional(),
    custom_body: z.string().optional(),
    overrides: z
      .record(z.object({ email: z.string().email().optional() }))
      .optional()
  });
  const { provider_ids, preferred_id, custom_subject, custom_body, overrides } =
    schema.parse(req.body ?? {});

  const task = await one(req.db!.from("vehicle_tasks").select("*").eq("id", taskId));
  if (!task) return res.status(404).json({ error: "Task not found" });

  // Pro gate — actual outbound email is Pro-only.
  if (!(await isPro(req.user!.id))) {
    return res
      .status(402)
      .json({ error: "Automoteev Pro is required to dispatch outreach to providers." });
  }

  const [profile, vehicle, providers] = await Promise.all([
    one(req.db!.from("profiles").select("*").eq("id", req.user!.id)),
    one(req.db!.from("vehicles").select("*").eq("id", (task as any).vehicle_id)),
    req.db!.from("providers").select("*").in("id", provider_ids)
  ]);
  if (!profile || !vehicle) {
    return res.status(400).json({ error: "Missing profile or vehicle" });
  }
  if (!(profile as any).agent_email_local) {
    return res.status(400).json({
      error: "Agent email alias not assigned. Re-run onboarding to resolve."
    });
  }
  const providerRows = (providers.data ?? []) as any[];
  if (providerRows.length === 0) {
    return res.status(400).json({ error: "No providers found for given IDs" });
  }

  // Apply per-provider email overrides from the modal (user can edit a guessed email).
  // Then resolve each provider's effective send-to address: learned dept contact > published.
  const taskTypeForDept = (task as any).task_type as string;
  const dispatchDept = taskTypeToContactDept(taskTypeForDept);

  // Bulk-lookup community contacts for every provider's business so the
  // shared-pool address is available alongside published / per-user.
  const dispatchBusinessIds = providerRows
    .map((p) => p.business_id as string | null)
    .filter((id): id is string => Boolean(id));
  const dispatchSharedMap = await lookupSharedContactsBulk({
    business_ids: dispatchBusinessIds,
    dept: dispatchDept
  });

  for (const p of providerRows) {
    const override = overrides?.[p.id]?.email;
    if (override && override !== p.email) {
      const updatedContacts = {
        ...((p.contacts ?? {}) as Record<string, string>),
        [dispatchDept]: override
      };
      await req.db!.from("providers").update({ contacts: updatedContacts }).eq("id", p.id);
      p.contacts = updatedContacts;
    }
    const community = p.business_id ? dispatchSharedMap.get(p.business_id) : undefined;
    p._send_to = pickProviderEmailForDept(
      p.contacts as Record<string, string>,
      p.email,
      dispatchDept,
      community?.email ?? null
    );
  }

  // Mark the chosen one as preferred (and unset others for this user).
  if (preferred_id) {
    await supabaseAdmin
      .from("providers")
      .update({ is_preferred: false })
      .eq("user_id", req.user!.id)
      .eq("is_preferred", true);
    await supabaseAdmin
      .from("providers")
      .update({ is_preferred: true })
      .eq("id", preferred_id)
      .eq("user_id", req.user!.id);
  }

  const vehicleName =
    `${(vehicle as any).year ?? ""} ${(vehicle as any).make ?? ""} ${(vehicle as any).model ?? ""}`.trim() ||
    "vehicle";

  // Re-fetch recalls for the actual send (in case the user reviewed the
  // preview but recall data updated since).
  let recalls: { nhtsa_campaign_id: string; component: string | null }[] = [];
  const taskTypeForEmail = (task as any).task_type as string;
  if (taskTypeForEmail === "recall_repair" || taskTypeForEmail === "recall_appointment") {
    const { data: recallRows } = await supabaseAdmin
      .from("recalls")
      .select("nhtsa_campaign_id, component")
      .eq("vehicle_id", (task as any).vehicle_id)
      .is("resolved_at", null);
    recalls = recallRows ?? [];
  }

  const subject =
    custom_subject ??
    taskEmailSubject((task as any).task_type as TaskType, vehicleName, {
      recallCount: recalls.length
    });
  const text =
    custom_body ??
    taskEmailBody({
      type: (task as any).task_type as TaskType,
      userName: (profile as any).full_name,
      vehicleName,
      vin: (vehicle as any).vin,
      mileage: (vehicle as any).mileage,
      notes: null,
      recalls
    });

  // Send to each provider that has an email. Track skips for the response.
  // Resolve any planned attachments ONCE here — same bytes go to every
  // recipient, so we don't re-download per provider.
  const plannedAttachments = await planAttachmentsForDispatch({
    userId: req.user!.id,
    vehicleId: (task as any).vehicle_id,
    taskType: taskTypeForEmail
  });
  const resolvedAttachments = await resolveAttachmentsForDispatch(plannedAttachments);

  let sent = 0;
  const skipped: Array<{ provider_id: string; reason: string }> = [];
  const sentLogs: any[] = [];
  for (const p of providerRows) {
    if (!p._send_to) {
      skipped.push({ provider_id: p.id, reason: "no_email" });
      continue;
    }
    try {
      const result = await sendTaskEmail({
        to: p._send_to,
        fromLocal: (profile as any).agent_email_local,
        fromDisplayName: (profile as any).full_name,
        subject,
        body: text,
        attachments: resolvedAttachments.length
          ? resolvedAttachments.map((a) => ({
              filename: a.filename,
              content_base64: a.content_base64,
              content_type: a.content_type
            }))
          : undefined
      });
      // sendTaskEmail does NOT throw on Resend errors — it returns
      // status: "error" with the message. Treat anything that wasn't a
      // genuine send (or the dev-mode no-resend-key skip) as a skip so
      // the sent counter, autonomy progression, and task status all
      // reflect reality. Without this check, a Resend outage looked like
      // a successful dispatch and advanced the user's autonomy level.
      const wasSent = result.status === "sent" || result.status === "skipped_no_resend_key";
      const { data: log } = await req
        .db!.from("task_emails")
        .insert({
          user_id: req.user!.id,
          task_id: taskId,
          provider_id: p.id,
          to_email: p._send_to,
          from_email: result.from,
          subject,
          body_text: text,
          status: result.status,
          provider_message_id: result.providerMessageId,
          direction: "outbound",
          thread_id: result.providerMessageId ?? null
        })
        .select()
        .single();
      if (log) sentLogs.push(log);
      if (wasSent) {
        sent++;
      } else {
        skipped.push({
          provider_id: p.id,
          reason: result.error ?? `send_${result.status}`
        });
      }
    } catch (err) {
      skipped.push({
        provider_id: p.id,
        reason: err instanceof Error ? err.message : "send_failed"
      });
    }
  }

  // Status transitions: dispatching IS the approval, so move directly to
  // waiting_on_provider (skip the intermediate 'approved' state).
  await req
    .db!.from("vehicle_tasks")
    .update({
      status: sent > 0 ? "waiting_on_provider" : "failed",
      approved_at: new Date().toISOString()
    })
    .eq("id", taskId);

  // Count this as ONE approved send for autonomy (not N — it was one user click).
  let autonomy = await getAutonomyState(req.user!.id);
  if (sent > 0) {
    autonomy = await recordApprovedSend(
      req.user!.id,
      ((task as any).category as any) ?? "general"
    );
  }

  // Record that the user just shopped insurance so the "shop insurance" insight
  // doesn't re-fire on the next Home / dashboard load. The insight engine reads
  // last_shopped_at via daysSinceLastInsuranceShop and suppresses for ~30d. We
  // hook this on dispatch (not on quote-completion) because dispatching IS the
  // user's act of shopping — the engine should stop nagging the moment quotes
  // go out, regardless of whether carriers reply. RLS-scoped req.db enforces
  // ownership; if the row isn't visible, the update affects 0 rows safely.
  if (
    sent > 0 &&
    (task as any).task_type === "insurance_quote" &&
    (task as any).vehicle_id
  ) {
    await req
      .db!.from("insurance_accounts")
      .update({ last_shopped_at: new Date().toISOString() })
      .eq("user_id", req.user!.id)
      .eq("vehicle_id", (task as any).vehicle_id);
  }

  await audit({
    userId: req.user!.id,
    taskId,
    vehicleId: (task as any).vehicle_id,
    eventType: "task_dispatched",
    summary: `Dispatched to ${sent} provider${sent === 1 ? "" : "s"}${skipped.length ? `, ${skipped.length} skipped` : ""}${preferred_id ? ", preferred saved" : ""}${resolvedAttachments.length ? `, ${resolvedAttachments.length} attachment${resolvedAttachments.length === 1 ? "" : "s"}` : ""}`,
    metadata: {
      sent,
      skipped,
      preferred_id,
      attachments: resolvedAttachments.map((a) => ({
        document_id: a.document_id,
        filename: a.filename,
        category: a.category
      }))
    }
  });

  return res.status(200).json({
    sent,
    skipped,
    emails: sentLogs,
    autonomy
  });
});

// ---------- Helpers ----------

async function one<T>(
  query: PromiseLike<{ data: T[] | T | null; error: unknown }>
): Promise<T | null> {
  const result = await query;
  if (Array.isArray(result.data)) return result.data[0] ?? null;
  return result.data ?? null;
}

async function importPlaidAccounts(params: {
  userId: string;
  plaidItemId: string;
  accessToken: string;
}) {
  const result = await getPlaidAccounts(params.accessToken);
  const rows = result.accounts.map((account) => plaidAccountRow({
    userId: params.userId,
    plaidItemId: params.plaidItemId,
    account
  }));
  if (!rows.length) return [];
  const { data, error } = await supabaseAdmin
    .from("plaid_accounts")
    .upsert(rows, { onConflict: "plaid_account_id" })
    .select("id, name, official_name, type, subtype, mask");
  if (error) throw new Error(error.message);
  return data ?? [];
}

function plaidAccountRow(params: {
  userId: string;
  plaidItemId: string;
  account: PlaidAccount;
}) {
  return {
    user_id: params.userId,
    plaid_item_id: params.plaidItemId,
    plaid_account_id: params.account.account_id,
    name: params.account.name,
    official_name: params.account.official_name,
    type: params.account.type,
    subtype: params.account.subtype,
    mask: params.account.mask,
    current_balance_cents: moneyToCents(params.account.balances.current),
    available_balance_cents: moneyToCents(params.account.balances.available),
    iso_currency_code: params.account.balances.iso_currency_code,
    raw: params.account
  };
}

async function upsertPlaidTransactions(params: {
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
    const accountMap = new Map(
      (accounts ?? []).map((a: any) => [a.plaid_account_id as string, a.id as string])
    );
    const rows = transactions.map((transaction) =>
      plaidTransactionRow({
        userId: params.userId,
        plaidItemId: params.plaidItemId,
        plaidAccountId: accountMap.get(transaction.account_id) ?? null,
        transaction
      })
    );
    const { error } = await supabaseAdmin
      .from("plaid_transactions")
      .upsert(rows, { onConflict: "plaid_transaction_id" });
    if (error) throw new Error(error.message);
  }

  if (params.removed.length) {
    const ids = params.removed.map((r) => r.transaction_id);
    const { error } = await supabaseAdmin
      .from("plaid_transactions")
      .update({ removed_at: new Date().toISOString() })
      .in("plaid_transaction_id", ids)
      .eq("user_id", params.userId);
    if (error) throw new Error(error.message);
  }
}

function plaidTransactionRow(params: {
  userId: string;
  plaidItemId: string;
  plaidAccountId: string | null;
  transaction: PlaidTransaction;
}) {
  return {
    user_id: params.userId,
    plaid_item_id: params.plaidItemId,
    plaid_account_id: params.plaidAccountId,
    plaid_transaction_id: params.transaction.transaction_id,
    name: params.transaction.name,
    merchant_name: params.transaction.merchant_name,
    amount_cents: moneyToCents(params.transaction.amount) ?? 0,
    iso_currency_code: params.transaction.iso_currency_code,
    date: params.transaction.date,
    authorized_date: params.transaction.authorized_date,
    category: params.transaction.category,
    payment_channel: params.transaction.payment_channel,
    pending: params.transaction.pending,
    removed_at: null,
    raw: params.transaction
  };
}

function moneyToCents(value: number | null | undefined) {
  return value == null ? null : Math.round(value * 100);
}

function redactPlaidItem(item: any) {
  const { access_token_encrypted: _accessToken, ...safe } = item;
  return safe;
}

router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    return res.status(422).json({ error: "Validation failed", issues: error.issues });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return res.status(500).json({ error: message });
});
