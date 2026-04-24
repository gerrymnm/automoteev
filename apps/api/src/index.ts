import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config.js";
import { router } from "./routes.js";

const app = express();

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(router);

app.listen(env.PORT, () => {
  console.log(`Automoteev API listening on ${env.PORT}`);
});
