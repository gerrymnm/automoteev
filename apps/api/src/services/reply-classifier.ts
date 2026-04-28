/**
 * Reply classifier — Claude call per inbound provider email.
 *
 * The agent reads the inbound email and decides what kind of reply it is, then
 * either auto-acts (acknowledges, asks for proof, etc.) OR sets a
 * pending_user_action so the home screen surfaces it as a "Needs you" card.
 *
 * Classes:
 *   acknowledgment      — receipt, "we got it", out-of-office, etc. No action.
 *   wants_appointment   — provider asks to schedule. We ask user for times.
 *   wants_info          — provider asks for info we may already have. Try to
 *                         answer if we have it; else ask user.
 *   quote_provided      — provider sent a quote/rate/estimate. User must decide.
 *   claims_complete     — provider says repair/recall is done. Ask user to confirm.
 *   escalation_needed   — angry, refusal, complex situation. User decides.
 *   human_judgment_required — anything that doesn't fit cleanly above.
 *
 * Output of classify(): the class plus a short human-readable summary AND a
 * suggested pending_user_action (kind/text/options) when one is needed.
 *
 * Failure mode: if Claude is unavailable or returns malformed JSON, we fall
 * back to "human_judgment_required" so the user always sees the reply rather
 * than the agent silently swallowing it.
 */

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config.js";

export type ReplyClass =
  | "acknowledgment"
  | "wants_appointment"
  | "wants_info"
  | "quote_provided"
  | "claims_complete"
  | "escalation_needed"
  | "human_judgment_required";

export type PendingActionKind =
  | "decision"
  | "signature"
  | "info_request"
  | "confirm_close"
  | "review_quotes"
  | "manual";

export interface ClassifierPendingAction {
  kind: PendingActionKind;
  text: string;
  options: Array<{
    id: string;
    label: string;
    style?: "primary" | "secondary" | "ghost" | "danger";
  }>;
}

export interface ClassifierResult {
  class: ReplyClass;
  reasoning: string;
  /** Short summary of what the provider said, in our own words. */
  summary: string;
  /** Set when this class needs the user. Null when the agent can handle it alone. */
  pending_user_action: ClassifierPendingAction | null;
  /** True if the model returned a fallback (Claude unavailable or malformed). */
  fallback: boolean;
}

interface ClassifyInput {
  taskType: string;
  vehicleSummary: string; // e.g. "2020 Land Rover Range Rover, VIN ...584256, 47k mi"
  outboundSubject: string | null;
  outboundBody: string | null;
  inboundFrom: string;
  inboundSubject: string;
  inboundBody: string;
}

const SYSTEM = `You are the reply classifier for Automoteev, an AI agent that contacts \
service dealers, insurance carriers, and lenders on behalf of vehicle owners. You are \
reading a reply that just arrived from a provider in response to one of our outbound \
emails. Decide what kind of reply this is and what (if anything) the owner needs to do.

Output STRICT JSON ONLY. No prose. No code fences. Schema:
{
  "class": one of [
    "acknowledgment",
    "wants_appointment",
    "wants_info",
    "quote_provided",
    "claims_complete",
    "escalation_needed",
    "human_judgment_required"
  ],
  "reasoning": short string explaining the class choice,
  "summary": short string summarizing what the provider said in plain English (what the OWNER cares about, not formalities),
  "pending_user_action": null OR {
    "kind": one of ["decision","signature","info_request","confirm_close","review_quotes","manual"],
    "text": short question shown to the owner,
    "options": [ { "id": stable_string, "label": short_button_text, "style": "primary"|"secondary"|"ghost"|"danger" } ]
  }
}

Rules:
- "acknowledgment": polite "we got it" / out-of-office / "we'll get back to you" with no real content. pending_user_action = null.
- "wants_appointment": provider asks when the owner can come in. pending_user_action.kind = "info_request", text asks the owner for a few preferred times, options offer common windows ("This week","Next week","Custom").
- "wants_info": provider asks for documents, IDs, mileage, etc. pending_user_action.kind = "info_request", text states what's needed, options = ["I have it / upload","I don't have it","Tell them no"].
- "quote_provided": numbers/rates/prices in the reply. pending_user_action.kind = "review_quotes", text says "<provider> quoted: <key terms>. Switch?", options = ["Accept","Decline","Get more quotes","Need more info"].
- "claims_complete": provider says repair/recall is done. pending_user_action.kind = "confirm_close", text = "<provider> says <thing> is complete. Close it out?", options = ["Yes, close","Ask for proof","Something's wrong"].
- "escalation_needed" / "human_judgment_required": anything ambiguous, hostile, or complex. pending_user_action.kind = "decision", text restates the situation neutrally, options = ["Reply on my behalf","I'll handle this myself","Ignore"].

Keep all fields short. Never invent facts not in the email. If the email contains a quoted figure (rate, payment, premium, deductible), include it verbatim in the "summary" field.`;

