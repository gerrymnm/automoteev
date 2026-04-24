import { Resend } from "resend";
import { env } from "../config.js";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

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

  try {
    const result = await resend.emails.send({
      from,
      to: params.to,
      subject: params.subject,
      text: params.body,
      replyTo,
      headers
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
