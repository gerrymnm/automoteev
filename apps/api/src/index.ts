import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config.js";
import { router } from "./routes.js";
import { webhooks } from "./webhooks.js";

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

app.use(webhooks);

// JSON for everything else.
app.use(express.json({ limit: "1mb" }));
app.use(router);

app.listen(env.PORT, () => {
  console.log(`Automoteev API listening on ${env.PORT}`);
});
