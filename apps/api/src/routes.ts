import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { audit } from "./audit.js";
import { calculateCosts } from "./engines/cost.js";
import { generateAlerts, statusFromAlerts } from "./engines/alerts.js";
import { maintenanceDue } from "./engines/maintenance.js";
import { taskFromCommand } from "./engines/tasks.js";
import { decodeVin } from "./services/vin.js";
import { lookupRecallsByVin } from "./services/recalls.js";
import { sendTaskEmail } from "./services/email.js";
import { taskEmailBody, taskEmailSubject } from "./services/emailTemplates.js";
import { createProCheckoutSession } from "./services/stripe.js";
import { supabaseAdmin } from "./supabase.js";
import { approvalSchema, onboardingSchema, profileSchema, providerSchema, taskCommandSchema, taskCreateSchema } from "./validators.js";
import type { TaskType } from "./types.js";

export const router = Router();

router.get("/health", (_req, res) => {
  res.json({ ok: true, service: "automoteev-api" });
});

router.use("/api", requireAuth);

router.get("/api/profile", async (req, res) => {
  const { data, error } = await req.db!.from("profiles").select("*").eq("id", req.user!.id).maybeSingle();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ profile: data });
});

router.put("/api/profile", async (req, res) => {
  const payload = profileSchema.parse(req.body);
  const { data, error } = await req.db!
    .from("profiles")
    .upsert({ id: req.user!.id, ...payload }, { onConflict: "id" })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await audit({ userId: req.user!.id, eventType: "profile_updated", summary: "Profile updated" });
  return res.json({ profile: data });
});

router.post("/api/onboarding", async (req, res) => {
  const payload = onboardingSchema.parse(req.body);
  const decoded = await decodeVin(payload.vin);

  const { data: profile, error: profileError } = await req.db!
    .from("profiles")
    .upsert({ id: req.user!.id, full_name: payload.full_name, email: payload.email, zip_code: payload.zip_code }, { onConflict: "id" })
    .select()
    .single();
  if (profileError) return res.status(400).json({ error: profileError.message });

  const maintenance = maintenanceDue({ mileage: payload.mileage, next_service_due_miles: null, obd_mileage: null });
  const { data: vehicle, error: vehicleError } = await req.db!
    .from("vehicles")
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
      next_service_due_miles: maintenance.next_service_due_miles,
      recall_status: "unknown",
      overall_status: "action_recommended"
    })
    .select()
    .single();
  if (vehicleError) return res.status(400).json({ error: vehicleError.message });

  const costs = calculateCosts({
    monthly_payment_cents: payload.monthly_payment_cents,
    insurance_premium_cents: payload.insurance_premium_cents
  });
  await req.db!.from("vehicle_cost_profiles").insert({ user_id: req.user!.id, vehicle_id: vehicle.id, ...costs });

  if (payload.ownership_type !== "owned" || payload.lender_name || payload.loan_lease_balance_cents) {
    await req.db!.from("loan_lease_accounts").insert({
      user_id: req.user!.id,
      vehicle_id: vehicle.id,
      lender_name: payload.lender_name,
      apr_bps: payload.apr_bps,
      balance_cents: payload.loan_lease_balance_cents,
      monthly_payment_cents: payload.monthly_payment_cents,
      lease_maturity_date: payload.lease_maturity_date
    });
  }

  if (payload.insurance_carrier || payload.insurance_premium_cents || payload.insurance_renewal_date) {
    await req.db!.from("insurance_accounts").insert({
      user_id: req.user!.id,
      vehicle_id: vehicle.id,
      carrier_name: payload.insurance_carrier,
      premium_cents: payload.insurance_premium_cents,
      renewal_date: payload.insurance_renewal_date
    });
  }

  await audit({ userId: req.user!.id, vehicleId: vehicle.id, eventType: "onboarding_completed", summary: "Owner completed onboarding" });
  return res.status(201).json({ profile, vehicle });
});

