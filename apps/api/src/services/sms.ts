import { env } from "../config.js";
import { supabaseAdmin } from "../supabase.js";

export interface SmsResult {
  status: "sent" | "skipped" | "failed";
  messageId?: string | null;
  reason?: string;
}

function smsConfigured() {
  return Boolean(
    env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_AUTH_TOKEN &&
      (env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM_NUMBER)
  );
}

export function getSmsConfigStatus() {
  return { configured: smsConfigured() };
}

export function normalizePhoneForSms(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export async function logSms(params: {
  userId: string;
  taskId?: string | null;
  toPhone: string | null;
  body: string;
  status: string;
  providerMessageId?: string | null;
  errorMessage?: string | null;
}) {
  await supabaseAdmin.from("sms_messages").insert({
    user_id: params.userId,
    task_id: params.taskId ?? null,
    to_phone: params.toPhone,
    body_text: params.body,
    status: params.status,
    provider: "twilio",
    provider_message_id: params.providerMessageId ?? null,
    error_message: params.errorMessage ?? null
  });
}

export async function sendSms(params: {
  userId: string;
  taskId?: string | null;
  toPhone: string;
  body: string;
}): Promise<SmsResult> {
  const toPhone = normalizePhoneForSms(params.toPhone);
  if (!toPhone) {
    await logSms({
      userId: params.userId,
      taskId: params.taskId,
      toPhone: params.toPhone,
      body: params.body,
      status: "failed",
      errorMessage: "Invalid phone number"
    });
    return { status: "failed", reason: "Invalid phone number." };
  }

  if (!smsConfigured()) {
    await logSms({
      userId: params.userId,
      taskId: params.taskId,
      toPhone,
      body: params.body,
      status: "skipped",
      errorMessage: "Twilio is not configured"
    });
    return { status: "skipped", reason: "Twilio is not configured." };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams({
    To: toPhone,
    Body: params.body
  });
  if (env.TWILIO_MESSAGING_SERVICE_SID) {
    form.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE_SID);
  } else if (env.TWILIO_FROM_NUMBER) {
    form.set("From", env.TWILIO_FROM_NUMBER);
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });
    const body = (await response.json().catch(() => ({}))) as {
      sid?: string;
      message?: string;
    };

    if (!response.ok) {
      const errorMessage = body.message ?? `Twilio returned ${response.status}`;
      await logSms({
        userId: params.userId,
        taskId: params.taskId,
        toPhone,
        body: params.body,
        status: "failed",
        errorMessage
      });
      return { status: "failed", reason: errorMessage };
    }

    await logSms({
      userId: params.userId,
      taskId: params.taskId,
      toPhone,
      body: params.body,
      status: "sent",
      providerMessageId: body.sid ?? null
    });
    return { status: "sent", messageId: body.sid ?? null };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "SMS send failed";
    await logSms({
      userId: params.userId,
      taskId: params.taskId,
      toPhone,
      body: params.body,
      status: "failed",
      errorMessage
    });
    return { status: "failed", reason: errorMessage };
  }
}

export function taskApprovalSmsBody(params: { taskTitle: string; appUrl: string }) {
  const url = `${params.appUrl.replace(/\/$/, "")}/app`;
  return `Automoteev needs your approval for: ${params.taskTitle}. Review and approve in the app: ${url}`;
}
