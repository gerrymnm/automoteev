import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config.js";
import { router } from "./routes.js";
import { webhooks } from "./webhooks.js";
import { mcpRouter } from "./mcp/server.js";
import { startDailyRecallsJob } from "./jobs/daily-recalls.js";
import { startDailyRenewalRemindersJob } from "./jobs/daily-renewal-reminders.js";
import { startDailyPlaidSyncJob } from "./jobs/daily-plaid-sync.js";

const app = express();

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));

// Webhooks MUST be mounted with a raw body parser (signature verification
// requires the exact bytes that were signed), BEFORE express.json() rewrites
// the body into an object.
app.use(
  "/webhooks/stripe",
  express.raw({ type: "application/json", limit: "1mb" })
);
app.use(
  "/webhooks/email/inbound",
  express.raw({ type: "*/*", limit: "10mb" }),
  // After signature verification, Resend webhook parses JSON body from buffer.
  (req, _res, next) => {
    try {
      if (Buffer.isBuffer(req.body)) {
        req.body = Buffer.concat([req.body]);
      }
    } catch {
      // ignore
    }
    next();
  }
);
app.use(
  "/webhooks/email/events",
  express.raw({ type: "*/*", limit: "1mb" })
);
app.use(
  "/webhooks/plaid",
  // Plaid sends JSON; keep the raw bytes so future JWT-based signature
  // verification can read what was signed. The handler in webhooks.ts
  // parses the JSON itself.
  express.raw({ type: "*/*", limit: "1mb" })
);

app.use(webhooks);

// JSON for everything else.
app.use(express.json({ limit: "1mb" }));

// MCP routes (well-known is public; /mcp endpoint authenticates via bearer token internally;
// /mcp/auth/token is mounted inside the regular auth gate via routes.ts).
app.use(mcpRouter);

app.use(router);

app.listen(env.PORT, () => {
  console.log(`Automoteev API listening on ${env.PORT}`);
  // Start the daily recall recheck cron once the server is accepting traffic.
  // First run is delayed 60s so health checks pass on cold boot.
  startDailyRecallsJob();
  // Daily renewal reminder cron — fires push notifications at 30/14/7/1/0
  // day thresholds before each renewable item's expiration. Offset 30s
  // after daily-recalls (so 90s after boot) to avoid event-loop contention.
  startDailyRenewalRemindersJob();
  // Daily Plaid sync — backstop in case webhooks are missed (or unavailable
  // in sandbox/dev). Offset 30s after daily-renewal-reminders (120s after
  // boot). Plaid /transactions/sync is incremental via cursor so re-running
  // costs nothing when there's nothing new.
  startDailyPlaidSyncJob();
});
