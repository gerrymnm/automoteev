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
import { estimateVehicleValue } from "./services/valuation.js";
import {
  uploadDocument,
  extractDocument,
  applyExtractedDocument,
  type DocumentKind
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
import { lookupRecallsByVehicle } from "./services/recalls.js";
import { sendTaskEmail } from "./services/email.js";
import { taskEmailBody, taskEmailSubject } from "./services/emailTemplates.js";
import { createProCheckoutSession } from "./services/stripe.js";
import { searchProviders } from "./services/places.js";
import { discoverProvidersForTask, isDispatchable, type DispatchableTaskType } from "./services/dealer-discovery.js";
import { getGasPrice, getMaintenanceCost } from "./services/market.js";
import { assignAgentEmailLocal, composeAgentAddress } from "./services/alias.js";
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

  // Estimate value up front so dashboard isn't blank.
  const valuation = estimateVehicleValue({
    year: decoded.year,
    make: decoded.make,
    model: decoded.model,
    mileage: payload.mileage
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
      estimated_value_cents:
        valuation
          ? Math.round((valuation.market_value_low_cents + valuation.market_value_high_cents) / 2)
          : null,
      market_value_low_cents: valuation?.market_value_low_cents ?? null,
      market_value_high_cents: valuation?.market_value_high_cents ?? null,
      dealer_value_low_cents: valuation?.dealer_value_low_cents ?? null,
      dealer_value_high_cents: valuation?.dealer_value_high_cents ?? null,
      value_estimated_at: valuation ? new Date().toISOString() : null,
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
  const recallMake = decoded.make;
  const recallModel = decoded.model;
  const recallYear = decoded.year;
  void (async () => {
    try {
      // NHTSA recall API is sometimes case-sensitive on model. Normalize aggressively.
      const normalizedMake = recallMake?.trim().toUpperCase() ?? null;
      // Try the model as-is first, then uppercase, then strip extra whitespace.
      const modelCandidates = [
        recallModel?.trim() ?? null,
        recallModel?.trim().toUpperCase() ?? null,
        recallModel?.replace(/\s+/g, " ").trim() ?? null
      ].filter((m): m is string => Boolean(m));
      const uniqueModels = Array.from(new Set(modelCandidates));

      let recall;
      for (const candidate of uniqueModels) {
        recall = await lookupRecallsByVehicle({
          make: normalizedMake,
          model: candidate,
          modelYear: recallYear
        });
        if (recall.source === "nhtsa") break; // Got a real response, even if 0 campaigns.
      }
      if (!recall) return;

      console.log(
        `[onboarding] recall lookup for ${normalizedMake} ${recallModel} ${recallYear}: ${recall.campaigns.length} campaign(s), source=${recall.source}`
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
      }
      await supabaseAdmin
        .from("vehicles")
        .update({ recall_status: recall.hasOpenRecall ? "open" : "clear" })
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
      .in("status", ["needs_user_approval", "approved", "in_progress", "waiting_on_provider"])
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

  const result = await lookupRecallsByVehicle({
    make: vehicle.make,
    model: vehicle.model,
    modelYear: vehicle.year
  });

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
  }

  await req
    .db!.from("vehicles")
    .update({ recall_status: result.hasOpenRecall ? "open" : "clear" })
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
          dl_collected_at: data.dl_collected_at
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
      "insurance-renewals",
      "lease-maturity",
      "maintenance-due",
      "weekly-value-refresh",
      "onboarding-nudges"
    ])
    .parse(req.params.jobName);
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
  const vehicle = await one(
    req.db!.from("vehicles").select("*").eq("id", vehicleId)
  );
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

  const valuation = estimateVehicleValue({
    year: vehicle.year,
    make: vehicle.make,
    model: vehicle.model,
    mileage: vehicle.mileage
  });
  if (!valuation) {
    return res.status(422).json({ error: "Cannot estimate value without year/make/model." });
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
    summary: "Vehicle value estimate refreshed"
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
        .in("status", ["needs_user_approval", "approved", "in_progress", "waiting_on_provider"])
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
    // Trigger the same recall lookup as the onboarding background promise.
    const recall = await lookupRecallsByVehicle({
      make: vehicle.make?.trim().toUpperCase() ?? null,
      model: vehicle.model?.trim() ?? null,
      modelYear: vehicle.year
    });

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
    }
    await supabaseAdmin
      .from("vehicles")
      .update({ recall_status: recall.hasOpenRecall ? "open" : "clear" })
      .eq("id", vehicle_id);

    return res.json({
      action: "recall_check_run",
      recall_status: recall.hasOpenRecall ? "open" : "clear",
      campaign_count: recall.campaigns.length
    });
  }

  return res.status(400).json({ error: "Unsupported action type" });
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
      "other"
    ]),
    vehicle_id: z.string().uuid().optional()
  });
  const { document_kind, vehicle_id } = schema.parse(req.body);

  const allowed = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];
  if (!allowed.includes(file.mimetype)) {
    return res.status(415).json({ error: `Unsupported mime type: ${file.mimetype}` });
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

// ---------- Dispatch (send approved task to many providers in one go) ----------

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

  // Discover up to 5 candidates via Google Places.
  const discovered = await discoverProvidersForTask({
    taskType,
    vehicleMake: vehicle.make ?? null,
    zipCode: (profile as any).zip_code ?? null,
    maxResults: 5
  });

  // Upsert each discovered provider so it has an id we can dispatch to.
  // Dedupe on (user_id, name, location) which is good enough for MVP.
  const inserted: any[] = [];
  for (const d of discovered) {
    const { data: existing } = await supabaseAdmin
      .from("providers")
      .select("*")
      .eq("user_id", userId)
      .eq("name", d.name)
      .eq("location", d.location ?? "")
      .maybeSingle();

    if (existing) {
      // Refresh email if we now have a derived one and the row didn't.
      if (!existing.email && d.derived_email) {
        await supabaseAdmin
          .from("providers")
          .update({ email: d.derived_email })
          .eq("id", existing.id);
        existing.email = d.derived_email;
      }
      inserted.push({
        ...existing,
        derived_email_basis: existing.email === d.derived_email ? d.derived_email_basis : "verified",
        rating: d.rating,
        rating_count: d.rating_count,
        website: d.website
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
          is_preferred: false
        })
        .select()
        .single();
      if (created) {
        inserted.push({
          ...created,
          derived_email_basis: d.derived_email_basis,
          rating: d.rating,
          rating_count: d.rating_count,
          website: d.website
        });
      }
    }
  }

  // If user has a preferred provider that's not in the discovered list, prepend it.
  let providers = inserted;
  if (existingPreferred && !providers.find((p) => p.id === (existingPreferred as any).id)) {
    providers = [
      {
        ...(existingPreferred as any),
        derived_email_basis: "verified",
        rating: null,
        rating_count: null,
        website: null
      },
      ...providers
    ];
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
    preferred_provider_id: (existingPreferred as any)?.id ?? null,
    email_preview: { subject, body }
  };
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
  for (const p of providerRows) {
    const override = overrides?.[p.id]?.email;
    if (override && override !== p.email) {
      await req.db!.from("providers").update({ email: override }).eq("id", p.id);
      p.email = override;
    }
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
  let sent = 0;
  const skipped: Array<{ provider_id: string; reason: string }> = [];
  const sentLogs: any[] = [];
  for (const p of providerRows) {
    if (!p.email) {
      skipped.push({ provider_id: p.id, reason: "no_email" });
      continue;
    }
    try {
      const result = await sendTaskEmail({
        to: p.email,
        fromLocal: (profile as any).agent_email_local,
        fromDisplayName: (profile as any).full_name,
        subject,
        body: text
      });
      const { data: log } = await req
        .db!.from("task_emails")
        .insert({
          user_id: req.user!.id,
          task_id: taskId,
          provider_id: p.id,
          to_email: p.email,
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
      sent++;
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

  await audit({
    userId: req.user!.id,
    taskId,
    vehicleId: (task as any).vehicle_id,
    eventType: "task_dispatched",
    summary: `Dispatched to ${sent} provider${sent === 1 ? "" : "s"}${skipped.length ? `, ${skipped.length} skipped` : ""}${preferred_id ? ", preferred saved" : ""}`,
    metadata: { sent, skipped, preferred_id }
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

router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    return res.status(422).json({ error: "Validation failed", issues: error.issues });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return res.status(500).json({ error: message });
});
