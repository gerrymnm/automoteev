# Automoteev

Automoteev is a standalone AI vehicle ownership agent for existing vehicle owners and lease holders. It is alert-driven, approval-first, and designed to be useful without daily use.

## Stack

- Frontend: Vite + React + TypeScript (deployed to Vercel)
- Backend: Node.js + TypeScript + Express (deployed to Railway)
- Database / Auth / Storage: Supabase
- Email (outbound + inbound): Resend
- Payments: Stripe
- VIN decode + recalls: NHTSA (vPIC + recallsByVehicle)
- Vendor discovery: Google Places API (Places v1 searchText)
- Gas prices: U.S. EIA

## Repo layout

```
apps/
  api/        Express API (backend)
  web/        Vite SPA (frontend)
supabase/
  schema.sql                                     # initial schema
  migrations/
    002_spec_alignment.sql                       # 17 spec-alignment changes
    003_perf_indexes_and_rls_init_plan.sql       # covering indexes + RLS initplan fix
```

## First-time setup

1. Install:

```bash
npm install
```

2. Env files:

```bash
cp .env.example apps/web/.env
cp .env.example apps/api/.env
```

Fill in the real values (see "Env vars" below).

3. Supabase:

- `supabase/schema.sql` was applied when the project was created.
- `supabase/migrations/002_spec_alignment.sql` and `003_perf_indexes_and_rls_init_plan.sql` have been applied to the `automoteev` Supabase project (project ID `euouyaarpowxpmbyzxmk`). Both are idempotent — re-running is safe.

4. Start locally:

```bash
npm run dev:api
npm run dev:web
```

API: `http://localhost:4000` — Web: `http://localhost:5173`.

## Env vars

See `.env.example` for the authoritative list. Highlights:

| Var | Where | Notes |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend | Supabase → Project Settings → API → service_role secret |
| `ANTHROPIC_API_KEY` | Backend | console.anthropic.com |
| `RESEND_API_KEY` | Backend | resend.com → API Keys |
| `RESEND_INBOUND_WEBHOOK_SECRET` | Backend | Generated when you create the inbound webhook in Resend |
| `RESEND_EVENTS_WEBHOOK_SECRET` | Backend | Generated when you create the events webhook in Resend |
| `STRIPE_SECRET_KEY` | Backend | Stripe dashboard |
| `STRIPE_WEBHOOK_SECRET` | Backend | Created when you add the webhook endpoint in Stripe |
| `STRIPE_PRICE_MONTHLY` | Backend | Price ID for the $4.99/mo plan |
| `STRIPE_PRICE_ANNUAL` | Backend | Price ID for the $49/yr plan |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Frontend | Stripe dashboard |
| `GOOGLE_MAPS_API_KEY` | Backend | Google Cloud → enable Places API (new) + Geocoding |
| `EIA_API_KEY` | Backend | api.eia.gov/register (free) |
| `PII_ENCRYPTION_KEY` | Backend | `openssl rand -base64 32` — do NOT lose this |
| `AUTONOMY_APPROVAL_THRESHOLD` | Backend | Default 3 — first N sends need approval |
| `TOS_VERSION` / `PRIVACY_VERSION` / `AUTONOMY_CONSENT_VERSION` | Backend | Bump to force re-acceptance |

## Product surface

- Auth uses Supabase email/password sessions.
- Onboarding collects VIN + mileage + email and creates: profile, vehicle, cost profile, loan/insurance records (if provided), maintenance schedule (`maintenance_items`), OBD reservation (if opted in), legal acceptances (`user_agreements`), and per-user agent email alias.
- Skipped fields are tracked in `onboarding_prompts` and nudged on a growing cadence (24h → 24h → 72h → 168h → 336h).
- Dashboard shows: overall status, monthly cost, value estimate, loan/lease, insurance, upcoming maintenance, open recalls, alerts, and recommended action.
- Commands ("get me a payoff", "find cheaper insurance") convert into typed tasks with approval metadata.
- Provider email outreach is gated by Pro subscription AND the autonomy rule (first 3 task-approved emails require explicit owner approval; after the threshold, the agent can send on subsequent tasks without re-approval). Unlock state is stored on `profiles.autonomy_unlocked_at`.
- Outbound email is sent from a per-user alias like `gerry.m@mail.automoteev.com`, signed as the owner. Phone is never disclosed in outbound email — only after the owner confirms a vendor.
- Inbound dealer replies land at the same alias and are parsed via Resend's inbound webhook into `task_emails(direction='inbound')`, linked to the originating thread via `In-Reply-To`.
- Recalls are pulled from NHTSA `recallsByVehicle` once make/model/year are decoded; new campaigns are deduped into the `recalls` table.
- Stripe subscriptions are tracked in a dedicated `subscriptions` table that also accepts Apple/Google IAP rows.

## Backend routes

All `/api/*` routes require a Supabase bearer token.

Profile & onboarding:
- `GET /api/profile`
- `PUT /api/profile`
- `POST /api/onboarding`
- `GET /api/onboarding/prompts`
- `POST /api/onboarding/prompts/:field/dismiss`
- `POST /api/onboarding/prompts/:field/complete`

