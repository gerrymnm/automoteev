import { supabaseAdmin } from "../supabase.js";

/**
 * Generate a per-user email local-part like `gerry.m` for gerry.m@mail.automoteev.com.
 * Agent sends outbound dealer email under this alias, signed as the owner.
 * Inbound webhooks from Resend route back to the user by matching to_email.
 */
export function proposeLocal(fullName: string): string {
  const cleaned = fullName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, "")
    .trim()
    .split(/\s+/);

  if (cleaned.length === 0) return "owner";

  const first = cleaned[0] ?? "owner";
  const lastWord = cleaned.length > 1 ? cleaned[cleaned.length - 1] : "";
  const lastInitial = lastWord && lastWord.length > 0 ? lastWord[0] : "";
  return lastInitial ? `${first}.${lastInitial}` : first;
}

/**
 * Reserve a unique local-part for a user. Appends numeric suffix on collision.
 */
export async function assignAgentEmailLocal(userId: string, fullName: string): Promise<string> {
  const base = proposeLocal(fullName);
  const candidates = [base, `${base}2`, `${base}3`, `${base}${Date.now().toString(36).slice(-4)}`];

  for (const candidate of candidates) {
    const { data: existing } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("agent_email_local", candidate)
      .maybeSingle();
    if (!existing) {
      const { error } = await supabaseAdmin
        .from("profiles")
        .update({ agent_email_local: candidate })
        .eq("id", userId);
      if (!error) return candidate;
    }
  }

  throw new Error("Could not reserve agent email alias");
}

export function composeAgentAddress(localPart: string, domain: string): string {
  return `${localPart}@${domain}`;
}
