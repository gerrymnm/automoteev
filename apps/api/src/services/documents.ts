import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config.js";
import { supabaseAdmin } from "../supabase.js";
import { encryptField } from "../security/encryption.js";
import { upsertRenewalFromDLExtraction } from "./renewals.js";

/**
 * Document upload + AI extraction service.
 *
 * Pipeline:
 *   1. Client uploads image/PDF → multer parses → buffer in memory
 *   2. uploadAndExtract() puts file in Supabase Storage under user/<uid>/<docId>.<ext>
 *   3. Inserts uploaded_documents row with extraction_status='processing'
 *   4. Calls Anthropic vision with a kind-specific prompt + the image bytes
 *   5. Parses JSON response → writes extracted_data, sets status='completed'
 *
 * If anything fails downstream of upload, we still keep the file (audit trail)
 * and just mark extraction_status='failed' with the error.
 */

export type DocumentKind =
  | "insurance_dec_page"
  | "loan_statement"
  | "lease_agreement"
  | "registration"
  | "recall_notice"
  | "service_record"
  | "sale_paperwork"
  | "drivers_license"
  | "other";

export type DocumentCategory =
  | "insurance"
  | "loan"
  | "registration"
  | "recall"
  | "service"
  | "sale"
  | "identity"
  | "other";

/**
 * Map a document_kind to its user-facing category folder. The category is
 * what the user sees when drilling into a vehicle's documents ("Insurance",
 * "Loan", etc.). Stored explicitly on the row so future re-categorization
 * doesn't require re-deriving from kind.
 *
 * Note: drivers_license maps to 'identity' which is USER-scoped, not
 * vehicle-scoped — the storage path falls back to users/<userId>/identity/.
 */
export function documentKindToCategory(kind: DocumentKind): DocumentCategory {
  switch (kind) {
    case "insurance_dec_page":
      return "insurance";
    case "loan_statement":
    case "lease_agreement":
      return "loan";
    case "registration":
      return "registration";
    case "recall_notice":
      return "recall";
    case "service_record":
      return "service";
    case "sale_paperwork":
      return "sale";
    case "drivers_license":
      return "identity";
    case "other":
    default:
      return "other";
  }
}

export interface UploadedDocument {
  id: string;
  user_id: string;
  vehicle_id: string | null;
  document_kind: DocumentKind;
  category: DocumentCategory | null;
  storage_path: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  extraction_status: "pending" | "processing" | "completed" | "failed";
  extracted_data: Record<string, unknown> | null;
  extraction_error: string | null;
  uploaded_at: string;
  extracted_at: string | null;
}

const STORAGE_BUCKET = "user-documents";

