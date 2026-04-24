# Automoteev

Automoteev is a standalone AI vehicle ownership agent for existing vehicle owners and lease holders. It is alert-driven, approval-first, and designed to be useful without daily use.

## Stack

- Frontend: Vite, React, TypeScript
- Backend: Node.js, TypeScript, Express
- Database/Auth/Storage: Supabase
- Email: Resend
- Payments: Stripe
- Frontend deploy: Vercel
- Backend deploy: Railway

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create environment files:

```bash
cp .env.example apps/web/.env
cp .env.example apps/api/.env
```

3. In Supabase, run `supabase/schema.sql` in the SQL editor.

4. Start the apps:

```bash
npm run dev:api
npm run dev:web
```

The API runs on `http://localhost:4000`. The web app runs on `http://localhost:5173`.

## Product Surface

- Authentication uses Supabase email/password sessions.
- Onboarding creates a profile, vehicle, cost profile, and optional loan/insurance records.
- Dashboard shows one-glance status: monthly cost, estimated value placeholder, balance, insurance, service, recall, and recommended action.
- Commands such as “Find cheaper insurance” and “Get my payoff” become structured tasks.
- Tasks require explicit approval before external provider email outreach.
- Every important action is logged in `task_audit_logs`.
- Outbound task email is logged in `task_emails`.

## Backend Routes

All `/api/*` routes require a Supabase bearer token.

- `GET /api/profile`
- `PUT /api/profile`
- `POST /api/onboarding`
- `GET /api/vehicles`
- `GET /api/vehicles/:id/dashboard`
- `PUT /api/vehicles/:id/cost-profile`
- `POST /api/vehicles/:id/alerts/regenerate`
- `GET /api/alerts`
- `GET /api/tasks`
- `POST /api/tasks`
- `POST /api/tasks/command`
- `POST /api/tasks/:id/approval`
- `POST /api/tasks/:id/emails`
- `GET /api/tasks/:id/history`
- `GET /api/providers`
- `POST /api/providers`
- `POST /api/recalls/check/:vehicleId`
- `GET /api/maintenance/:vehicleId`
- `PUT /api/insurance/:vehicleId`
- `PUT /api/loan-lease/:vehicleId`
- `POST /api/sell-vehicle/:vehicleId`
- `POST /api/billing/create-checkout-session`
- `POST /api/jobs/:jobName/run`

## Supabase

Run `supabase/schema.sql`. It creates:

- `profiles`
- `vehicles`
- `vehicle_cost_profiles`
- `loan_lease_accounts`
- `insurance_accounts`
- `vehicle_alerts`
- `vehicle_tasks`
- `task_emails`
- `task_audit_logs`
- `vehicle_events`
- `documents`
- `providers`

RLS is enabled on every table. Policies isolate rows by `auth.uid()`.

## Resend

Set:

```bash
RESEND_API_KEY=re_...
RESEND_FROM=tasks@automoteev.com
```

Verify `automoteev.com` in Resend before production. The backend sends plain-text task emails and logs every send. Provider email outreach requires an approved task and a Pro profile. If `RESEND_API_KEY` is missing, email sends are skipped and logged as `skipped_no_resend_key` for local development.

## Stripe

Create:

- Product: Automoteev Pro
- Price: `$4.99/month`
- Env var: `STRIPE_PRO_PRICE_ID=price_...`

Free includes dashboard, recall checks, cost tracking, and basic alerts. Pro includes task execution, email outreach, quote requests, appointment requests, multi-vehicle support, and advanced alerts.

## Railway Deploy

1. Create a Railway service from the GitHub repo.
2. Add backend env vars from `.env.example`.
3. Use the root directory as the service root.
4. Railway uses `railway.toml`:

```bash
npm run start --workspace @automoteev/api
```

5. Add scheduled jobs in Railway:

- Daily recall checks: `npm run jobs:run-once --workspace @automoteev/api`
- Insurance renewal checks: placeholder route/job currently shares the same job runner
- Lease maturity checks: placeholder route/job currently shares the same job runner
- Maintenance due checks: `npm run jobs:run-once --workspace @automoteev/api`
- Weekly value refresh: placeholder until valuation provider integration

## Vercel Deploy

1. Import the GitHub repo in Vercel.
2. Set framework to Vite.
3. Build command: `npm run build --workspace @automoteev/web`
4. Output directory: `apps/web/dist`
5. Add frontend env vars:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_API_URL=https://your-railway-api.up.railway.app
VITE_STRIPE_PRO_PRICE_ID=...
```

## Security Notes

- The frontend never logs sensitive vehicle or account data.
- API routes verify Supabase sessions before database access.
- RLS policies isolate every user-owned table.
- External emails require task approval first.
- Sensitive account fields have encrypted-field helper placeholders in `apps/api/src/security/encryption.ts`.
- Use a strong `FIELD_ENCRYPTION_KEY` before storing lender or insurance account references.

## Current Provider Placeholders

- VIN decode is abstracted in `apps/api/src/services/vin.ts`.
- Recall lookup is abstracted in `apps/api/src/services/recalls.ts`.
- Provider search is abstracted in `apps/api/src/services/providers.ts`.
- Vehicle value and document/photo upload are represented as placeholders ready for provider/storage integration.
