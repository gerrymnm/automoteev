import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config.js";
import { supabaseAdmin } from "../supabase.js";

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
  | "other";

export interface UploadedDocument {
  id: string;
  user_id: string;
  vehicle_id: string | null;
  document_kind: DocumentKind;
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
  const storagePath = `${params.userId}/${docId}.${ext}`;

  // 1. Upload to Storage
  const { error: uploadErr } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, params.buffer, {
      contentType: params.mimeType,
      upsert: false
    });
  if (uploadErr) throw new Error(`storage upload failed: ${uploadErr.message}`);

  // 2. Insert metadata row
  const { data: row, error: insertErr } = await supabaseAdmin
    .from("uploaded_documents")
    .insert({
      id: docId,
      user_id: params.userId,
      vehicle_id: params.vehicleId,
      document_kind: params.documentKind,
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
  }

  return { applied, data };
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

    default:
      return `Extract any structured data you can find in this image. Return JSON only with fields you're confident about.`;
  }
}