function anthropicClient() {
  if (!env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

export async function uploadDocument(params: {
  userId: string;
  vehicleId: string | null;
  documentKind: DocumentKind;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<UploadedDocument> {
  const ext = params.fileName.split(".").pop()?.toLowerCase() || "bin";
  const docId = crypto.randomUUID();
  const category = documentKindToCategory(params.documentKind);

  // Per-VIN folder layout: when a vehicle context is provided, group under
  // vehicles/<vehicle_id>/<category>/. Otherwise fall back to a per-user
  // folder so an orphan upload (rare — e.g. a registration photographed
  // before vehicle setup completes) still has a sensible storage prefix.
  // The bucket itself is the same; only the prefix changes.
  const storagePath = params.vehicleId
    ? `vehicles/${params.vehicleId}/${category}/${docId}.${ext}`
    : `users/${params.userId}/${category}/${docId}.${ext}`;

  // 1. Upload to Storage
  const { error: uploadErr } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, params.buffer, {
      contentType: params.mimeType,
      upsert: false
    });
  if (uploadErr) throw new Error(`storage upload failed: ${uploadErr.message}`);

  // 2. Insert metadata row — category persisted alongside document_kind so
  //    future re-categorization can change the user-facing folder without
  //    losing the original kind that drove the AI extraction prompt.
  const { data: row, error: insertErr } = await supabaseAdmin
    .from("uploaded_documents")
    .insert({
      id: docId,
      user_id: params.userId,
      vehicle_id: params.vehicleId,
      document_kind: params.documentKind,
      category,
      storage_path: storagePath,
      file_name: params.fileName,
      mime_type: params.mimeType,
      byte_size: params.buffer.length,
      extraction_status: "pending"
    })
    .select()
    .single();
  if (insertErr) throw new Error(`document row insert failed: ${insertErr.message}`);

  return row as UploadedDocument;
}

export async function extractDocument(documentId: string): Promise<UploadedDocument> {
  const { data: doc, error } = await supabaseAdmin
    .from("uploaded_documents")
    .select("*")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  if (!doc) throw new Error("document not found");

  const client = anthropicClient();
  if (!client) {
    await supabaseAdmin
      .from("uploaded_documents")
      .update({
        extraction_status: "failed",
        extraction_error: "ANTHROPIC_API_KEY not configured"
      })
      .eq("id", documentId);
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  // Mark processing
  await supabaseAdmin
    .from("uploaded_documents")
    .update({ extraction_status: "processing" })
    .eq("id", documentId);

  try {
    // Download the bytes from Storage
    const { data: blob, error: dlErr } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .download(doc.storage_path);
    if (dlErr || !blob) throw new Error(`storage download failed: ${dlErr?.message}`);

    const arrayBuffer = await blob.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    const prompt = promptForKind(doc.document_kind as DocumentKind);

    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: doc.mime_type as
                  | "image/jpeg"
                  | "image/png"
                  | "image/webp"
                  | "image/gif",
                data: base64
              }
            },
            { type: "text", text: prompt }
          ]
        }
      ]
    });

    const textBlock = response.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from extraction model");
    }

    // The prompts ask for JSON only; strip code fences if present.
    const cleaned = textBlock.text.replace(/```json\s*|\s*```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    // PII handling for driver's license: extracted JSON may contain a raw
    // DL number which should NEVER be persisted in plaintext at rest. We
    // encrypt it immediately and store ONLY the ciphertext + a redacted
    // display string. The plaintext is dropped from the parsed object
    // before it reaches extracted_data.
    if (doc.document_kind === "drivers_license") {
      const rawDl =
        typeof parsed.dl_number === "string" ? parsed.dl_number.trim() : null;
      if (rawDl && rawDl.length >= 4) {
        parsed.dl_number_encrypted = encryptField(rawDl);
        parsed.dl_number_redacted = `\u2022\u2022\u2022\u2022${rawDl.slice(-4)}`;
      }
      // Drop plaintext from anywhere in the parsed payload before we persist.
      delete parsed.dl_number;
    }

    const { data: updated } = await supabaseAdmin
      .from("uploaded_documents")
      .update({
        extraction_status: "completed",
        extracted_data: parsed,
        extracted_at: new Date().toISOString(),
        extraction_error: null
      })
      .eq("id", documentId)
      .select()
      .single();

    return updated as UploadedDocument;
  } catch (err) {
    const message = err instanceof Error ? err.message : "extraction failed";
    await supabaseAdmin
      .from("uploaded_documents")
      .update({
        extraction_status: "failed",
        extraction_error: message
      })
      .eq("id", documentId);
    throw err;
  }
}

/**
 * Apply extracted data to the user's records (insurance, loan, etc.).
 * Returns a summary of what was updated.
 */
