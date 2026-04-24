import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().email().default("tasks@automoteev.com"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PRO_PRICE_ID: z.string().optional(),
  APP_URL: z.string().url().default("http://localhost:5173"),
  FIELD_ENCRYPTION_KEY: z.string().optional()
});

export const env = envSchema.parse(process.env);