router.get("/api/vehicles", async (req, res) => {
  const { data, error } = await req.db!.from("vehicles").select("*").order("created_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ vehicles: data });
});

router.get("/api/vehicles/:id/dashboard", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.id);
  const vehicle = await one(req.db!.from("vehicles").select("*").eq("id", vehicleId));
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

  const [costProfile, loanLease, insurance, alerts] = await Promise.all([
    one(req.db!.from("vehicle_cost_profiles").select("*").eq("vehicle_id", vehicleId)),
    one(req.db!.from("loan_lease_accounts").select("*").eq("vehicle_id", vehicleId)),
    one(req.db!.from("insurance_accounts").select("*").eq("vehicle_id", vehicleId)),
    req.db!.from("vehicle_alerts").select("*").eq("vehicle_id", vehicleId).eq("is_resolved", false).order("created_at", { ascending: false })
  ]);

  return res.json({
    vehicle,
    cost_profile: costProfile,
    loan_lease: loanLease,
    insurance,
    alerts: alerts.data ?? [],
    recommended_action: (alerts.data ?? [])[0] ?? null
  });
});

router.put("/api/vehicles/:id/cost-profile", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.id);
  const costs = calculateCosts(req.body);
  const { data, error } = await req.db!
    .from("vehicle_cost_profiles")
    .upsert({ user_id: req.user!.id, vehicle_id: vehicleId, ...costs }, { onConflict: "vehicle_id" })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await audit({ userId: req.user!.id, vehicleId, eventType: "cost_profile_updated", summary: "Cost profile recalculated" });
  return res.json({ cost_profile: data });
});

router.post("/api/vehicles/:id/alerts/regenerate", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.id);
  const vehicle = await one(req.db!.from("vehicles").select("*").eq("id", vehicleId));
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

  const [costProfile, loanLease, insurance] = await Promise.all([
    one(req.db!.from("vehicle_cost_profiles").select("*").eq("vehicle_id", vehicleId)),
    one(req.db!.from("loan_lease_accounts").select("*").eq("vehicle_id", vehicleId)),
    one(req.db!.from("insurance_accounts").select("*").eq("vehicle_id", vehicleId))
  ]);
  const generated = generateAlerts({ vehicle, costProfile, loanLease, insurance });

  await req.db!.from("vehicle_alerts").update({ is_resolved: true }).eq("vehicle_id", vehicleId).eq("is_resolved", false);
  if (generated.length) {
    await req.db!.from("vehicle_alerts").insert(generated.map((alert) => ({ user_id: req.user!.id, vehicle_id: vehicleId, ...alert })));
  }
  await req.db!.from("vehicles").update({ overall_status: statusFromAlerts(generated) }).eq("id", vehicleId);
  await audit({ userId: req.user!.id, vehicleId, eventType: "alerts_regenerated", summary: "Vehicle alerts regenerated" });

  return res.json({ alerts: generated });
});