export async function applyExtractedDocument(params: {
  userId: string;
  documentId: string;
  vehicleId: string;
}): Promise<{ applied: string[]; data: Record<string, unknown> }> {
  const { data: doc } = await supabaseAdmin
    .from("uploaded_documents")
    .select("*")
    .eq("id", params.documentId)
    .eq("user_id", params.userId)
    .maybeSingle();
  if (!doc || !doc.extracted_data) {
    throw new Error("document not extracted yet");
  }

  const applied: string[] = [];
  const data = doc.extracted_data as Record<string, unknown>;

  if (doc.document_kind === "insurance_dec_page") {
    const update: Record<string, unknown> = {
      user_id: params.userId,
      vehicle_id: params.vehicleId
    };
    if (data.carrier_name) {
      update.carrier_name = data.carrier_name;
      applied.push("carrier");
    }
    if (typeof data.monthly_premium_cents === "number") {
      update.premium_cents = data.monthly_premium_cents;
      applied.push("premium");
    }
    if (data.renewal_date) {
      update.renewal_date = data.renewal_date;
      applied.push("renewal_date");
    }
    if (data.coverage_type) {
      update.coverage_type = data.coverage_type;
      applied.push("coverage_type");
    }
    if (typeof data.deductible_cents === "number") {
      update.deductible_cents = data.deductible_cents;
      applied.push("deductible");
    }
    if (data.liability_limits) {
      update.liability_limits = data.liability_limits;
      applied.push("liability_limits");
    }
    if (Object.keys(update).length > 2) {
      await supabaseAdmin.from("insurance_accounts").upsert(update, { onConflict: "vehicle_id" });
    }
  } else if (doc.document_kind === "loan_statement") {
    const update: Record<string, unknown> = {
      user_id: params.userId,
      vehicle_id: params.vehicleId
    };
    if (data.lender_name) {
      update.lender_name = data.lender_name;
      applied.push("lender");
    }
    if (typeof data.balance_cents === "number") {
      update.balance_cents = data.balance_cents;
      applied.push("balance");
    }
    if (typeof data.monthly_payment_cents === "number") {
      update.monthly_payment_cents = data.monthly_payment_cents;
      applied.push("monthly_payment");
    }
    if (typeof data.apr_bps === "number") {
      update.apr_bps = data.apr_bps;
      applied.push("apr");
    }
    if (typeof data.term_months === "number") {
      update.term_months = data.term_months;
      applied.push("term");
    }
    if (Object.keys(update).length > 2) {
      await supabaseAdmin.from("loan_lease_accounts").upsert(update, { onConflict: "vehicle_id" });
    }
  } else if (doc.document_kind === "drivers_license") {
    // DL applies to the USER not a vehicle. dl_number_encrypted is already
    // ciphertext (encrypted in extractDocument before persisting); we copy
    // it directly into user_pii without re-encrypting. dl_collected_at is
    // the trigger that the just-in-time DLPromptModal uses to decide
    // whether to fire — setting it here means future insurance dispatches
    // skip the modal.
    const update: Record<string, unknown> = { user_id: params.userId };
    if (typeof data.dl_number_encrypted === "string" && data.dl_number_encrypted) {
      update.dl_number_encrypted = data.dl_number_encrypted;
      update.dl_collected_at = new Date().toISOString();
      applied.push("dl_number");
    }
    if (typeof data.dl_state === "string" && data.dl_state) {
      update.dl_state = data.dl_state;
      applied.push("dl_state");
    }
    if (Object.keys(update).length > 1) {
      await supabaseAdmin
        .from("user_pii")
        .upsert(update, { onConflict: "user_id" });
    }

    // Auto-create a renewable_items row for the DL expiration. Best-effort:
    // if extraction didn't pick up a parseable expiration_date, the helper
    // returns null and we move on — the dl_number being on file is the
    // primary outcome; the renewal tracker entry is bonus context.
    if (data.expiration_date) {
      try {
        await upsertRenewalFromDLExtraction({
          userId: params.userId,
          documentId: params.documentId,
          expirationDate: data.expiration_date,
          dlState: data.dl_state
        });
        applied.push("dl_renewal_tracking");
      } catch (err) {
        console.error("[documents] DL renewal upsert failed (non-fatal)", err);
      }
    }
  }

  return { applied, data };
}

/**
 * Maps a dispatchable task type to the document categories the agent should
 * try to attach to outbound provider emails. The mapping is intentionally
 * conservative — only attach what the receiving party genuinely needs to
 * issue a quote / process the request:
 *
 *   insurance_quote: dec page (current coverage) + DL (binding requirement)
 *   refinance:       loan statement (balance/APR/payoff) + registration
 *   sell_vehicle:    registration + prior sale paperwork (proof of ownership)
 *   recall_repair / recall_appointment / service_quote: text-only
 */