Vehicles:
- `GET /api/vehicles`
- `GET /api/vehicles/:id/dashboard`
- `PUT /api/vehicles/:id/cost-profile`
- `POST /api/vehicles/:id/alerts/regenerate`
- `GET /api/alerts`

Tasks:
- `GET /api/tasks`
- `POST /api/tasks`
- `POST /api/tasks/command`
- `POST /api/tasks/:id/approval`
- `POST /api/tasks/:id/emails` (autonomy-gated)
- `GET /api/tasks/:id/history`

Providers:
- `GET /api/providers`
- `POST /api/providers`
- `POST /api/provider-search` (Google Places)

Recalls:
- `POST /api/recalls/check/:vehicleId`
- `GET /api/recalls/:vehicleId/list`

Maintenance:
- `GET /api/maintenance/:vehicleId`
- `POST /api/maintenance/:vehicleId/seed`
- `PUT /api/maintenance/items/:id`

Insurance / loan / PII:
- `PUT /api/insurance/:vehicleId`
- `PUT /api/loan-lease/:vehicleId`
- `GET /api/pii`
- `PUT /api/pii`
- `POST /api/agreements/accept`

Market data:
- `GET /api/market/gas?state=CA`
- `GET /api/market/maintenance-cost?item_type=oil_change_synthetic&state=CA`

Subscription / autonomy:
- `GET /api/autonomy/status`
- `GET /api/subscription/status`
- `POST /api/billing/create-checkout-session` (body: `{ plan: 'monthly' | 'annual' }`)

Sell / jobs:
- `POST /api/sell-vehicle/:vehicleId`
- `POST /api/jobs/:jobName/run` (placeholder trigger — production uses the scheduled job)

## Webhooks (public, no auth; signature-verified)

- `POST /webhooks/stripe` — raw body, Stripe signature header.
- `POST /webhooks/email/inbound` — Resend inbound webhook.
- `POST /webhooks/email/events` — Resend deliverability events.

## Supabase schema summary

Initial schema in `supabase/schema.sql`:
- `profiles`, `vehicles`, `vehicle_cost_profiles`, `loan_lease_accounts`, `insurance_accounts`, `vehicle_alerts`, `vehicle_tasks`, `task_emails`, `task_audit_logs`, `vehicle_events`, `documents`, `providers`

Added via `supabase/migrations/002_spec_alignment.sql`:
- `subscriptions`, `maintenance_items`, `recalls`, `user_pii`, `onboarding_prompts`, `email_events`, `user_agreements`, `obd_reservations`, `obd_readings`
- Autonomy / alias columns on `profiles`
- Amortization columns on `loan_lease_accounts`
- Coverage columns on `insurance_accounts`
- `direction`, `thread_id`, `in_reply_to`, `received_at` on `task_emails`
- VIN and document_type CHECK constraints
- Hot-path indexes

Added via `supabase/migrations/003_perf_indexes_and_rls_init_plan.sql`:
- Covering indexes for every foreign key (20 new indexes)
- RLS policies rewritten to `(select auth.uid())` so the subplan is evaluated once per query instead of per row

RLS is enabled on every table. Policies isolate rows by `auth.uid()`.

## Resend setup (outbound + inbound)

1. In Resend, add domain `mail.automoteev.com`.
2. Add the returned DNS records (SPF, DKIM, DMARC, MX) at your `automoteev.com` registrar (Vercel DNS).
3. Create an inbound webhook pointing at `https://<api-host>/webhooks/email/inbound` — copy the signing secret to `RESEND_INBOUND_WEBHOOK_SECRET`.
4. Create an events webhook pointing at `https://<api-host>/webhooks/email/events` — copy the signing secret to `RESEND_EVENTS_WEBHOOK_SECRET`.
5. Inbound mail to any `<alias>@mail.automoteev.com` will route to the webhook; the backend matches on `profiles.agent_email_local`.

## Stripe setup

1. Create product "Automoteev Pro".
2. Create two prices: `$4.99/month` and `$49/year`. Save the price IDs as `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_ANNUAL`.
3. Add a webhook: `https://<api-host>/webhooks/stripe` — subscribe to:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
4. Copy the signing secret to `STRIPE_WEBHOOK_SECRET`.

## Railway deploy

1. Create a Railway service from the GitHub repo.
2. Root directory: repo root.
3. Add all backend env vars from `.env.example`.
4. Railway uses `railway.toml`:
```
npm run start --workspace @automoteev/api
```
5. Add a daily scheduled job:
```
npm run jobs:run-once --workspace @automoteev/api
```

## Vercel deploy

1. Import the GitHub repo in Vercel.
2. Framework preset: Vite.
3. Build command: `npm run build --workspace @automoteev/web`.
4. Output directory: `apps/web/dist`.
5. Add frontend env vars (all prefixed `VITE_`) from `.env.example`.

## Security notes

- Per-user email aliases prevent cross-tenant data exposure in inbound routing.
- PII (phone, DL, street address, insurance policy number) is AES-256-GCM encrypted at rest via `PII_ENCRYPTION_KEY`. Losing the key is unrecoverable.
- Webhooks verify HMAC signatures before processing.
- RLS isolates every user-owned row.
- Phone is never disclosed in outbound email.
- Autonomy is revocable: bumping `AUTONOMY_CONSENT_VERSION` forces re-acceptance at next session.
