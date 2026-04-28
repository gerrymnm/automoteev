import { Router, type Request, type Response } from "express";
import type Stripe from "stripe";
import { Webhook } from "svix";
import { env } from "./config.js";
import { supabaseAdmin } from "./supabase.js";
import { stripe, verifyStripeWebhook } from "./services/stripe.js";
import { taskTypeToContactDept, shouldLearnContact } from "./services/contacts.js";
import { recordVerifiedContact } from "./services/business-directory.js";
import { sendPushToUser } from "./services/push.js";
import { classifyReply } from "./services/reply-classifier.js";
import { uploadDocument, extractDocument, type DocumentKind } from "./services/documents.js";

export const webhooks = Router();

/**
 * Stripe subscription webhook.
 * Stripe uses its own HMAC scheme (NOT Svix), handled by stripe.webhooks.constructEvent.
 */
webhooks.post("/webhooks/stripe", async (req: Request, res: Response) => {
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: "stripe_not_configured" });
  }
  const sig = req.header("stripe-signature");
  if (!sig) return res.status(400).json({ error: "missing_signature" });

  let event: Stripe.Event;
  try {
    event = verifyStripeWebhook(req.body as Buffer, sig);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "invalid_signature" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.user_id;
        const plan = (session.metadata?.plan as "pro_monthly" | "pro_annual") ?? "pro_monthly";
        if (userId) {
          await upsertSubscription({
            userId,
            externalSubscriptionId: (session.subscription as string) ?? null,
            externalCustomerId: (session.customer as string) ?? null,
            plan,
            status: "active"
          });
          await supabaseAdmin.from("profiles").update({ plan: "pro" }).eq("id", userId);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.user_id;
        if (userId) {
          await upsertSubscription({
            userId,
            externalSubscriptionId: sub.id,
            externalCustomerId: (sub.customer as string) ?? null,
            plan:
              sub.items.data[0]?.price?.id === env.STRIPE_PRICE_ANNUAL
                ? "pro_annual"
                : "pro_monthly",
            status: mapStripeStatus(sub.status),
            currentPeriodEnd: sub.current_period_end
          });
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.user_id;
        if (userId) {
          await supabaseAdmin
            .from("subscriptions")
            .update({ status: "canceled" })
            .eq("user_id", userId);
          await supabaseAdmin.from("profiles").update({ plan: "free" }).eq("id", userId);
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error("stripe webhook processing error", err);
    return res.status(500).json({ error: "webhook_processing_error" });
  }

  return res.json({ received: true });
});

/**
 * Resend inbound webhook — dealer reply lands here.
 * Resend signs webhooks using Svix, so we use the svix library to verify.
 */
webhooks.post("/webhooks/email/inbound", async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;
  const verification = verifySvixSignature(req, rawBody, env.RESEND_INBOUND_WEBHOOK_SECRET);
  if (!verification.valid) {
    console.warn("inbound webhook signature failed:", verification.error);
    return res.status(401).json({ error: "invalid_signature", detail: verification.error });
  }

  const event = verification.payload as Record<string, any>;
  const data: Record<string, any> = event?.data ?? event; // Resend payloads sometimes nest under `data`

  console.log("[inbound] received event", {
    type: event?.type,
    from: data?.from,
    to: data?.to,
    subject: data?.subject
  });

  const toAddress = firstAddress(data?.to);
  const fromAddress = firstAddress(data?.from);
  if (!toAddress) return res.status(202).json({ ignored: true, reason: "no_to" });

  // Route by local-part: gerry.m@mail.automoteev.com → find profile by agent_email_local
  const localPart = toAddress.split("@")[0];
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("agent_email_local", localPart)
    .maybeSingle();

  if (!profile) {
    console.log("[inbound] unknown local-part, ignoring:", localPart);
    return res.status(202).json({ ignored: true, reason: "unknown_local", local: localPart });
  }

  const inReplyTo =
    data?.headers?.["in-reply-to"] ??
    data?.in_reply_to ??
    data?.inReplyTo ??
    null;
  const threadId = data?.threadId ?? inReplyTo ?? null;

  // Try to find the originating outbound email to link the thread.
  // Strategy: (1) exact match on In-Reply-To header (the spec-correct way),
  //           (2) fallback to sender-domain match against this user's most
  //               recent outbound emails (handles dealers who click "compose
  //               new" instead of "reply", which strips In-Reply-To).
  let taskId: string | null = null;
  let providerId: string | null = null;
  let originalToEmail: string | null = null;
  let matchStrategy: "in_reply_to" | "domain_fallback" | "none" = "none";

  if (inReplyTo) {
    const { data: original } = await supabaseAdmin
      .from("task_emails")
      .select("task_id, provider_id, to_email")
      .eq("provider_message_id", inReplyTo)
      .maybeSingle();
    if (original?.task_id) {
      taskId = original.task_id;
      providerId = original.provider_id ?? null;
      originalToEmail = original.to_email ?? null;
      matchStrategy = "in_reply_to";
    }
  }

  // Domain fallback: match the sender's domain against the recipient domain
  // of any of this user's recent outbound emails (last 30 days). The most
  // recent match wins. Only proceeds if In-Reply-To match failed.
  if (!taskId && fromAddress) {
    const fromDomain = fromAddress.split("@")[1]?.toLowerCase() ?? null;
    if (fromDomain) {
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const { data: recentOut } = await supabaseAdmin
        .from("task_emails")
        .select("task_id, provider_id, to_email")
        .eq("user_id", profile.id)
        .eq("direction", "outbound")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(50);

      const match = (recentOut ?? []).find((row: any) => {
        const toDomain = (row.to_email as string | null)?.split("@")[1]?.toLowerCase() ?? null;
        return toDomain === fromDomain;
      });
      if (match) {
        taskId = (match as any).task_id ?? null;
        providerId = (match as any).provider_id ?? null;
        originalToEmail = (match as any).to_email ?? null;
        matchStrategy = "domain_fallback";
      }
    }
  }

  console.log(
    `[inbound] match strategy=${matchStrategy} task=${taskId ?? "null"} provider=${providerId ?? "null"}`
  );

  // ---- Reply-learning (PER DEPARTMENT) -----------------------------------
  // A dealership has multiple humans in multiple inboxes — service writer,
  // sales rep, F&I, parts. We never overwrite one with the other. Instead,
  // we look up which DEPARTMENT this reply is for (based on the originating
  // task's task_type), and write only to provider.contacts[dept].
  //
  // The published address (providers.email) is left untouched — it remains
  // the fallback for new task types we haven't yet learned a contact for.
  if (providerId && fromAddress && originalToEmail && taskId) {
    try {
      const [{ data: taskRow }, { data: providerRow }] = await Promise.all([
        supabaseAdmin
          .from("vehicle_tasks")
          .select("task_type")
          .eq("id", taskId)
          .maybeSingle(),
        supabaseAdmin
          .from("providers")
          .select("contacts, email")
          .eq("id", providerId)
          .maybeSingle()
      ]);

      if (taskRow && providerRow) {
        const dept = taskTypeToContactDept((taskRow as any).task_type);
        const existingContacts = ((providerRow as any).contacts ?? {}) as Record<string, string>;
        const newAddr = shouldLearnContact({
          replyFrom: fromAddress,
          outboundTo: originalToEmail,
          existingForDept: existingContacts[dept]
        });

        if (newAddr) {
          const updatedContacts = { ...existingContacts, [dept]: newAddr };
          await supabaseAdmin
            .from("providers")
            .update({ contacts: updatedContacts })
            .eq("id", providerId);

          await supabaseAdmin.from("task_audit_logs").insert({
            user_id: profile.id,
            task_id: taskId,
            event_type: "provider_contact_learned",
            summary: `Learned ${dept} contact: ${newAddr} (replied from same domain as ${originalToEmail})`,
            metadata: {
              provider_id: providerId,
              dept,
              from: originalToEmail,
              to: newAddr,
              previous: existingContacts[dept] ?? null
            }
          });
          console.log(
            `[inbound] learned ${dept} contact for provider ${providerId}: ${originalToEmail} → ${newAddr}`
          );

          if ((providerRow as any).business_id) {
            await recordVerifiedContact({
              business_id: (providerRow as any).business_id,
              email: newAddr,
              dept,
              contact_name: null,
              user_id: (providerRow as any).user_id
            });
          }
        }
      }
    } catch (err) {
      console.error("[inbound] failed to learn provider contact (non-fatal)", err);
    }
  }
  // ------------------------------------------------------------------------

  // Insert with explicit error capture — the Supabase client returns
  // { error } rather than throwing on constraint failures, so without this
  // the webhook would silently lose inbound emails (as happened with the
  // first dealer reply where task_id was NOT NULL and we passed null).
  const { error: insertError } = await supabaseAdmin.from("task_emails").insert({
    user_id: profile.id,
    task_id: taskId,
    provider_id: providerId,
    to_email: toAddress,
    from_email: fromAddress ?? "unknown@unknown",
    subject: data?.subject ?? "(no subject)",
    body_text: data?.text ?? data?.html ?? "",
    status: "received",
    provider_message_id: data?.messageId ?? data?.message_id ?? null,
    direction: "inbound",
    thread_id: threadId,
    in_reply_to: inReplyTo,
    received_at: new Date().toISOString()
  });

  if (insertError) {
    console.error("[inbound] FAILED to store email:", insertError);
    return res.status(500).json({ error: "insert_failed", detail: insertError.message });
  }

  console.log(`[inbound] stored email for user: ${profile.id} (task=${taskId ?? "unlinked"})`);

  // -------- Inbound attachments --------------------------------------------
  // Resend delivers attachments inline as base64. Save each to Supabase
  // Storage under the user's documents bucket, create an uploaded_documents
  // row tied to the task, and trigger Claude vision classification. Each one
  // becomes a `document_attached` thread_event so the timeline shows what
  // arrived.
  const attachments = parseAttachments(data?.attachments);
  const attachedDocs: Array<{ id: string; file_name: string }> = [];
  if (attachments.length > 0 && taskId) {
    let taskTypeForClassify: string | null = null;
    let vehicleIdForAttachments: string | null = null;
    try {
      const { data: taskRow } = await supabaseAdmin
        .from("vehicle_tasks")
        .select("task_type, vehicle_id")
        .eq("id", taskId)
        .maybeSingle();
      taskTypeForClassify = (taskRow as any)?.task_type ?? null;
      vehicleIdForAttachments = (taskRow as any)?.vehicle_id ?? null;
    } catch {
      // best-effort
    }

    for (const att of attachments) {
      try {
        const kind = inferDocumentKindFromContext(
          taskTypeForClassify,
          att.filename
        );
        const doc = await uploadDocument({
          userId: profile.id,
          vehicleId: vehicleIdForAttachments,
          documentKind: kind,
          fileName: att.filename,
          mimeType: att.contentType,
          buffer: att.buffer
        });
        attachedDocs.push({ id: doc.id, file_name: doc.file_name });

        await supabaseAdmin.from("thread_events").insert({
          user_id: profile.id,
          task_id: taskId,
          kind: "document_attached",
          summary: `Provider attached "${att.filename}" — analyzing…`,
          detail: null,
          metadata: {
            document_id: doc.id,
            file_name: att.filename,
            mime_type: att.contentType,
            byte_size: att.buffer.length,
            source: "inbound_email"
          }
        });

        // Vision-classify in the background. Failures are logged but don't
        // block webhook acknowledgment.
        if (kind !== "other") {
          void extractDocument(doc.id).catch((err) =>
            console.error(`[inbound] extraction failed for ${doc.id}`, err)
          );
        }
      } catch (err) {
        console.error("[inbound] attachment storage failed", err);
      }
    }
    console.log(`[inbound] stored ${attachedDocs.length}/${attachments.length} attachment(s)`);
  }

  // -------- Reply classifier -------------------------------------------------
  // Run Claude on the inbound body to decide what kind of reply this is, then
  // either auto-act (acknowledgments) OR set a pending_user_action so the
  // home screen surfaces it as a Needs you card. Always emit an
  // agent_classification thread_event so the timeline shows the agent's
  // reasoning, even when no user action is needed.
  if (taskId) {
    let classification: Awaited<ReturnType<typeof classifyReply>> | null = null;
    try {
      const { data: taskCtx } = await supabaseAdmin
        .from("vehicle_tasks")
        .select("task_type, vehicle_id")
        .eq("id", taskId)
        .maybeSingle();
      const { data: vehicleCtx } = (taskCtx as any)?.vehicle_id
        ? await supabaseAdmin
            .from("vehicles")
            .select("year, make, model, vin, mileage")
            .eq("id", (taskCtx as any).vehicle_id)
            .maybeSingle()
        : { data: null };

      const { data: outboundRow } = await supabaseAdmin
        .from("task_emails")
        .select("subject, body_text")
        .eq("task_id", taskId)
        .eq("direction", "outbound")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const vehicleSummary = vehicleCtx
        ? `${(vehicleCtx as any).year ?? ""} ${(vehicleCtx as any).make ?? ""} ${(vehicleCtx as any).model ?? ""}, VIN ${(vehicleCtx as any).vin}, ${(vehicleCtx as any).mileage?.toLocaleString?.() ?? ""} mi`.trim()
        : "vehicle";

      classification = await classifyReply({
        taskType: (taskCtx as any)?.task_type ?? "unknown",
        vehicleSummary,
        outboundSubject: (outboundRow as any)?.subject ?? null,
        outboundBody: (outboundRow as any)?.body_text ?? null,
        inboundFrom: fromAddress ?? "unknown",
        inboundSubject: (data?.subject as string) ?? "(no subject)",
        inboundBody: (data?.text as string) ?? (data?.html as string) ?? ""
      });

      // Always log the classification on the thread.
      await supabaseAdmin.from("thread_events").insert({
        user_id: profile.id,
        task_id: taskId,
        kind: "agent_classification",
        summary: classification.summary,
        detail: classification.reasoning || null,
        metadata: {
          class: classification.class,
          fallback: classification.fallback,
          from: fromAddress,
          subject: data?.subject ?? null,
          match_strategy: matchStrategy,
          attachments: attachedDocs
        }
      });

      // If the classifier set a pending_user_action, surface it on the home
      // screen by writing it onto the task. We DON'T overwrite an existing
      // pending_user_action_kind — that means an earlier, higher-priority
      // ask is already in flight and we shouldn't displace it.
      if (classification.pending_user_action) {
        const { data: existing } = await supabaseAdmin
          .from("vehicle_tasks")
          .select("pending_user_action_kind")
          .eq("id", taskId)
          .maybeSingle();
        if (!(existing as any)?.pending_user_action_kind) {
          const pa = classification.pending_user_action;
          await supabaseAdmin
            .from("vehicle_tasks")
            .update({
              pending_user_action_kind: pa.kind,
              pending_user_action_text: pa.text,
              pending_user_action_options: pa.options,
              pending_user_action_set_at: new Date().toISOString(),
              agent_status_text: classification.summary
            })
            .eq("id", taskId);
        } else {
          // Refresh agent_status_text so the Agent Working strip stays current.
          await supabaseAdmin
            .from("vehicle_tasks")
            .update({ agent_status_text: classification.summary })
            .eq("id", taskId);
        }
      } else {
        // Acknowledgment-class: just refresh the status line so the user sees
        // the agent acknowledged it.
        await supabaseAdmin
          .from("vehicle_tasks")
          .update({ agent_status_text: classification.summary })
          .eq("id", taskId);
      }
    } catch (err) {
      console.error("[inbound] classifier pipeline failed (non-fatal)", err);
      // Make sure SOMETHING lands on the timeline even if the classifier failed.
      if (!classification) {
        await supabaseAdmin.from("thread_events").insert({
          user_id: profile.id,
          task_id: taskId,
          kind: "agent_classification",
          summary: `Reply received from ${fromAddress ?? "provider"} — classifier unavailable`,
          detail: null,
          metadata: {
            from: fromAddress,
            subject: data?.subject ?? null,
            match_strategy: matchStrategy,
            attachments: attachedDocs,
            error: err instanceof Error ? err.message : "unknown"
          }
        });
      }
    }
  }

  // Push notification: this is the moment the user has been waiting for —
  // someone replied. Fire an ambient notification to all their devices so
  // they see it immediately, even with the app closed. Best-effort —
  // failures are logged in sendPushToUser and don't fail the webhook.
  try {
    let providerName: string | null = null;
    if (providerId) {
      const { data: providerRow } = await supabaseAdmin
        .from("providers")
        .select("name")
        .eq("id", providerId)
        .maybeSingle();
      providerName = (providerRow as any)?.name ?? null;
    }
    const fromLabel = providerName ?? fromAddress ?? "a provider";
    const subject = (data?.subject as string | undefined)?.trim() || "(no subject)";
    const delivered = await sendPushToUser(profile.id, {
      title: `${fromLabel} replied`,
      body: subject.length > 100 ? `${subject.slice(0, 97)}…` : subject,
      // Deep-link straight to the History tab with the relevant task expanded.
      // The service worker reads this and navigates on click.
      url: taskId ? `/app?tab=history&task=${taskId}` : "/app",
      tag: taskId ? `task-${taskId}` : "reply"
    });
    if (delivered > 0) {
      console.log(`[inbound] push delivered to ${delivered} device(s) for user ${profile.id}`);
    }
  } catch (err) {
    console.error("[inbound] push notification failed (non-fatal)", err);
  }

  return res.json({ received: true });
});

