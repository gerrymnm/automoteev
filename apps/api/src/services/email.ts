import { Resend } from "resend";
import { env } from "../config.js";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export async function sendTaskEmail(params: {
  to: string;
  subject: string;
  body: string;
}) {
  if (!resend) {
    return {
      providerMessageId: `dev-${Date.now()}`,
      status: "skipped_no_resend_key"
    };
  }

  const result = await resend.emails.send({
    from: env.RESEND_FROM,
    to: params.to,
    subject: params.subject,
    text: params.body
  });

  if (result.error) {
    throw new Error(result.error.message);
  }

  return {
    providerMessageId: result.data?.id ?? null,
    status: "sent"
  };
}