export function attachmentCategoriesForTask(taskType: string): DocumentCategory[] {
  switch (taskType) {
    case "insurance_quote":
    case "insurance_review":
      return ["insurance", "identity"];
    case "refinance":
    case "refinance_review":
    case "payoff_request":
    case "payoff_quote":
      return ["loan", "registration"];
    case "sell_vehicle":
    case "lease_end_review":
      return ["registration", "sale"];
    default:
      return [];
  }
}

export interface PlannedAttachment {
  document_id: string;
  filename: string;
  document_kind: DocumentKind;
  category: DocumentCategory;
  byte_size: number;
}

export interface ResolvedAttachment {
  filename: string;
  content_base64: string;
  content_type: string;
  document_id: string;
  category: DocumentCategory;
}

/**
 * For each category the task wants to attach, return the most-recently-uploaded
 * successfully-extracted document. Returns lightweight metadata only — use
 * `resolveAttachmentsForDispatch` to actually download the bytes when sending.
 *
 * Identity (DL) docs are user-scoped (vehicle_id IS NULL); other categories
 * are vehicle-scoped. We never attach a doc whose extraction_status isn't
 * 'completed' — if the agent can't read the file, the receiving party
 * probably can't either, and a half-uploaded file is worse than none.
 */
export async function planAttachmentsForDispatch(params: {
  userId: string;
  vehicleId: string;
  taskType: string;
}): Promise<PlannedAttachment[]> {
  const categories = attachmentCategoriesForTask(params.taskType);
  if (categories.length === 0) return [];

  const planned: PlannedAttachment[] = [];
  for (const category of categories) {
    let query = supabaseAdmin
      .from("uploaded_documents")
      .select(
        "id, file_name, mime_type, document_kind, category, byte_size, vehicle_id, user_id, extraction_status"
      )
      .eq("category", category)
      .eq("extraction_status", "completed")
      .order("uploaded_at", { ascending: false })
      .limit(1);

    if (category === "identity") {
      // DL is user-scoped, not vehicle-scoped. The orphan-no-vehicle row is
      // exactly the one we want.
      query = query.eq("user_id", params.userId).is("vehicle_id", null);
    } else {
      query = query.eq("vehicle_id", params.vehicleId);
    }

    const { data, error } = await query.maybeSingle();
    if (error) {
      console.warn(
        `[documents] planAttachmentsForDispatch ${category} lookup failed`,
        error
      );
      continue;
    }
    if (!data) continue;

    planned.push({
      document_id: data.id,
      filename: data.file_name,
      document_kind: data.document_kind as DocumentKind,
      category: data.category as DocumentCategory,
      byte_size: data.byte_size as number
    });
  }
  return planned;
}

/**
 * Take a planned-attachment list and download each from Storage, returning
 * base64-encoded bytes ready for Resend. Skips any document whose download
 * fails so a transient storage hiccup doesn't block the whole dispatch.
 *
 * Total-size budget: 30MB combined. Resend's hard cap is 40MB; we leave
 * headroom for the body + headers + base64 expansion overhead.
 */
export async function resolveAttachmentsForDispatch(
  planned: PlannedAttachment[]
): Promise<ResolvedAttachment[]> {
  if (planned.length === 0) return [];
  const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
  let totalBytes = 0;
  const resolved: ResolvedAttachment[] = [];

  for (const p of planned) {
    if (totalBytes + p.byte_size > MAX_TOTAL_BYTES) {
      console.warn(
        `[documents] skipping attachment ${p.filename} — would exceed 30MB cap`
      );
      continue;
    }

    const { data: row } = await supabaseAdmin
      .from("uploaded_documents")
      .select("storage_path, mime_type")
      .eq("id", p.document_id)
      .maybeSingle();
    if (!row?.storage_path) continue;

    const { data: blob, error: dlErr } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .download(row.storage_path);
    if (dlErr || !blob) {
      console.warn(
        `[documents] attachment download failed for ${p.filename}`,
        dlErr?.message
      );
      continue;
    }
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    resolved.push({
      filename: p.filename,
      content_base64: base64,
      content_type: (row.mime_type as string) || "application/octet-stream",
      document_id: p.document_id,
      category: p.category
    });
    totalBytes += p.byte_size;
  }
  return resolved;
}