/**
 * Resend events webhook (delivered, bounced, spam, opened, etc).
 */
webhooks.post("/webhooks/email/events", async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;
  const verification = verifySvixSignature(req, rawBody, env.RESEND_EVENTS_WEBHOOK_SECRET);
  if (!verification.valid) {
    console.warn("events webhook signature failed:", verification.error);
    return res.status(401).json({ error: "invalid_signature", detail: verification.error });
  }

  const event = verification.payload as { type?: string; data?: { email_id?: string } };
  const messageId = event?.data?.email_id;
  if (!messageId) return res.status(202).json({ ignored: true });

  const { data: emailRow } = await supabaseAdmin
    .from("task_emails")
    .select("id")
    .eq("provider_message_id", messageId)
    .maybeSingle();
  if (!emailRow) return res.status(202).json({ ignored: true, reason: "unknown_message" });

  await supabaseAdmin.from("email_events").insert({
    task_email_id: emailRow.id,
    event_type: event.type ?? "unknown",
    occurred_at: new Date().toISOString(),
    metadata: event as any
  });

  return res.json({ received: true });
});

// ---------- helpers ----------

interface SvixVerificationResult {
  valid: boolean;
  payload?: unknown;
  error?: string;
}

function verifySvixSignature(
  req: Request,
  rawBody: Buffer,
  secret: string | undefined
): SvixVerificationResult {
  // Dev-mode fallback: if no secret is set, accept the payload as-is.
  if (!secret) {
    try {
      return { valid: true, payload: JSON.parse(rawBody.toString("utf8")) };
    } catch {
      return { valid: false, error: "invalid_json_no_secret" };
    }
  }

  const svixId = req.header("svix-id");
  const svixTimestamp = req.header("svix-timestamp");
  const svixSignature = req.header("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return {
      valid: false,
      error: `missing_headers (id=${!!svixId}, ts=${!!svixTimestamp}, sig=${!!svixSignature})`
    };
  }

  try {
    const wh = new Webhook(secret);
    const payload = wh.verify(rawBody.toString("utf8"), {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature
    });
    return { valid: true, payload };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "verify_failed"
    };
  }
}

