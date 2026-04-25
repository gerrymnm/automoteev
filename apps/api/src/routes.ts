import { Router, type NextFunction, type Request, type Response } from "express";
import "express-async-errors";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { audit } from "./audit.js";
import { env } from "./config.js";
import { calculateCosts } from "./engines/cost.js";
import { generateAlerts, statusFromAlerts } from "./engines/alerts.js";
import { generateInsights, statusFromInsights } from "./engines/insights.js";
import { estimateVehicleValue } from "./services/valuation.js";
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
  void (async () => {
    try {
      const recall = await lookupRecallsByVehicle({
        make: decoded.make,
        model: decoded.model,
        modelYear: decoded.year
      });
      if (recall.campaigns.length) {
        await req.db!.from("recalls").upsert(
          recall.campaigns.map((c) => ({
            user_id: req.user!.id,
            vehicle_id: vehicle.id,
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
        .update({ recall_status: recall.hasOpenRecall ? "open" : "clear" })
        .eq("id", vehicle.id);
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
    fuelRes
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
      .limit(1)
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
    daysSinceLastInsuranceShop
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

  // Count this as an approved send (will auto-unlock autonomy at threshold)
  const newAutonomy = await recordApprovedSend(req.user!.id);

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
