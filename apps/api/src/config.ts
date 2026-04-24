import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  APP_URL: z.string().url().default("http://localhost:5173"),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-5"),

  // Resend
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_DOMAIN: z.string().default("mail.automoteev.com"),
  RESEND_REPLY_TO_DOMAIN: z.string().default("mail.automoteev.com"),
  RESEND_INBOUND_WEBHOOK_SECRET: z.string().optional(),
  RESEND_EVENTS_WEBHOOK_SECRET: z.string().optional(),

  // Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_MONTHLY: z.string().optional(),
  STRIPE_PRICE_ANNUAL: z.string().optional(),

  // Google
  GOOGLE_MAPS_API_KEY: z.string().optional(),

  // EIA
  EIA_API_KEY: z.string().optional(),

  // Agent
  AUTONOMY_APPROVAL_THRESHOLD: z.coerce.number().int().positive().default(3),

  // Encryption
  PII_ENCRYPTION_KEY: z.string().optional(),
  FIELD_ENCRYPTION_KEY: z.string().optional(), // legacy alias, retained for existing records

  // Legal
  TOS_VERSION: z.string().default("2026-04-24"),
  PRIVACY_VERSION: z.string().default("2026-04-24"),
  AUTONOMY_CONSENT_VERSION: z.string().default("2026-04-24")
});

export const env = envSchema.parse(process.env);