export async function classifyReply(input: ClassifyInput): Promise<ClassifierResult> {
  if (!env.ANTHROPIC_API_KEY) {
    return fallback("Anthropic key not configured", input);
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const userMessage = [
    `Task type: ${input.taskType}`,
    `Vehicle: ${input.vehicleSummary}`,
    "",
    "--- WE SENT ---",
    `Subject: ${input.outboundSubject ?? "(unknown)"}`,
    "",
    input.outboundBody ?? "(body not available)",
    "",
    "--- THEY REPLIED ---",
    `From: ${input.inboundFrom}`,
    `Subject: ${input.inboundSubject}`,
    "",
    truncate(input.inboundBody, 4000)
  ].join("\n");

  try {
    const response = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: "user", content: userMessage }]
    });

    const textBlock = response.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return fallback("No text block in classifier response", input);
    }
    const cleaned = textBlock.text.replace(/```json\s*|\s*```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const cls = normalizeClass(parsed.class);
    if (!cls) return fallback(`Unknown class: ${parsed.class}`, input);

    const pending = normalizePending(parsed.pending_user_action);
    return {
      class: cls,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      summary:
        typeof parsed.summary === "string" && parsed.summary.length > 0
          ? parsed.summary
          : `Reply from ${input.inboundFrom}`,
      pending_user_action: pending,
      fallback: false
    };
  } catch (err) {
    console.error("[classifier] failed, using fallback", err);
    return fallback(
      err instanceof Error ? err.message : "classifier failed",
      input
    );
  }
}

function fallback(reason: string, input: ClassifyInput): ClassifierResult {
  return {
    class: "human_judgment_required",
    reasoning: `fallback: ${reason}`,
    summary: `Reply from ${input.inboundFrom} — auto-classification unavailable, please review.`,
    pending_user_action: {
      kind: "decision",
      text: `Reply received from ${input.inboundFrom}. Review and decide.`,
      options: [
        { id: "open_thread", label: "Open conversation", style: "primary" },
        { id: "ignore", label: "Ignore for now", style: "ghost" }
      ]
    },
    fallback: true
  };
}

function normalizeClass(raw: unknown): ReplyClass | null {
  const valid: ReplyClass[] = [
    "acknowledgment",
    "wants_appointment",
    "wants_info",
    "quote_provided",
    "claims_complete",
    "escalation_needed",
    "human_judgment_required"
  ];
  if (typeof raw !== "string") return null;
  return valid.includes(raw as ReplyClass) ? (raw as ReplyClass) : null;
}

function normalizePending(raw: unknown): ClassifierPendingAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;
  const validKinds: PendingActionKind[] = [
    "decision",
    "signature",
    "info_request",
    "confirm_close",
    "review_quotes",
    "manual"
  ];
  if (typeof r.kind !== "string" || !validKinds.includes(r.kind)) return null;
  if (typeof r.text !== "string" || r.text.length === 0) return null;
  const options = Array.isArray(r.options)
    ? r.options
        .filter(
          (o: any) =>
            o &&
            typeof o === "object" &&
            typeof o.id === "string" &&
            typeof o.label === "string"
        )
        .slice(0, 5)
        .map((o: any) => ({
          id: o.id,
          label: o.label,
          style:
            typeof o.style === "string" &&
            ["primary", "secondary", "ghost", "danger"].includes(o.style)
              ? o.style
              : "secondary"
        }))
    : [];
  if (options.length === 0) return null;
  return { kind: r.kind, text: r.text, options };
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}\n\n[... ${input.length - max} more chars truncated]`;
}