router.get("/api/alerts", async (req, res) => {
  const { data, error } = await req.db!.from("vehicle_alerts").select("*").eq("is_resolved", false).order("created_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ alerts: data });
});

router.get("/api/tasks", async (req, res) => {
  const { data, error } = await req.db!.from("vehicle_tasks").select("*").order("created_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ tasks: data });
});

router.post("/api/tasks", async (req, res) => {
  const payload = taskCreateSchema.parse(req.body);
  const { data, error } = await req.db!
    .from("vehicle_tasks")
    .insert({ user_id: req.user!.id, ...payload, status: "created" })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await audit({ userId: req.user!.id, taskId: data.id, vehicleId: payload.vehicle_id, eventType: "task_created", summary: data.title });
  return res.status(201).json({ task: data });
});

router.post("/api/tasks/command", async (req, res) => {
  const payload = taskCommandSchema.parse(req.body);
  const mapped = taskFromCommand(payload.command);
  const { data, error } = await req.db!
    .from("vehicle_tasks")
    .insert({
      user_id: req.user!.id,
      vehicle_id: payload.vehicle_id,
      ...mapped,
      description: payload.command
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await audit({ userId: req.user!.id, taskId: data.id, vehicleId: payload.vehicle_id, eventType: "command_to_task", summary: `Command converted to ${mapped.task_type}` });
  return res.status(201).json({ task: data });
});

router.post("/api/tasks/:id/approval", async (req, res) => {
  const taskId = z.string().uuid().parse(req.params.id);
  const payload = approvalSchema.parse(req.body);
  const status = payload.approved ? "approved" : "cancelled";
  const { data, error } = await req.db!.from("vehicle_tasks").update({ status, approved_at: payload.approved ? new Date().toISOString() : null }).eq("id", taskId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await audit({ userId: req.user!.id, taskId, vehicleId: data.vehicle_id, eventType: payload.approved ? "task_approved" : "task_cancelled", summary: payload.approved ? "Owner approved external action" : "Owner cancelled task" });
  return res.json({ task: data });
});

router.post("/api/tasks/:id/emails", async (req, res) => {
  const taskId = z.string().uuid().parse(req.params.id);
  const body = z.object({ provider_id: z.string().uuid(), notes: z.string().optional().nullable() }).parse(req.body);
  const task = await one(req.db!.from("vehicle_tasks").select("*").eq("id", taskId));
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (task.status !== "approved") return res.status(409).json({ error: "Task must be approved before email outreach" });
  const currentProfile = await one(req.db!.from("profiles").select("*").eq("id", req.user!.id));
  if (currentProfile?.plan !== "pro") return res.status(402).json({ error: "Automoteev Pro is required for provider email outreach." });

  const [profile, vehicle, provider] = await Promise.all([
    Promise.resolve(currentProfile),
    one(req.db!.from("vehicles").select("*").eq("id", task.vehicle_id)),
    one(req.db!.from("providers").select("*").eq("id", body.provider_id))
  ]);
  if (!profile || !vehicle || !provider?.email) return res.status(400).json({ error: "Missing profile, vehicle, or provider email" });

  const vehicleName = `${vehicle.year ?? ""} ${vehicle.make ?? ""} ${vehicle.model ?? ""}`.trim() || "vehicle";
  const subject = taskEmailSubject(task.task_type as TaskType, vehicleName);
  const text = taskEmailBody({
    type: task.task_type as TaskType,
    userName: profile.full_name,
    vehicleName,
    vin: vehicle.vin,
    mileage: vehicle.mileage,
    notes: body.notes
  });
  const sent = await sendTaskEmail({ to: provider.email, subject, body: text });

  const { data: emailLog, error } = await req.db!
    .from("task_emails")
    .insert({
      user_id: req.user!.id,
      task_id: taskId,
      provider_id: provider.id,
      to_email: provider.email,
      from_email: "tasks@automoteev.com",
      subject,
      body_text: text,
      status: sent.status,
      provider_message_id: sent.providerMessageId
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  await req.db!.from("vehicle_tasks").update({ status: "waiting_on_provider" }).eq("id", taskId);
  await audit({ userId: req.user!.id, taskId, vehicleId: task.vehicle_id, eventType: "email_sent", summary: `Email logged for ${provider.name}` });
  return res.status(201).json({ email: emailLog });
});

router.get("/api/tasks/:id/history", async (req, res) => {
  const taskId = z.string().uuid().parse(req.params.id);
  const [emails, auditLogs] = await Promise.all([
    req.db!.from("task_emails").select("*").eq("task_id", taskId).order("created_at", { ascending: false }),
    req.db!.from("task_audit_logs").select("*").eq("task_id", taskId).order("created_at", { ascending: false })
  ]);
  return res.json({ emails: emails.data ?? [], audit_logs: auditLogs.data ?? [], provider_responses: [] });
});

router.get("/api/providers", async (req, res) => {
  const { data, error } = await req.db!.from("providers").select("*").order("created_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ providers: data });
});

router.post("/api/providers", async (req, res) => {
  const payload = providerSchema.parse(req.body);
  const { data, error } = await req.db!.from("providers").insert({ user_id: req.user!.id, ...payload }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  return res.status(201).json({ provider: data });
});

router.post("/api/recalls/check/:vehicleId", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.vehicleId);
  const vehicle = await one(req.db!.from("vehicles").select("*").eq("id", vehicleId));
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });
  const result = await lookupRecallsByVin(vehicle.vin);
  await req.db!.from("vehicles").update({ recall_status: result.hasOpenRecall ? "open" : "clear" }).eq("id", vehicleId);
  const { data: task } = await req.db!
    .from("vehicle_tasks")
    .insert({ user_id: req.user!.id, vehicle_id: vehicleId, task_type: "recall_check", title: "Recall check", status: "completed", description: result.summary })
    .select()
    .single();
  await audit({ userId: req.user!.id, taskId: task?.id, vehicleId, eventType: "recall_checked", summary: result.summary });
  return res.json({ recall: result, task });
});

router.get("/api/maintenance/:vehicleId", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.vehicleId);
  const vehicle = await one(req.db!.from("vehicles").select("*").eq("id", vehicleId));
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });
  return res.json({ maintenance: maintenanceDue(vehicle) });
});

router.put("/api/insurance/:vehicleId", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.vehicleId);
  const payload = z.object({ carrier_name: z.string().nullable(), premium_cents: z.number().int().nullable(), renewal_date: z.string().nullable() }).parse(req.body);
  const { data, error } = await req.db!.from("insurance_accounts").upsert({ user_id: req.user!.id, vehicle_id: vehicleId, ...payload }, { onConflict: "vehicle_id" }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ insurance: data });
});