async function upsertSubscription(params: {
  userId: string;
  externalSubscriptionId: string | null;
  externalCustomerId: string | null;
  plan: "pro_monthly" | "pro_annual";
  status: "active" | "trialing" | "past_due" | "canceled" | "expired";
  currentPeriodEnd?: number | null;
}) {
  await supabaseAdmin.from("subscriptions").upsert(
    {
      user_id: params.userId,
      source: "stripe",
      status: params.status,
      plan: params.plan,
      external_subscription_id: params.externalSubscriptionId,
      external_customer_id: params.externalCustomerId,
      current_period_end: params.currentPeriodEnd
        ? new Date(params.currentPeriodEnd * 1000).toISOString()
        : null
    },
    { onConflict: "user_id" }
  );
}

function mapStripeStatus(status: Stripe.Subscription["status"]) {
  switch (status) {
    case "trialing":
      return "trialing" as const;
    case "active":
      return "active" as const;
    case "past_due":
    case "unpaid":
      return "past_due" as const;
    case "canceled":
      return "canceled" as const;
    case "incomplete":
    case "incomplete_expired":
    case "paused":
    default:
      return "expired" as const;
  }
}

function firstAddress(input: unknown): string | null {
  if (!input) return null;
  if (Array.isArray(input)) {
    const first = input[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") return (first as any).address ?? (first as any).email ?? null;
    return null;
  }
  if (typeof input === "string") return input;
  if (typeof input === "object") return (input as any).address ?? (input as any).email ?? null;
  return null;
}

/**
 * Parse Resend inbound attachments. The webhook payload may carry attachments
 * as either:
 *   - { content: "<base64>", filename, content_type } (Resend default)
 *   - { content: { type: "Buffer", data: [...] }, ... } (some forwarders)
 *   - URLs (we ignore — we only handle inline base64 for now)
 * Returns the buffers we can use directly.
 */
interface ParsedAttachment {
  filename: string;
  contentType: string;
  buffer: Buffer;
}

function parseAttachments(raw: unknown): ParsedAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedAttachment[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const aa = a as any;
    const filename: string =
      aa.filename ?? aa.name ?? aa.file_name ?? `attachment-${out.length + 1}`;
    const contentType: string =
      aa.content_type ?? aa.contentType ?? aa.mime_type ?? "application/octet-stream";

    let buf: Buffer | null = null;
    if (typeof aa.content === "string") {
      // Most common: base64 string
      try {
        buf = Buffer.from(aa.content, "base64");
      } catch {
        buf = null;
      }
    } else if (aa.content && typeof aa.content === "object" && Array.isArray(aa.content.data)) {
      buf = Buffer.from(aa.content.data);
    }

    if (!buf || buf.length === 0) {
      continue;
    }
    // Only accept reasonable sizes (<= 15 MB) and supported mime types.
    if (buf.length > 15 * 1024 * 1024) {
      console.warn(`[inbound] skipping oversize attachment ${filename} (${buf.length} bytes)`);
      continue;
    }
    if (!isAllowedMimeType(contentType)) {
      console.warn(`[inbound] skipping disallowed mime ${contentType} for ${filename}`);
      continue;
    }
    out.push({ filename, contentType, buffer: buf });
  }
  return out;
}

function isAllowedMimeType(mime: string): boolean {
  const allowed = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/gif"
  ];
  return allowed.includes(mime);
}

/**
 * Choose a document_kind from the originating task type + filename heuristics.
 * Used to route attachments to the right Claude vision prompt.
 */
function inferDocumentKindFromContext(
  taskType: string | null,
  filename: string
): DocumentKind {
  const f = filename.toLowerCase();
  if (taskType === "recall_repair" || taskType === "recall_appointment") {
    return "recall_notice";
  }
  if (taskType === "insurance_quote") return "insurance_dec_page";
  if (taskType === "refinance" || taskType === "payoff_quote") return "loan_statement";
  if (taskType === "sell_vehicle") return "sale_paperwork";
  if (f.includes("recall")) return "recall_notice";
  if (f.includes("insurance") || f.includes("dec") || f.includes("declaration"))
    return "insurance_dec_page";
  if (f.includes("loan") || f.includes("payoff") || f.includes("statement"))
    return "loan_statement";
  if (f.includes("registration")) return "registration";
  if (f.includes("invoice") || f.includes("receipt") || f.includes("service"))
    return "service_record";
  return "other";
}