/**
 * Create a short-TTL signed URL for a stored document so the user can open
 * or download it from the per-VIN folders panel. Caller is expected to have
 * already verified ownership via the RLS-scoped req.db client — this helper
 * uses the admin client to generate the URL but does NOT enforce ownership
 * itself. Default TTL is 5 minutes which is plenty of headroom for the
 * browser to fetch + render before the URL expires.
 */
export async function createDocumentSignedUrl(
  documentId: string,
  ttlSeconds = 300
): Promise<{ signed_url: string; file_name: string; expires_in_seconds: number } | null> {
  const { data: doc } = await supabaseAdmin
    .from("uploaded_documents")
    .select("storage_path, file_name")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc?.storage_path) return null;

  const { data, error } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(doc.storage_path as string, ttlSeconds);
  if (error || !data?.signedUrl) return null;

  return {
    signed_url: data.signedUrl,
    file_name: (doc.file_name as string) ?? "document",
    expires_in_seconds: ttlSeconds
  };
}

function promptForKind(kind: DocumentKind): string {
  switch (kind) {
    case "insurance_dec_page":
      return `You are extracting structured data from a vehicle insurance declarations page.
Return ONLY valid JSON, no prose, no code fences. Fields:
{
  "carrier_name": string | null,
  "policy_number": string | null,
  "policy_start_date": "YYYY-MM-DD" | null,
  "renewal_date": "YYYY-MM-DD" | null,
  "monthly_premium_cents": integer | null  // Convert annual or 6-month to monthly cents,
  "coverage_type": "liability" | "full" | "comprehensive" | "unknown" | null,
  "deductible_cents": integer | null,
  "liability_limits": string | null,  // e.g. "100/300/100"
  "vehicles_covered": [{"year": int, "make": string, "model": string, "vin": string}] | null
}
If a field is unclear or missing, set it to null. Use cents not dollars (e.g. $125.50 = 12550).`;

    case "loan_statement":
      return `You are extracting structured data from an auto loan statement.
Return ONLY valid JSON, no prose, no code fences. Fields:
{
  "lender_name": string | null,
  "account_number": string | null,
  "balance_cents": integer | null,
  "monthly_payment_cents": integer | null,
  "apr_bps": integer | null,  // basis points: 6.49% = 649
  "term_months": integer | null,
  "remaining_payments": integer | null,
  "next_payment_date": "YYYY-MM-DD" | null,
  "payoff_amount_cents": integer | null
}
If a field is unclear or missing, set it to null. Use cents not dollars.`;

    case "registration":
      return `Extract DMV registration info as JSON only:
{ "vin": string|null, "year": int|null, "make": string|null, "model": string|null, "expiration_date": "YYYY-MM-DD"|null, "registered_owner": string|null }`;

    case "recall_notice":
      return `Extract recall notice info as JSON only:
{ "campaign_id": string|null, "component": string|null, "summary": string|null, "remedy": string|null, "vehicle_year": int|null, "vehicle_make": string|null, "vehicle_model": string|null }`;

    case "drivers_license":
      return `You are extracting structured data from a US driver's license.
Return ONLY valid JSON, no prose, no code fences. Fields:
{
  "dl_number": string | null,         // The license number EXACTLY as printed (preserve dashes/letters)
  "dl_state": string | null,          // 2-letter state code (e.g. "CA", "TX", "NY")
  "full_name": string | null,         // First Middle Last
  "expiration_date": "YYYY-MM-DD" | null,
  "issued_date": "YYYY-MM-DD" | null,
  "date_of_birth": "YYYY-MM-DD" | null,
  "address_line1": string | null,
  "city": string | null,
  "zip_code": string | null
}
If a field is unclear, partially obscured, or not visible, set it to null.
If the image is NOT a driver's license, return: {"error": "not a driver's license"}.`;

    default:
      return `Extract any structured data you can find in this image. Return JSON only with fields you're confident about.`;
  }
}
