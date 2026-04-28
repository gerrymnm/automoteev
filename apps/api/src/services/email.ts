import { Resend } from "resend";
import { env } from "../config.js";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

/**
 * Single attachment for a Resend email. content is base64-encoded bytes
 * (Resend accepts that directly). Keep filename + content_type so the
 * receiving inbox renders it as a normal attachment, not a text blob.
 */
export interface TaskEmailAttachment {
  filename: string;
  content_base64: string;
  content_type: string;
}

export interface SendTaskEmailParams {
  to: string;
  fromLocal: string;      // per-user alias, e.g. "gerry.m"
  fromDisplayName: string; // shown in "From" header
  subject: string;
  body: string;
  replyToLocal?: string;  // default equal to fromLocal
  threadHeaders?: {
    inReplyTo?: string;
    references?: string[];
  };
  /**
   * Files to attach to this email — dec page on insurance quotes, loan
   * statement on refinance, registration on sale outreach, etc. Composed
   * upstream by selectAttachmentsForDispatch in documents.ts.
   */
  attachments?: TaskEmailAttachment[];
}

export interface SendTaskEmailResult {
  providerMessageId: string | null;
  from: string;
  replyTo: string;
  status: "sent" | "skipped_no_resend_key" | "error";
  error?: string;
}

export async function sendTaskEmail(params: SendTaskEmailParams): Promise<SendTaskEmailResult> {
  const from = `${params.fromDisplayName} <${params.fromLocal}@${env.RESEND_FROM_DOMAIN}>`;
  const replyToLocal = params.replyToLocal ?? params.fromLocal;
  const replyTo = `${replyToLocal}@${env.RESEND_REPLY_TO_DOMAIN}`;

  if (!resend) {
    return {
      providerMessageId: `dev-${Date.now()}`,
      from,
      replyTo,
      status: "skipped_no_resend_key"
    };
  }

  const headers: Record<string, string> = {};
  if (params.threadHeaders?.inReplyTo) headers["In-Reply-To"] = params.threadHeaders.inReplyTo;
  if (params.threadHeaders?.references?.length) {
    headers["References"] = params.threadHeaders.references.join(" ");
  }

  // Resend wants attachments as { filename, content }. content can be a
  // base64 string OR a Buffer; we standardize on base64 since the storage
  // download path returns it that way and we keep the wire format stable.
  const resendAttachments = (params.attachments ?? []).map((a) => ({
    filename: a.filename,
    content: a.content_base64,
    content_type: a.content_type
  }));

  try {
    const result = await resend.emails.send({
      from,
      to: params.to,
      subject: params.subject,
      text: params.body,
      reply_to: replyTo,
      headers,
      ...(resendAttachments.length ? { attachments: resendAttachments } : {})
    });

    if (result.error) {
      return { providerMessageId: null, from, replyTo, status: "error", error: result.error.message };
    }

    return {
      providerMessageId: result.data?.id ?? null,
      from,
      replyTo,
      status: "sent"
    };
  } catch (err) {
    return {
      providerMessageId: null,
      from,
      replyTo,
      status: "error",
      error: err instanceof Error ? err.message : "unknown"
    };
  }
}