router.put("/api/loan-lease/:vehicleId", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.vehicleId);
  const payload = z.object({
    lender_name: z.string().nullable(),
    apr_bps: z.number().int().nullable(),
    balance_cents: z.number().int().nullable(),
    monthly_payment_cents: z.number().int().nullable(),
    lease_maturity_date: z.string().nullable()
  }).parse(req.body);
  const { data, error } = await req.db!.from("loan_lease_accounts").upsert({ user_id: req.user!.id, vehicle_id: vehicleId, ...payload }, { onConflict: "vehicle_id" }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ loan_lease: data });
});

router.post("/api/sell-vehicle/:vehicleId", async (req, res) => {
  const vehicleId = z.string().uuid().parse(req.params.vehicleId);
  const payload = z.object({
    mileage: z.number().int().nonnegative(),
    condition: z.enum(["excellent", "good", "fair", "poor"]),
    payoff_amount_cents: z.number().int().nonnegative().nullable(),
    notes: z.string().optional().nullable()
  }).parse(req.body);
  const { data, error } = await req.db!
    .from("vehicle_tasks")
    .insert({
      user_id: req.user!.id,
      vehicle_id: vehicleId,
      task_type: "sell_vehicle",
      title: "Prepare sale package",
      status: "needs_user_approval",
      description: "Confirm mileage, condition, payoff, photos placeholder, and valuation before sale outreach.",
      approval_summary: "Automoteev will prepare a sale package and contact buying providers only after approval.",
      shared_fields: ["name", "email", "vehicle", "VIN", "mileage", "condition", "payoff amount"],
      metadata: payload
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await audit({ userId: req.user!.id, taskId: data.id, vehicleId, eventType: "sell_flow_started", summary: "Sale preparation task created" });
  return res.status(201).json({ task: data });
});

router.post("/api/billing/create-checkout-session", async (req, res) => {
  const session = await createProCheckoutSession({ userId: req.user!.id, email: req.user!.email });
  return res.json(session);
});

router.post("/api/jobs/:jobName/run", async (req, res) => {
  const jobName = z.enum(["daily-recalls", "insurance-renewals", "lease-maturity", "maintenance-due", "weekly-value-refresh"]).parse(req.params.jobName);
  await audit({ userId: req.user!.id, eventType: "job_placeholder_run", summary: `Placeholder job run: ${jobName}` });
  return res.json({ ok: true, job: jobName, mode: "placeholder" });
});

async function one<T>(query: PromiseLike<{ data: T[] | T | null; error: unknown }>): Promise<T | null> {
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
